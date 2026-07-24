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
import { PATCH } from './route'

const params = { params: Promise.resolve({ id: 'conv-1' }) }

function jsonRequest(body: unknown) {
  return new Request('http://localhost', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('PATCH /api/whatsapp-oficial/conversations/[id]/status', () => {
  beforeEach(() => {
    mocks.requireConversationAccess.mockReset()
    __resetRateLimitForTests()
  })

  it('rejects an invalid status before checking authorization', async () => {
    const res = await PATCH(jsonRequest({ status: 'nao-existe' }), params)

    expect(res.status).toBe(400)
    expect(mocks.requireConversationAccess).not.toHaveBeenCalled()
  })

  it('a caller who cannot see the conversation gets 404', async () => {
    mocks.requireConversationAccess.mockRejectedValue(new NotFoundError())

    const res = await PATCH(jsonRequest({ status: 'encerrada' }), params)

    expect(res.status).toBe(404)
  })

  it('updates status for an authorized caller', async () => {
    const eq = vi.fn().mockResolvedValue({ error: null })
    const update = vi.fn(() => ({ eq }))
    const admin = { from: vi.fn(() => ({ update })) }
    mocks.requireConversationAccess.mockResolvedValue({
      userId: 'owner-corretor',
      conversation: { id: 'conv-1', tenant_id: 'sunt', canal_id: 'canal-1', lead_id: 'lead-1', status: 'aberta' },
      supabaseUser: {},
      admin,
    })

    const res = await PATCH(jsonRequest({ status: 'encerrada' }), params)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.status).toBe('encerrada')
    expect(update).toHaveBeenCalledWith({ status: 'encerrada' })
  })
})
