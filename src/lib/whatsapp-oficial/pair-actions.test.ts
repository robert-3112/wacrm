import { afterEach, describe, expect, it, vi } from 'vitest'
import { confirmConversationPair, previewConversationPair } from './pair-actions'
import type { PairCandidate } from './pair-actions'

const OUT = '11111111-1111-4111-8111-111111111111'
const candidate: PairCandidate = {
  ok: true,
  outbound_conversation_id: OUT,
  inbound_conversation_id: '22222222-2222-4222-8222-222222222222',
  outbound_message_id: '33333333-3333-4333-8333-333333333333',
  inbound_message_id: '44444444-4444-4444-8444-444444444444',
  status_webhook_event_id: '55555555-5555-4555-8555-555555555555',
  inbound_webhook_event_id: '66666666-6666-4666-8666-666666666666',
  status_at: '2026-09-28T00:00:00Z',
  inbound_at: '2026-09-28T00:01:00Z',
}

describe('pair actions', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('loads only the selected conversation preview without caching', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ candidate, linkEnabled: false }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    expect(await previewConversationPair(OUT)).toEqual({ ok: true, candidate, linkEnabled: false })
    expect(fetch).toHaveBeenCalledWith(`/api/whatsapp-oficial/conversations/${OUT}/pair`, { cache: 'no-store' })
  })

  it('returns an error on a failed or malformed preview', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Ambíguo' }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ candidate: { ok: true } }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    expect(await previewConversationPair(OUT)).toEqual({ ok: false, error: 'Ambíguo' })
    expect((await previewConversationPair(OUT)).ok).toBe(false)
  })

  it('submits precisely the six evidence IDs for explicit confirmation', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, pairId: 'pair-id' }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    expect(await confirmConversationPair(candidate)).toEqual({ ok: true, pairId: 'pair-id' })
    const [, options] = fetch.mock.calls[0]
    expect(options.method).toBe('POST')
    expect(JSON.parse(options.body)).toEqual({
      outbound_conversation_id: candidate.outbound_conversation_id,
      inbound_conversation_id: candidate.inbound_conversation_id,
      outbound_message_id: candidate.outbound_message_id,
      inbound_message_id: candidate.inbound_message_id,
      status_webhook_event_id: candidate.status_webhook_event_id,
      inbound_webhook_event_id: candidate.inbound_webhook_event_id,
    })
  })

  it('keeps link failure visible to the operator', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Aguarde a fila' }), { status: 409 })))
    expect(await confirmConversationPair(candidate)).toEqual({ ok: false, error: 'Aguarde a fila' })
  })
})
