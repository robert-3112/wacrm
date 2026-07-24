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

describe('POST /api/whatsapp-oficial/conversations/[id]/read', () => {
  beforeEach(() => {
    mocks.requireConversationAccess.mockReset()
    __resetRateLimitForTests()
  })

  it('a caller who cannot see the conversation gets 404, and no write happens', async () => {
    mocks.requireConversationAccess.mockRejectedValue(new NotFoundError())
    const admin = { from: vi.fn() }

    const res = await POST(new Request('http://localhost'), params)

    expect(res.status).toBe(404)
    expect(admin.from).not.toHaveBeenCalled()
  })

  it('zeroes nao_lidas_corretor for an authorized caller', async () => {
    const eq = vi.fn().mockResolvedValue({ error: null })
    const update = vi.fn(() => ({ eq }))
    const admin = { from: vi.fn(() => ({ update })) }
    mocks.requireConversationAccess.mockResolvedValue({
      userId: 'owner-corretor',
      conversation: { id: 'conv-1', tenant_id: 'sunt', canal_id: 'canal-1', lead_id: 'lead-1', status: 'aberta' },
      supabaseUser: {},
      admin,
    })

    const res = await POST(new Request('http://localhost'), params)

    expect(res.status).toBe(200)
    expect(update).toHaveBeenCalledWith({ nao_lidas_corretor: 0 })
    expect(eq).toHaveBeenCalledWith('id', 'conv-1')
  })
})
