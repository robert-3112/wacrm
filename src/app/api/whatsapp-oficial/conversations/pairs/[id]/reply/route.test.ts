import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

const mocks = vi.hoisted(() => ({ session: vi.fn(), conversation: vi.fn(), window: vi.fn() }))
vi.mock('@/lib/whatsapp-oficial/api-auth', async () => ({
  ...await vi.importActual<typeof import('@/lib/whatsapp-oficial/api-auth')>('@/lib/whatsapp-oficial/api-auth'),
  requireGestaoSession: mocks.session,
  requireConversationAccess: mocks.conversation,
}))
vi.mock('@/lib/whatsapp-oficial/conversation-window', () => ({ readConversationWindow: mocks.window }))

import { GET, POST } from './route'
import { NotFoundError } from '@/lib/whatsapp-oficial/api-auth'

const PAIR = '11111111-1111-4111-8111-111111111111'
const OUT = '22222222-2222-4222-8222-222222222222'
const IN = '33333333-3333-4333-8333-333333333333'
const REQUEST = '44444444-4444-4444-8444-444444444444'
const MESSAGE = '55555555-5555-4555-8555-555555555555'
const pair = { id: PAIR, tenant_id: 'sunt', outbound_conversation_id: OUT, inbound_conversation_id: IN }
const params = { params: Promise.resolve({ id: PAIR }) }
const request = (body: unknown) => new Request(`http://localhost/api/whatsapp-oficial/conversations/pairs/${PAIR}/reply`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

describe('paired human reply route', () => {
  const rpc = vi.fn()
  const maybeSingle = vi.fn()
  beforeEach(() => {
    delete process.env.WHATSAPP_PAIR_REPLY_ENABLED
    __resetRateLimitForTests()
    rpc.mockReset()
    maybeSingle.mockReset().mockResolvedValue({ data: pair, error: null })
    const supabaseUser = { rpc, from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }) }
    mocks.session.mockReset().mockResolvedValue({ userId: 'human', supabaseUser, admin: {} })
    mocks.conversation.mockReset().mockImplementation(async (id: string) => ({
      conversation: { id, tenant_id: 'sunt', canal_id: 'canal' },
    }))
    mocks.window.mockReset().mockResolvedValue({ applies: true, open: true, expiresAt: '2026-09-30T00:00:00Z', serverTime: '2026-09-29T00:00:00Z' })
  })
  afterEach(() => { delete process.env.WHATSAPP_PAIR_REPLY_ENABLED })

  it('keeps replies disabled by default while allowing inbound-only window inspection', async () => {
    const get = await GET(new Request('http://localhost'), params)
    expect((await get.json()).enabled).toBe(false)
    expect(mocks.window).toHaveBeenCalledWith(expect.anything(), { id: IN, tenant_id: 'sunt', canal_id: 'canal' })
    const post = await POST(request({ content: 'oi', clientRequestId: REQUEST }), params)
    expect(post.status).toBe(403)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('enqueues only through the authenticated bilateral RPC for the inbound member', async () => {
    process.env.WHATSAPP_PAIR_REPLY_ENABLED = 'true'
    rpc.mockResolvedValue({ data: { ok: true, pair_id: PAIR, conversation_id: IN, message_id: MESSAGE, replayed: false }, error: null })
    const response = await POST(request({ content: ' resposta ', clientRequestId: REQUEST }), params)
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ ok: true, messageId: MESSAGE, conversationId: IN, replayed: false })
    expect(rpc).toHaveBeenCalledWith('whatsapp_oficial_enfileirar_resposta_par', {
      p_pair_id: PAIR, p_content: 'resposta', p_client_request_id: REQUEST,
    })
  })

  it('rejects a missing RLS pair or either member before enqueue', async () => {
    process.env.WHATSAPP_PAIR_REPLY_ENABLED = 'true'
    maybeSingle.mockResolvedValueOnce({ data: null, error: null })
    expect((await POST(request({ content: 'oi', clientRequestId: REQUEST }), params)).status).toBe(404)
    mocks.conversation.mockRejectedValueOnce(new NotFoundError())
    expect((await POST(request({ content: 'oi', clientRequestId: REQUEST }), params)).status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('rejects malformed retry ids but lets SQL decide a closed-window replay', async () => {
    process.env.WHATSAPP_PAIR_REPLY_ENABLED = 'true'
    expect((await POST(request({ content: 'oi', clientRequestId: 'bad' }), params)).status).toBe(400)
    mocks.window.mockResolvedValue({ applies: true, open: false, expiresAt: null, serverTime: '2026-09-29T00:00:00Z' })
    rpc.mockResolvedValue({ data: { ok: true, pair_id: PAIR, conversation_id: IN, message_id: MESSAGE, replayed: true }, error: null })
    expect((await POST(request({ content: 'oi', clientRequestId: REQUEST }), params)).status).toBe(200)
    expect(rpc).toHaveBeenCalledOnce()
    expect(mocks.window).not.toHaveBeenCalled()
  })

  it('treats a wrong member in a success response as invalid', async () => {
    process.env.WHATSAPP_PAIR_REPLY_ENABLED = 'true'
    rpc.mockResolvedValue({ data: { ok: true, pair_id: PAIR, conversation_id: OUT, message_id: MESSAGE }, error: null })
    expect((await POST(request({ content: 'oi', clientRequestId: REQUEST }), params)).status).toBe(502)
  })

  it('returns a conflict when the database trigger blocks a concurrent policy change', async () => {
    process.env.WHATSAPP_PAIR_REPLY_ENABLED = 'true'
    rpc.mockResolvedValue({ data: null, error: { code: '23514', message: 'paired reply policy blocked' } })
    const response = await POST(request({ content: 'oi', clientRequestId: REQUEST }), params)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'Resposta vinculada recusada.' })
  })
})
