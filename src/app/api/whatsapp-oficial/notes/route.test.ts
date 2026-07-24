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

import { NotFoundError, UnauthorizedError } from '@/lib/whatsapp-oficial/api-auth'
import { POST } from './route'

function jsonRequest(body: unknown) {
  return new Request('http://localhost/api/whatsapp-oficial/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/whatsapp-oficial/notes', () => {
  beforeEach(() => {
    mocks.requireConversationAccess.mockReset()
    __resetRateLimitForTests()
  })

  it('rejects a request with no session (401)', async () => {
    mocks.requireConversationAccess.mockRejectedValue(new UnauthorizedError())

    const res = await POST(jsonRequest({ conversationId: 'conv-1', conteudo: 'nota' }))

    expect(res.status).toBe(401)
  })

  it('a corretor who does not own the conversation cannot add a note (404, not 403)', async () => {
    mocks.requireConversationAccess.mockRejectedValue(new NotFoundError())

    const res = await POST(jsonRequest({ conversationId: 'conv-outro-corretor', conteudo: 'nota' }))

    expect(res.status).toBe(404)
  })

  it('rejects an empty note before checking authorization', async () => {
    const res = await POST(jsonRequest({ conversationId: 'conv-1', conteudo: '  ' }))

    expect(res.status).toBe(400)
    expect(mocks.requireConversationAccess).not.toHaveBeenCalled()
  })

  it('inserts the note for an authorized caller', async () => {
    const insertedNote = {
      id: 'note-1',
      conversation_id: 'conv-1',
      autor_id: 'owner-corretor',
      conteudo: 'ligar amanha',
      created_at: '2026-07-24T00:00:00Z',
    }
    const admin = {
      from: vi.fn(() => ({
        insert: vi.fn(() => ({
          select: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({ data: insertedNote, error: null }),
          })),
        })),
      })),
    }
    mocks.requireConversationAccess.mockResolvedValue({
      userId: 'owner-corretor',
      conversation: { id: 'conv-1', tenant_id: 'sunt', canal_id: 'canal-1', lead_id: 'lead-1', status: 'aberta' },
      supabaseUser: {},
      admin,
    })

    const res = await POST(jsonRequest({ conversationId: 'conv-1', conteudo: 'ligar amanha' }))
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json.note.id).toBe('note-1')
  })
})
