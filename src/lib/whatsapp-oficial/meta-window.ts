/**
 * Meta's 24-hour customer service window (WhatsApp Cloud API rule, not a
 * SUNT invention): a business may only send free-form messages within 24h
 * of the customer's last inbound message. Outside that window, Meta's API
 * itself rejects free-form sends and only an approved template message may
 * go out (error 131047 if you try anyway — see PERMANENT_META_CODES in
 * `./outbox.ts`).
 *
 * This module lets the worker enforce the same rule LOCALLY, before ever
 * calling Meta, so a doomed free-form send never burns a live API call or
 * an outbox retry attempt.
 */

export const META_FREE_FORM_WINDOW_MS = 24 * 60 * 60 * 1000

// Small tolerance for clock skew between this process and whatever wrote
// `ultimoInboundEm` — an inbound timestamped a few seconds in the future
// (e.g. due to minor clock drift) should not be treated as "no inbound".
const FUTURE_TOLERANCE_MS = 5_000

/**
 * True when `now` is still inside the 24h free-form window opened by the
 * lead's last inbound message. False (and thus "template required") when
 * there was never an inbound, the timestamp is unparsable, the inbound is
 * implausibly far in the future, or 24h have already elapsed.
 */
export function isInsideFreeFormWindow(
  ultimoInboundEm: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!ultimoInboundEm) return false

  const inboundMs = Date.parse(ultimoInboundEm)
  if (Number.isNaN(inboundMs)) return false

  const nowMs = now.getTime()
  if (inboundMs - nowMs > FUTURE_TOLERANCE_MS) return false

  // Clamp trivial clock-skew futures (within tolerance) to "just now"
  // rather than letting a negative elapsed value slip through.
  const elapsed = Math.max(0, nowMs - inboundMs)
  return elapsed < META_FREE_FORM_WINDOW_MS
}
