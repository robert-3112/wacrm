/**
 * Phone normalization for the official channel.
 *
 * WRITTEN FOR THIS MISSION (not a WACRM port — WACRM's `phone-utils.ts`
 * targets E.164-with-plus and a trunk-prefix retry heuristic, which is a
 * different problem). SUNT's rule (already used by `sophia_criar_lead_inbound`
 * for the Evolution channel, and restated in ADR-WHATSAPP-OFFICIAL-WACRM D2)
 * is a plain digits-only pattern: `^[0-9]{10,15}$`, no `+`, no reinventing
 * E.164 with symbols. The `wa_id`/`from` Meta sends in the webhook payload
 * already comes in exactly this format — normalization here is defensive
 * (strip anything Meta doesn't already strip) rather than load-bearing.
 */

const LEAD_PHONE_RE = /^[0-9]{10,15}$/

/** Strip everything but digits — defensive; Meta's wa_id is already digits-only. */
export function normalizePhoneDigits(value: string): string {
  return (value ?? '').replace(/\D/g, '')
}

/** True when `phone` matches the SUNT `leads.whatsapp` shape (`^[0-9]{10,15}$`). */
export function isValidLeadPhone(phone: string): boolean {
  return LEAD_PHONE_RE.test(phone)
}
