/**
 * Retryable-vs-permanent error classification and backoff scheduling for
 * `whatsapp_outbox` (ADR-WHATSAPP-OFFICIAL-WACRM D8).
 *
 * WRITTEN FROM SCRATCH. Confirmed by the harvest matrix (area 1 & 2) that
 * the WACRM upstream has nothing equivalent: `throwMetaError()` in
 * `src/lib/whatsapp/meta-api.ts` only extracts `error.message` from Meta's
 * response and throws a generic `Error` — no `code`/`error_subcode`
 * survive, so there is nothing to classify against. This module (and the
 * `MetaApiError` thrown by `./meta-api.ts`, which DOES preserve
 * `code`/`error_subcode`/`httpStatus`) is the fix.
 *
 * Meta error code references used to seed the permanent/retryable sets:
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 *   https://developers.facebook.com/docs/graph-api/guides/error-handling
 * The lists are intentionally NOT exhaustive — anything not recognized
 * falls back to a documented default (see `classifyMetaError`).
 */

export interface MetaApiErrorInfo {
  /** HTTP status Meta responded with, when known. */
  httpStatus?: number
  /** Meta's `error.code`. */
  code?: number
  /** Meta's `error.error_subcode`, when present. */
  errorSubcode?: number
  message?: string
}

export type OutboxErrorClass = 'retryable' | 'permanent'

export interface ClassifyResult {
  errorClass: OutboxErrorClass
  /** Short machine-readable reason, stored in `last_error_code` when Meta gave no `code`. */
  reason: string
}

/**
 * Meta error codes that mean "this will never succeed by retrying" —
 * invalid template/parameters, permission/auth problems that need human
 * intervention, or the recipient itself being unreachable. These go
 * straight to `dead_letter_at`, skipping the retry budget entirely (ADR
 * D8: "erros permanentes ... vão direto para dead_letter_at sem consumir
 * tentativas de retry").
 */
const PERMANENT_META_CODES = new Set<number>([
  100, // Invalid parameter
  10, // Permission denied (app not granted the capability)
  190, // Access token invalid/expired — needs a human to reconnect the channel
  200, // Permission error
  131005, // Access denied (recipient blocked the business, etc.)
  131008, // Required parameter is missing
  131009, // Parameter value is not valid
  131021, // Recipient cannot be sender (self-send)
  131026, // Message undeliverable (invalid/unreachable number)
  131047, // Re-engagement message outside the 24h window without an approved template
  131051, // Unsupported message type
  132000, // Template does not exist / param count mismatch
  132001, // Template does not exist
  132005, // Template hydration failed (parameter format mismatch)
  132007, // Template is paused
  132012, // Template parameter format mismatch
  133010, // WABA / phone number not registered
])

/**
 * Meta error codes that mean "the same call is likely to succeed later" —
 * rate limiting and transient service problems. These schedule
 * `next_retry_at` with backoff instead of consuming a permanent failure.
 */
const RETRYABLE_META_CODES = new Set<number>([
  1, // Unknown/transient API error — Meta's own docs suggest retrying
  2, // Service temporarily unavailable
  4, // App-level rate limit hit
  80007, // WABA-level rate limit hit
  130429, // Messaging rate limit hit
  131048, // Spam-rate limit — temporary throttle
  131056, // Too many concurrent pair sends — temporary
])

/**
 * Classify a Meta Cloud API error as retryable or permanent.
 *
 * Priority: an explicit Meta `code` we recognize wins; otherwise fall
 * back to the HTTP status class (429/5xx → retryable, other 4xx →
 * permanent); an error with neither a recognized code nor a status (e.g.
 * a raw `fetch` network failure, DNS error, timeout) defaults to
 * retryable — infra hiccups are exactly the case retry exists for, and
 * treating unknown shapes as permanent would silently drop messages on
 * the first blip.
 */
export function classifyMetaError(err: MetaApiErrorInfo): ClassifyResult {
  const { httpStatus, code } = err

  if (code !== undefined) {
    if (PERMANENT_META_CODES.has(code)) {
      return { errorClass: 'permanent', reason: `meta_code_${code}` }
    }
    if (RETRYABLE_META_CODES.has(code)) {
      return { errorClass: 'retryable', reason: `meta_code_${code}` }
    }
  }

  if (httpStatus === 429) {
    return { errorClass: 'retryable', reason: 'http_429' }
  }
  if (httpStatus !== undefined && httpStatus >= 500) {
    return { errorClass: 'retryable', reason: `http_${httpStatus}` }
  }
  if (httpStatus !== undefined && httpStatus >= 400) {
    return { errorClass: 'permanent', reason: `http_${httpStatus}` }
  }

  return { errorClass: 'retryable', reason: 'unknown_error_default_retryable' }
}

const BASE_BACKOFF_MS = 30_000 // 30s
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000 // 6h cap
const MAX_BACKOFF_EXPONENT = 10 // 30s * 2^10 already exceeds the cap

/**
 * Exponential backoff with full jitter (avoids a thundering herd of
 * retries all landing on the same tick after a Meta-wide blip).
 * `attempts` is the number of PRIOR attempts (0 on the first failure).
 */
export function computeNextRetryAt(attempts: number, now: Date = new Date()): Date {
  const exponent = Math.min(Math.max(attempts, 0), MAX_BACKOFF_EXPONENT)
  const delay = Math.min(BASE_BACKOFF_MS * 2 ** exponent, MAX_BACKOFF_MS)
  const jittered = Math.floor(delay * (0.5 + Math.random() * 0.5))
  return new Date(now.getTime() + jittered)
}

export interface OutboxRow {
  id: string
  attempts: number
  max_attempts: number
}

// Minimal shape of what we need from a Supabase client — kept loose so
// tests can pass a plain mock without importing @supabase/supabase-js types.
export interface SupabaseAdminLike {
  from: (table: string) => {
    update: (values: Record<string, unknown>) => {
      eq: (column: string, value: string) => PromiseLike<{ error: unknown }>
    }
  }
}

export interface ApplyOutboxFailureResult {
  errorClass: OutboxErrorClass
  deadLettered: boolean
}

/**
 * Apply a send failure to a `whatsapp_outbox` row: classify the error,
 * then either dead-letter it (permanent error OR retry budget exhausted)
 * or schedule the next retry with backoff.
 */
export async function applyOutboxFailure(
  supabase: SupabaseAdminLike,
  row: OutboxRow,
  error: MetaApiErrorInfo,
  now: Date = new Date(),
): Promise<ApplyOutboxFailureResult> {
  const { errorClass, reason } = classifyMetaError(error)
  const nextAttempts = row.attempts + 1
  const budgetExhausted = nextAttempts >= row.max_attempts
  const deadLetter = errorClass === 'permanent' || budgetExhausted

  const update: Record<string, unknown> = {
    attempts: nextAttempts,
    last_error_code: error.code !== undefined ? String(error.code) : reason,
    last_error_message: error.message ?? reason,
    updated_at: now.toISOString(),
  }

  if (deadLetter) {
    update.status = 'morto'
    update.dead_letter_at = now.toISOString()
  } else {
    update.status = 'falhou'
    update.next_retry_at = computeNextRetryAt(row.attempts, now).toISOString()
  }

  const { error: dbError } = await supabase
    .from('whatsapp_outbox')
    .update(update)
    .eq('id', row.id)
  if (dbError) throw dbError

  return { errorClass, deadLettered: deadLetter }
}

/** Mark an outbox row as sent successfully. */
export async function applyOutboxSuccess(
  supabase: SupabaseAdminLike,
  row: Pick<OutboxRow, 'id'>,
  now: Date = new Date(),
): Promise<void> {
  const { error } = await supabase
    .from('whatsapp_outbox')
    .update({ status: 'enviado', updated_at: now.toISOString() })
    .eq('id', row.id)
  if (error) throw error
}
