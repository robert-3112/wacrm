import { describe, expect, it } from 'vitest'
import { mapMetaStatusToDb, shouldApplyStatusTransition } from './status'

// Mirrors public.whatsapp_status_rank exactly (documented in
// docs/WHATSAPP-OFFICIAL-ARCHITECTURE.md and the foundation migration).
const RANK: Record<string, number> = {
  pendente: 0,
  enviada: 1,
  entregue: 2,
  lida: 3,
  recebida: 3,
  falhou: -1,
}

describe('mapMetaStatusToDb', () => {
  it('maps Meta status values to the pt-BR db vocabulary', () => {
    expect(mapMetaStatusToDb('sent')).toBe('enviada')
    expect(mapMetaStatusToDb('delivered')).toBe('entregue')
    expect(mapMetaStatusToDb('read')).toBe('lida')
    expect(mapMetaStatusToDb('failed')).toBe('falhou')
  })

  it('returns null for statuses this schema does not track', () => {
    expect(mapMetaStatusToDb('deleted')).toBeNull()
    expect(mapMetaStatusToDb('warning')).toBeNull()
  })
})

describe('shouldApplyStatusTransition — out-of-order guard (ADR D7)', () => {
  it('applies a normal forward transition (enviada -> entregue)', () => {
    expect(
      shouldApplyStatusTransition('enviada', RANK.enviada, 'entregue', RANK.entregue),
    ).toBe(true)
  })

  it('applies enviada -> entregue -> lida in sequence', () => {
    expect(shouldApplyStatusTransition('entregue', RANK.entregue, 'lida', RANK.lida)).toBe(
      true,
    )
  })

  it('does NOT regress lida back to entregue when entregue arrives late', () => {
    // The exact scenario named in the mission spec: "lida chegando antes de
    // entregue não volta pra entregue" — lida is already recorded, a
    // late/out-of-order "delivered" event must not overwrite it.
    expect(
      shouldApplyStatusTransition('lida', RANK.lida, 'entregue', RANK.entregue),
    ).toBe(false)
  })

  it('does not regress entregue back to enviada', () => {
    expect(
      shouldApplyStatusTransition('entregue', RANK.entregue, 'enviada', RANK.enviada),
    ).toBe(false)
  })

  it('ignores a duplicate delivery of the same status (rank tie)', () => {
    expect(
      shouldApplyStatusTransition('entregue', RANK.entregue, 'entregue', RANK.entregue),
    ).toBe(false)
  })

  it('accepts falhou from pendente', () => {
    expect(shouldApplyStatusTransition('pendente', RANK.pendente, 'falhou', RANK.falhou)).toBe(
      true,
    )
  })

  it('accepts falhou from enviada (not yet delivered)', () => {
    expect(shouldApplyStatusTransition('enviada', RANK.enviada, 'falhou', RANK.falhou)).toBe(
      true,
    )
  })

  it('rejects falhou arriving after entregue (already confirmed delivered)', () => {
    expect(shouldApplyStatusTransition('entregue', RANK.entregue, 'falhou', RANK.falhou)).toBe(
      false,
    )
  })

  it('rejects falhou arriving after lida', () => {
    expect(shouldApplyStatusTransition('lida', RANK.lida, 'falhou', RANK.falhou)).toBe(false)
  })

  it('falhou is terminal — nothing overwrites it, including another falhou', () => {
    expect(shouldApplyStatusTransition('falhou', RANK.falhou, 'entregue', RANK.entregue)).toBe(
      false,
    )
    expect(shouldApplyStatusTransition('falhou', RANK.falhou, 'falhou', RANK.falhou)).toBe(
      false,
    )
  })
})
