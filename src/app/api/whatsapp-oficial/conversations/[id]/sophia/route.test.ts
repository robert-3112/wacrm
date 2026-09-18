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
    rpc.mockResolvedValue({ data: { ok: true, sophia_ativa: false, cancelled_replies: 1 }, error: null })
    const response = await PATCH(patch(false), params)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ sophia_ativa: false, cancelled_replies: 1 })
    expect(rpc).toHaveBeenCalledWith('whatsapp_sophia_definir_estado', {
      p_conversation_id: ID, p_actor_user_id: 'user-1', p_ativa: false,
    })
  })

  it('does not show the toggle on a non-Meta channel', async () => {
    const channel = { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { provider: 'evolution' }, error: null }) }) }) }) }
    const conversation = { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { sophia_ativa: false, sophia_alterada_em: null }, error: null }) }) }) }) }
    from.mockImplementation((table: string) => table === 'whatsapp_channels' ? channel : conversation)
    const response = await GET(new Request('http://localhost'), params)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ supported: false, sophia_ativa: false })
  })
})
