import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

const mocks = vi.hoisted(() => ({ requireConversationAccess: vi.fn() }))
vi.mock('@/lib/whatsapp-oficial/api-auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/whatsapp-oficial/api-auth')>(
    '@/lib/whatsapp-oficial/api-auth',
  )
  return { ...actual, requireConversationAccess: mocks.requireConversationAccess }
})

import { NotFoundError } from '@/lib/whatsapp-oficial/api-auth'
import { GET, PATCH } from './route'

const ID = '11111111-1111-4111-8111-111111111111'
const params = { params: Promise.resolve({ id: ID }) }

function patch(ativa: unknown): Request {
  return new Request('http://localhost', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ativa }),
  })
}

describe('human Sophia pause', () => {
  const rpc = vi.fn()
  const from = vi.fn()

  function channel(provider: string, sophia_permitida: boolean) {
    const row = { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { provider, sophia_permitida }, error: null }) }) }) }) }
    const conversation = { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { sophia_ativa: false, sophia_alterada_em: null }, error: null }) }) }) }) }
    from.mockImplementation((table: string) => table === 'whatsapp_channels' ? row : conversation)
  }

  beforeEach(() => {
    rpc.mockReset()
    from.mockReset()
    mocks.requireConversationAccess.mockReset()
    __resetRateLimitForTests()
    mocks.requireConversationAccess.mockResolvedValue({
      userId: 'user-1',
      conversation: { id: ID, tenant_id: 'sunt', canal_id: 'channel-1' },
      admin: { from, rpc },
    })
  })

  it('keeps an inaccessible conversation hidden', async () => {
    mocks.requireConversationAccess.mockRejectedValue(new NotFoundError())
    const response = await PATCH(patch(false), params)
    expect(response.status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('requires a boolean and calls the atomic RPC with the real actor', async () => {
    expect((await PATCH(patch('false'), params)).status).toBe(400)
    rpc.mockResolvedValue({ data: { ok: true, sophia_ativa: false, cancelled_replies: 1, in_flight_replies: 1 }, error: null })
    const response = await PATCH(patch(false), params)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ sophia_ativa: false, cancelled_replies: 1, in_flight_replies: 1 })
    expect(rpc).toHaveBeenCalledWith('whatsapp_sophia_definir_estado', {
      p_conversation_id: ID, p_actor_user_id: 'user-1', p_ativa: false,
    })
  })

  it('does not show the toggle on a non-Meta channel', async () => {
    channel('evolution', false)
    const response = await GET(new Request('http://localhost'), params)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ supported: false, sophia_ativa: false })
  })

  it('shows broker Meta channels as human-only and rejects activation before the RPC', async () => {
    channel('meta_cloud', false)
    const state = await GET(new Request('http://localhost'), params)
    expect(state.status).toBe(200)
    expect(await state.json()).toMatchObject({
      supported: false,
      sophia_ativa: false,
      reason: expect.stringContaining('atendimento permanece humano'),
    })
    const response = await PATCH(patch(true), params)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('atendimento permanece humano') })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('preserves the official channel and allows pausing even after channel permission is removed', async () => {
    channel('meta_cloud', true)
    const state = await GET(new Request('http://localhost'), params)
    expect(await state.json()).toMatchObject({ supported: true, reason: null })
    channel('meta_cloud', false)
    rpc.mockResolvedValue({ data: { ok: true, sophia_ativa: false, cancelled_replies: 0, in_flight_replies: 0 }, error: null })
    const response = await PATCH(patch(false), params)
    expect(response.status).toBe(200)
    expect(rpc).toHaveBeenCalledOnce()
  })

  it('translates the database race guard into a legible conflict', async () => {
    channel('meta_cloud', true)
    rpc.mockResolvedValue({ data: null, error: { code: '23514', message: 'sophia_nao_permitida_no_canal' } })
    const response = await PATCH(patch(true), params)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('neste número') })
  })
})
