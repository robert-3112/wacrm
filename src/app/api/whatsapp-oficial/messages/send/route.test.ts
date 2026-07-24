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

import { UnauthorizedError, NotFoundError } from '@/lib/whatsapp-oficial/api-auth'
import { POST } from './route'

function jsonRequest(body: unknown) {
  return new Request('http://localhost/api/whatsapp-oficial/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function makeAdmin(
  overrides: {
    rpcError?: { message: string }
    result?: {
      ok: boolean
      reason?: string
      message?: Record<string, unknown>
    }
  } = {},
) {
  const insertedMessage = {
    id: 'msg-1',
    tenant_id: 'sunt',
    conversation_id: 'conv-1',
    direction: 'outbound',
    message_type: 'text',
    content: 'Oi!',
    status: 'pendente',
    enviado_por: 'owner-corretor',
    created_at: '2026-07-24T00:00:00Z',
  }
  return {
    rpc: vi.fn().mockResolvedValue({
      data: overrides.result ?? { ok: true, message: insertedMessage },
      error: overrides.rpcError ?? null,
    }),
  }
}

function authorizedContext(admin: ReturnType<typeof makeAdmin>) {
  return {
    userId: 'owner-corretor',
    conversation: {
      id: 'conv-1',
      tenant_id: 'sunt',
      canal_id: 'canal-1',
      lead_id: 'lead-1',
      status: 'aberta',
    },
    supabaseUser: {},
    admin,
  }
}

describe('POST /api/whatsapp-oficial/messages/send', () => {
  beforeEach(() => {
    mocks.requireConversationAccess.mockReset()
    __resetRateLimitForTests()
  })

  it('rejects a request with no session (401)', async () => {
    mocks.requireConversationAccess.mockRejectedValue(new UnauthorizedError())
    const res = await POST(jsonRequest({ conversationId: 'conv-1', content: 'Oi!' }))
    expect(res.status).toBe(401)
  })

  it('does not reveal a conversation hidden by RLS', async () => {
    mocks.requireConversationAccess.mockRejectedValue(new NotFoundError('Conversation not found'))
    const res = await POST(jsonRequest({ conversationId: 'conv-not-mine', content: 'Oi!' }))
    expect(res.status).toBe(404)
  })

  it('rejects empty content before authorization', async () => {
    const res = await POST(jsonRequest({ conversationId: 'conv-1', content: '   ' }))
    expect(res.status).toBe(400)
    expect(mocks.requireConversationAccess).not.toHaveBeenCalled()
  })

  it('rejects content over the limit', async () => {
    const res = await POST(jsonRequest({ conversationId: 'conv-1', content: 'a'.repeat(5000) }))
    expect(res.status).toBe(400)
    expect(mocks.requireConversationAccess).not.toHaveBeenCalled()
  })

  it('uses the atomic enqueue RPC for an authorized caller', async () => {
    const admin = makeAdmin()
    mocks.requireConversationAccess.mockResolvedValue(authorizedContext(admin))

    const res = await POST(jsonRequest({ conversationId: 'conv-1', content: 'Oi!' }))
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json.ok).toBe(true)
    expect(json.message.id).toBe('msg-1')
    expect(admin.rpc).toHaveBeenCalledWith('whatsapp_oficial_enfileirar_mensagem', {
      p_conversation_id: 'conv-1',
      p_content: 'Oi!',
      p_actor_user_id: 'owner-corretor',
    })
  })

  it('fails closed when the atomic enqueue RPC fails', async () => {
    const admin = makeAdmin({ rpcError: { message: 'db down' } })
    mocks.requireConversationAccess.mockResolvedValue(authorizedContext(admin))

    const res = await POST(jsonRequest({ conversationId: 'conv-1', content: 'Oi!' }))
    expect(res.status).toBe(500)
  })

  it('blocks an opt-out returned by the database gate', async () => {
    const admin = makeAdmin({
      result: { ok: false, reason: 'lead_optout_ou_inativo' },
    })
    mocks.requireConversationAccess.mockResolvedValue(authorizedContext(admin))

    const res = await POST(jsonRequest({ conversationId: 'conv-1', content: 'Oi!' }))
    expect(res.status).toBe(409)
  })
})
