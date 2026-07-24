/**
 * Fail-closed reading of the outbound flags for the WhatsApp official channel.
 *
 * ADR-WHATSAPP-OFFICIAL-WACRM D9/shadow rules: any missing or malformed flag
 * must resolve to the safest state (shadow mode, sending disabled, pilot
 * restriction on). Nothing here defaults "open" — an unset or garbled env
 * var must never accidentally enable a real send to a real WhatsApp number.
 */

export type OutboundMode = 'shadow' | 'live'
export type Provider = 'meta_cloud' | 'evolution'

export interface WhatsappFlags {
  mode: OutboundMode
  metaSendEnabled: boolean
  evolutionSendEnabled: boolean
  broadcastEnabled: boolean
  pilotMode: boolean
  allowlist: string[]
}

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>

const ALLOWLIST_PHONE_RE = /^[0-9]{10,15}$/

function normalize(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

/** True only when the raw value, trimmed and lowercased, is exactly `expected`. */
function isExactly(value: string | undefined, expected: string): boolean {
  return normalize(value) === expected
}

function readMode(env: EnvLike): OutboundMode {
  return isExactly(env.WHATSAPP_OUTBOUND_MODE, 'live') ? 'live' : 'shadow'
}

function readBooleanFlag(value: string | undefined): boolean {
  return isExactly(value, 'true')
}

/** Pilot mode is fail-closed the other direction: default ON restricts recipients. */
function readPilotMode(env: EnvLike): boolean {
  return !isExactly(env.WHATSAPP_PILOT_MODE, 'false')
}

function readAllowlist(env: EnvLike): string[] {
  const raw = env.WHATSAPP_ALLOWLIST ?? ''
  const result: string[] = []
  for (const item of raw.split(',')) {
    const digits = item.replace(/[+\s\-()]/g, '').trim()
    if (digits.length === 0) continue
    if (!ALLOWLIST_PHONE_RE.test(digits)) continue
    result.push(digits)
  }
  return result
}

/** Read all outbound flags from the environment, fail-closed on anything malformed. */
export function readWhatsappFlags(env: EnvLike = process.env): WhatsappFlags {
  return {
    mode: readMode(env),
    metaSendEnabled: readBooleanFlag(env.WHATSAPP_META_SEND_ENABLED),
    evolutionSendEnabled: readBooleanFlag(env.WHATSAPP_EVOLUTION_SEND_ENABLED),
    broadcastEnabled: readBooleanFlag(env.WHATSAPP_BROADCAST_ENABLED),
    pilotMode: readPilotMode(env),
    allowlist: readAllowlist(env),
  }
}

/**
 * A provider is allowed to actually send only when the global mode is
 * 'live' AND that provider's own trava is on. Shadow mode always wins
 * (returns false) regardless of the per-provider flag.
 */
export function isSendEnabledFor(provider: Provider, flags: WhatsappFlags): boolean {
  if (flags.mode !== 'live') return false
  if (provider === 'meta_cloud') return flags.metaSendEnabled
  return flags.evolutionSendEnabled
}
