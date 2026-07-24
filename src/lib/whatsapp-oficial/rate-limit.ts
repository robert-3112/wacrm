/**
 * Rate limiting for the official-channel routes.
 *
 * ADAPTED from `src/lib/rate-limit.ts` (WACRM original — harvest matrix
 * area 2, classified "Adaptar": the fixed-window in-memory counter itself
 * is generic and reusable as-is; only the per-route budgets are new). We
 * re-export the existing generic primitives instead of duplicating them —
 * they have no dependency on any WACRM table/account model — and only add
 * the budgets this mission's new routes need.
 *
 * Not swapped for Redis in this phase: the SUNT VPS (Coolify) runs a
 * single instance today, matching the same trade-off the harvest matrix
 * documented for the original module. Redis is already in the Coolify
 * stack (`n8n-with-postgresql`/`redis`) if/when a multi-instance deploy
 * needs it — the call sites below would not need to change, only
 * `checkRateLimit`'s implementation.
 */

export { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'

export const WHATSAPP_OFICIAL_RATE_LIMITS = {
  /**
   * Inbound webhook POSTs, keyed by source IP. This is NOT meant to
   * throttle legitimate Meta traffic (Meta batches multiple entries per
   * delivery, and legitimate volume can burst) — it's a broad guard
   * against a non-Meta caller hammering the endpoint (e.g. someone who
   * found the URL and is probing it with garbage bodies that fail
   * signature verification). 300/min comfortably covers real Meta
   * delivery patterns.
   */
  webhookInbound: { limit: 300, windowMs: 60_000 },
  /**
   * Media relay (`/api/whatsapp-oficial/media/[mediaId]`), keyed by the
   * authenticated user id. Mirrors the spirit of the WACRM `send` budget
   * (60/min) — comfortable for an agent scrolling a media-heavy thread,
   * bounded against a runaway script.
   */
  mediaRelay: { limit: 60, windowMs: 60_000 },
  /**
   * Outbound message send (`/api/whatsapp-oficial/messages/send`), keyed by
   * user id. Fase 6 only enqueues into `whatsapp_outbox` (no real Meta call
   * yet — see the outbox worker TODO on that route), but the budget is set
   * as if it did: same 60/min as the WACRM `send` bucket, comfortable for a
   * human typing replies, bounded against a runaway script.
   */
  messageSend: { limit: 60, windowMs: 60_000 },
  /**
   * Lower-frequency inbox write actions (internal notes, mark-as-read,
   * open/close conversation, handoff, opt-out), keyed by user id. These are
   * click-driven, not typed, so a much lower budget than `messageSend`
   * still comfortably covers legitimate use while bounding a stuck retry
   * loop or a compromised session.
   */
  inboxWriteAction: { limit: 30, windowMs: 60_000 },
} as const
