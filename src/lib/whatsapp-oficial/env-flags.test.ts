/**
 * Coverage for the fail-closed env flag reader — every case here is a case
 * where getting the default wrong would mean a real message goes out when
 * it shouldn't.
 */

import { describe, it, expect } from 'vitest'
import { readWhatsappFlags, isSendEnabledFor } from './env-flags'

describe('readWhatsappFlags', () => {
  it('defaults everything to the safe state when nothing is set', () => {
    const flags = readWhatsappFlags({})
    expect(flags.mode).toBe('shadow')
    expect(flags.metaSendEnabled).toBe(false)
    expect(flags.evolutionSendEnabled).toBe(false)
    expect(flags.broadcastEnabled).toBe(false)
    expect(flags.pilotMode).toBe(true)
    expect(flags.allowlist).toEqual([])
  })

  it('turns on live mode only for the exact string "live" (trim/lowercase tolerant)', () => {
    expect(readWhatsappFlags({ WHATSAPP_OUTBOUND_MODE: 'live' }).mode).toBe('live')
    expect(readWhatsappFlags({ WHATSAPP_OUTBOUND_MODE: ' Live ' }).mode).toBe('live')
    expect(readWhatsappFlags({ WHATSAPP_OUTBOUND_MODE: 'LIVE' }).mode).toBe('live')
  })

  it('rejects near-miss values for mode', () => {
    expect(readWhatsappFlags({ WHATSAPP_OUTBOUND_MODE: 'liv' }).mode).toBe('shadow')
    expect(readWhatsappFlags({ WHATSAPP_OUTBOUND_MODE: 'true' }).mode).toBe('shadow')
    expect(readWhatsappFlags({ WHATSAPP_OUTBOUND_MODE: '1' }).mode).toBe('shadow')
    expect(readWhatsappFlags({ WHATSAPP_OUTBOUND_MODE: '' }).mode).toBe('shadow')
  })

  it('reads each send trava independently, exact "true" only', () => {
    expect(readWhatsappFlags({ WHATSAPP_META_SEND_ENABLED: 'true' }).metaSendEnabled).toBe(true)
    expect(readWhatsappFlags({ WHATSAPP_META_SEND_ENABLED: 'TRUE' }).metaSendEnabled).toBe(true)
    expect(readWhatsappFlags({ WHATSAPP_META_SEND_ENABLED: 'yes' }).metaSendEnabled).toBe(false)
    expect(
      readWhatsappFlags({ WHATSAPP_EVOLUTION_SEND_ENABLED: 'true' }).evolutionSendEnabled,
    ).toBe(true)
    expect(
      readWhatsappFlags({ WHATSAPP_EVOLUTION_SEND_ENABLED: 'false' }).evolutionSendEnabled,
    ).toBe(false)
    expect(readWhatsappFlags({ WHATSAPP_BROADCAST_ENABLED: 'true' }).broadcastEnabled).toBe(true)
    expect(readWhatsappFlags({ WHATSAPP_BROADCAST_ENABLED: '' }).broadcastEnabled).toBe(false)
  })

  it('pilot mode only turns off with exact "false"', () => {
    expect(readWhatsappFlags({ WHATSAPP_PILOT_MODE: 'false' }).pilotMode).toBe(false)
    expect(readWhatsappFlags({ WHATSAPP_PILOT_MODE: 'FALSE' }).pilotMode).toBe(false)
    expect(readWhatsappFlags({ WHATSAPP_PILOT_MODE: 'true' }).pilotMode).toBe(true)
    expect(readWhatsappFlags({ WHATSAPP_PILOT_MODE: 'no' }).pilotMode).toBe(true)
    expect(readWhatsappFlags({}).pilotMode).toBe(true)
  })

  it('parses the allowlist CSV, normalizing and discarding invalid entries', () => {
    const flags = readWhatsappFlags({
      WHATSAPP_ALLOWLIST: '+55 47 99048-0036, 5547999998888,invalid, , 123',
    })
    expect(flags.allowlist).toEqual(['5547990480036', '5547999998888'])
  })
})

describe('isSendEnabledFor', () => {
  it('requires live mode AND the provider trava', () => {
    const liveMetaOnly = readWhatsappFlags({
      WHATSAPP_OUTBOUND_MODE: 'live',
      WHATSAPP_META_SEND_ENABLED: 'true',
    })
    expect(isSendEnabledFor('meta_cloud', liveMetaOnly)).toBe(true)
    expect(isSendEnabledFor('evolution', liveMetaOnly)).toBe(false)

    const shadowButFlagged = readWhatsappFlags({
      WHATSAPP_META_SEND_ENABLED: 'true',
      WHATSAPP_EVOLUTION_SEND_ENABLED: 'true',
    })
    expect(isSendEnabledFor('meta_cloud', shadowButFlagged)).toBe(false)
    expect(isSendEnabledFor('evolution', shadowButFlagged)).toBe(false)

    const liveNoFlags = readWhatsappFlags({ WHATSAPP_OUTBOUND_MODE: 'live' })
    expect(isSendEnabledFor('meta_cloud', liveNoFlags)).toBe(false)
    expect(isSendEnabledFor('evolution', liveNoFlags)).toBe(false)
  })
})
