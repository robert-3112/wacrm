/**
 * Status-transition rules for `whatsapp_messages.status` (ADR-WHATSAPP-OFFICIAL-WACRM
 * D7 — "eventos de status fora de ordem não regridem o status").
 *
 * WRITTEN FROM SCRATCH for this mission. The WACRM upstream *does* have an
 * equivalent idea (`RECIPIENT_STATUS_LADDER` / `isValidStatusTransition` in
 * `src/app/api/whatsapp/webhook/route.ts`, applied only to
 * `broadcast_recipients` — the harvest matrix, area 3, flagged that the
 * mirror onto `messages` in the same file does NOT apply the guard, a real
 * gap in the upstream code), but it compares against an in-code ladder
 * array, not a database function. The SUNT schema instead ships
 * `public.whatsapp_status_rank(text)` as the single source of truth for
 * rank (`pendente=0, enviada=1, entregue=2, lida=3, recebida=3, falhou=-1`
 * — see `supabase/migrations/20260723190000_whatsapp_oficial_foundation.sql`).
 * The webhook route calls that SQL function (via `supabase.rpc(...)`) to
 * fetch the current and incoming ranks *before* deciding whether to
 * UPDATE — this module only holds the pure decision logic once both ranks
 * are known, so it's unit-testable without a database.
 */

/**
 * `entregue`'s rank per `public.whatsapp_status_rank('entregue')`. Only
 * used for the "failed is only valid before delivery" rule below — kept
 * as a named constant (not re-derived) so the intent reads clearly. Must
 * stay in sync with the SQL function; both live in the same migration
 * family and are covered by the same review.
 */
export const ENTREGUE_RANK = 2

export type MetaMessageStatus = 'sent' | 'delivered' | 'read' | 'failed' | string

export type WhatsappMessageStatus = 'enviada' | 'entregue' | 'lida' | 'falhou'

/**
 * Map Meta's webhook status vocabulary to the DB's (Portuguese)
 * `whatsapp_messages.status` vocabulary. Returns `null` for values Meta
 * may send that this schema doesn't track as a message status (e.g.
 * `deleted`) — callers should log and skip those.
 */
export function mapMetaStatusToDb(metaStatus: MetaMessageStatus): WhatsappMessageStatus | null {
  switch (metaStatus) {
    case 'sent':
      return 'enviada'
    case 'delivered':
      return 'entregue'
    case 'read':
      return 'lida'
    case 'failed':
      return 'falhou'
    default:
      return null
  }
}

/**
 * Decide whether an incoming status event should overwrite
 * `whatsapp_messages.status`, given the CURRENT and INCOMING db-vocabulary
 * status plus their ranks (fetched from `public.whatsapp_status_rank`).
 *
 * Rules (mirrors the WACRM reference design, adapted to this schema's
 * rank function):
 *   - `falhou` is terminal — once a message is `falhou`, nothing can
 *     change it (guards against a stale retry of an earlier status
 *     arriving after a failure was already recorded).
 *   - An incoming `falhou` is only accepted while the message hasn't
 *     been confirmed delivered yet (`currentRank < ENTREGUE_RANK`) — a
 *     `failed` arriving after `entregue`/`lida` is a late/out-of-order
 *     duplicate or a spoof attempt, not a real terminal failure.
 *   - Otherwise, only forward moves on the rank ladder are applied
 *     (`incomingRank > currentRank`) — this is the literal "não regride"
 *     requirement: `lida` (3) already recorded, `entregue` (2) arriving
 *     late must NOT overwrite it back to `entregue`.
 */
export function shouldApplyStatusTransition(
  currentStatus: string,
  currentRank: number,
  incomingStatus: WhatsappMessageStatus,
  incomingRank: number,
): boolean {
  if (currentStatus === 'falhou') return false
  if (incomingStatus === 'falhou') return currentRank < ENTREGUE_RANK
  return incomingRank > currentRank
}
