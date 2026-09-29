import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

const mocks = vi.hoisted(() => ({ requireGestaoSession: vi.fn() }))
vi.mock('@/lib/whatsapp-oficial/api-auth', async () => ({
  ...await vi.importActual<typeof import('@/lib/whatsapp-oficial/api-auth')>('@/lib/whatsapp-oficial/api-auth'),
  requireGestaoSession: mocks.requireGestaoSession,
}))

import { UnauthorizedError } from '@/lib/whatsapp-oficial/api-auth'
import { GET, POST } from './route'

const OUT = '11111111-1111-4111-8111-111111111111'
const IN = '22222222-2222-4222-8222-222222222222'
const proof = {
  outbound_conversation_id: OUT,
  inbound_conversation_id: IN,
  outbound_message_id: '33333333-3333-4333-8333-333333333333',
  inbound_message_id: '44444444-4444-4444-8444-444444444444',
  status_webhook_event_id: '55555555-5555-4555-8555-555555555555',
  inbound_webhook_event_id: '66666666-6666-4666-8666-666666666666',
}
const candidate = { ok: true, ...proof, status_at: '2026-09-28T00:00:00Z', inbound_at: '2026-09-28T00:01:00Z' }
const params = { params: Promise.resolve({ id: OUT }) }
const getRequest = () => new Request(`http://localhost/api/whatsapp-oficial/conversations/${OUT}/pair`)
const postRequest = (body: unknown) => new Request(getRequest().url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

describe('verified conversation pair route', () => {
  const rpc = vi.fn()
  beforeEach(() => {
    delete process.env.WHATSAPP_PAIR_LINK_ENABLED
    __resetRateLimitForTests()
    mocks.requireGestaoSession.mockReset().mockResolvedValue({ userId: 'manager', supabaseUser: { rpc } })
    rpc.mockReset()
  })
  afterEach(() => { delete process.env.WHATSAPP_PAIR_LINK_ENABLED })

  it('rejects invalid IDs before reading private evidence', async () => {
    const response = await GET(getRequest(), { params: Promise.resolve({ id: 'bad' }) })
    expect(response.status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('requires an authenticated management session', async () => {
    mocks.requireGestaoSession.mockRejectedValue(new UnauthorizedError())
    expect((await GET(getRequest(), params)).status).toBe(401)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('only exposes six IDs and evidence times from the user-session preview RPC', async () => {
    rpc.mockResolvedValue({ data: candidate, error: null })
    const response = await GET(getRequest(), params)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ candidate, linkEnabled: false })
    expect(rpc).toHaveBeenCalledWith('whatsapp_oficial_prever_par', { p_outbound_conversation_id: OUT })
  })

  it('reports when a future deployment explicitly enables manager confirmation', async () => {
    process.env.WHATSAPP_PAIR_LINK_ENABLED = 'true'
    rpc.mockResolvedValue({ data: candidate, error: null })
    const response = await GET(getRequest(), params)
    expect((await response.json()).linkEnabled).toBe(true)
  })

  it('fails closed on ambiguous evidence and a broker denied by SQL', async () => {
    rpc.mockResolvedValueOnce({ data: { ok: false, reason: 'ambiguous' }, error: null })
      .mockResolvedValueOnce({ data: null, error: { code: '42501' } })
    expect((await GET(getRequest(), params)).status).toBe(409)
    expect((await GET(getRequest(), params)).status).toBe(403)
  })

  it('refuses malformed or mismatched proof without linking', async () => {
    process.env.WHATSAPP_PAIR_LINK_ENABLED = 'true'
    rpc.mockResolvedValue({ data: candidate, error: null })
    expect((await POST(postRequest({ ...proof, inbound_message_id: OUT }), params)).status).toBe(409)
    expect((await POST(postRequest({ ...proof, inbound_message_id: 'bad' }), params)).status).toBe(400)
    expect(rpc).not.toHaveBeenCalledWith('whatsapp_oficial_vincular_conversas', expect.anything())
  })

  it('links only the freshly revalidated preview via the authenticated RPC', async () => {
    process.env.WHATSAPP_PAIR_LINK_ENABLED = 'true'
    rpc.mockResolvedValueOnce({ data: candidate, error: null })
      .mockResolvedValueOnce({ data: '77777777-7777-4777-8777-777777777777', error: null })
    const response = await POST(postRequest(proof), params)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, pairId: '77777777-7777-4777-8777-777777777777' })
    expect(rpc).toHaveBeenNthCalledWith(2, 'whatsapp_oficial_vincular_conversas', {
      p_outbound_conversation_id: proof.outbound_conversation_id,
      p_inbound_conversation_id: proof.inbound_conversation_id,
      p_outbound_message_id: proof.outbound_message_id,
      p_inbound_message_id: proof.inbound_message_id,
      p_status_webhook_event_id: proof.status_webhook_event_id,
      p_inbound_webhook_event_id: proof.inbound_webhook_event_id,
    })
  })

  it('will not link while SQL reports active outbox', async () => {
    process.env.WHATSAPP_PAIR_LINK_ENABLED = 'true'
    rpc.mockResolvedValue({ data: { ok: false, reason: 'active_outbox' }, error: null })
    expect((await POST(postRequest(proof), params)).status).toBe(409)
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('maps a late SQL outbox race to a conflict', async () => {
    process.env.WHATSAPP_PAIR_LINK_ENABLED = 'true'
    rpc.mockResolvedValueOnce({ data: candidate, error: null })
      .mockResolvedValueOnce({ data: null, error: { code: '23514', message: 'active outbox prevents conversation pair' } })
    const response = await POST(postRequest(proof), params)
    expect(response.status).toBe(409)
    expect(JSON.stringify(await response.json())).not.toContain('active outbox prevents')
  })

  it('blocks confirmation by default even with a valid manager proof', async () => {
    const response = await POST(postRequest(proof), params)
    expect(response.status).toBe(403)
    expect(JSON.stringify(await response.json())).toContain('indisponível')
    expect(rpc).not.toHaveBeenCalled()
  })
})
