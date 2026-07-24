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

function makeAdmin(overrides: { insertError?: unknown; outboxError?: unknown } = {}) {
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
    from: vi.fn((table: string) => {
      if (table === 'whatsapp_messages') {
        return {
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn().mockResolvedValue(
                overrides.insertError
                  ? { data: null, error: overrides.insertError }
                  : { data: insertedMessage, error: null },
              ),
            })),
          })),
        }
      }
      if (table === 'whatsapp_outbox') {
        return {
          insert: vi.fn().mockResolvedValue({ error: overrides.outboxError ?? null }),
        }
      }
      if (table === 'whatsapp_conversations') {
        return { update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })) }
      }
      throw new Error(`unexpected table ${table}`)
    }),
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

  it('rejects sending into a conversation the caller cannot see (404, not leaked as 403)', async () => {
    // This is the authorization scenario the mission asks to cover: a
    // corretor who is not the owner of the conversation's lead (and is not
    // gestão) gets an RLS-empty result from requireConversationAccess,
    // surfaced here as 404 — the route never reaches the admin-client write.
    mocks.requireConversationAccess.mockRejectedValue(new NotFoundError('Conversation not found'))

    const res = await POST(jsonRequest({ conversationId: 'conv-not-mine', content: 'Oi!' }))

    expect(res.status).toBe(404)
  })

  it('rejects an empty content body before checking authorization', async () => {
    const res = await POST(jsonRequest({ conversationId: 'conv-1', content: '   ' }))

    expect(res.status).toBe(400)
    expect(mocks.requireConversationAccess).not.toHaveBeenCalled()
  })

  it('rejects content over the max length', async () => {
    const res = await POST(
      jsonRequest({ conversationId: 'conv-1', content: 'a'.repeat(5000) }),
    )

    expect(res.status).toBe(400)
    expect(mocks.requireConversationAccess).not.toHaveBeenCalled()
  })

  it('inserts the message and enqueues an outbox row for an authorized caller', async () => {
    const admin = makeAdmin()
    mocks.requireConversationAccess.mockResolvedValue({
      userId: 'owner-corretor',
      conversation: { id: 'conv-1', tenant_id: 'sunt', canal_id: 'canal-1', lead_id: 'lead-1', status: 'aberta' },
      supabaseUser: {},
      admin,
    })

    const res = await POST(jsonRequest({ conversationId: 'conv-1', content: 'Oi!' }))
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json.ok).toBe(true)
    expect(json.message.id).toBe('msg-1')
    expect(admin.from).toHaveBeenCalledWith('whatsapp_messages')
    expect(admin.from).toHaveBeenCalledWith('whatsapp_outbox')
  })

  it('still succeeds (message already sent) even if the outbox insert fails', async () => {
    const admin = makeAdmin({ outboxError: { message: 'db down' } })
    mocks.requireConversationAccess.mockResolvedValue({
      userId: 'owner-corretor',
      conversation: { id: 'conv-1', tenant_id: 'sunt', canal_id: 'canal-1', lead_id: 'lead-1', status: 'aberta' },
      supabaseUser: {},
      admin,
    })

    const res = await POST(jsonRequest({ conversationId: 'conv-1', content: 'Oi!' }))

    expect(res.status).toBe(201)
  })
})
