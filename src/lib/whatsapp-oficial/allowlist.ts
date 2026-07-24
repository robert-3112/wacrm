/**
 * Pilot allowlist gate for outbound sends (ADR-WHATSAPP-OFFICIAL-WACRM D9
 * pilot restriction). While `pilotMode` is on, only numbers explicitly
 * listed in `WHATSAPP_ALLOWLIST` may receive a real send — this is the
 * blast-radius control for the shadow-to-live rollout.
 *
 * Reuses `normalizePhoneDigits` from `./phone.ts` (strip everything but
 * digits) so `+55 47 99048-0036` and `5547990480036` compare equal — the
 * same normalization `readWhatsappFlags` already applies when building
 * `flags.allowlist`.
 */

import { normalizePhoneDigits } from './phone'
import type { WhatsappFlags } from './env-flags'

/**
 * True when `phone` is allowed to receive an outbound send under the
 * current pilot restriction. Outside pilot mode the allowlist does not
 * apply (returns true unconditionally). Inside pilot mode, a null/empty/
 * invalid phone is always blocked.
 */
export function isAllowlisted(phone: string | null | undefined, flags: WhatsappFlags): boolean {
  if (!flags.pilotMode) return true
  if (!phone) return false
  const digits = normalizePhoneDigits(phone)
  if (digits.length === 0) return false
  return flags.allowlist.includes(digits)
}
