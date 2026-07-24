import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

const mocks = vi.hoisted(() => ({
  requireConversationAccess: vi.fn(),
}))

vi.mock('@/lib/whatsapp-oficial/api-auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/whatsapp-oficial/api-auth')>(
    '@/lib/whatsapp-oficial/api-auth',
  )
  return {
    ...actual,
    requireConversationAccess: mocks.requireConversationAccess,
  }
})

import { NotFoundError } from '@/lib/whatsapp-oficial/api-auth'
import { POST } from './route'

const params = { params: Promise.resolve({ id: 'conv-1' }) }

describe('POST /api/whatsapp-oficial/conversations/[id]/optout', () => {
  beforeEach(() => {
    mocks.requireConversationAccess.mockReset()
    __resetRateLimitForTests()
  })

  it('a caller who cannot see the conversation gets 404 and the RPC is never called', async () => {
    mocks.requireConversationAccess.mockRejectedValue(new NotFoundError())
    const rpc = vi.fn()

    const res = await POST(new Request('http://localhost'), params)

    expect(res.status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('calls whatsapp_oficial_registrar_optout with the conversation lead_id for an authorized caller', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { ok: true, status_saida: 'descartado' }, error: null })
    const admin = { rpc }
    mocks.requireConversationAccess.mockResolvedValue({
      userId: 'owner-corretor',
      conversation: { id: 'conv-1', tenant_id: 'sunt', canal_id: 'canal-1', lead_id: 'lead-42', status: 'aberta' },
      supabaseUser: {},
      admin,
    })

    const res = await POST(new Request('http://localhost'), params)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(rpc).toHaveBeenCalledWith('whatsapp_oficial_registrar_optout', { p_lead_id: 'lead-42' })
  })
})
