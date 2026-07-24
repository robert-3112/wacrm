import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  supabaseAdmin: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: mocks.createServerClient,
}))

vi.mock('./supabase-admin', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}))

import { NotFoundError, UnauthorizedError, requireConversationAccess } from './api-auth'

/**
 * Minimal fake of the Supabase query-builder surface `requireConversationAccess`
 * touches: `.auth.getUser()` and `.from('whatsapp_conversations').select().eq().maybeSingle()`.
 * `conversationRow: null` simulates BOTH "doesn't exist" and "RLS hid it from
 * this user" — the two are indistinguishable by design (same as the media
 * relay route this pattern is copied from), which is exactly the scenario
 * this file exists to prove: a corretor who isn't the conversation's owner
 * (and isn't gestão) gets an empty result from Postgres, not an error, and
 * that empty result must be treated as "no access".
 */
function makeFakeUserClient(opts: {
  user: { id: string } | null
  conversationRow: Record<string, unknown> | null
  selectError?: { message: string } | null
}) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: opts.user },
        error: opts.user ? null : { message: 'no session' },
      }),
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn().mockResolvedValue({
            data: opts.conversationRow,
            error: opts.selectError ?? null,
          }),
        })),
      })),
    })),
  }
}

describe('requireConversationAccess', () => {
  beforeEach(() => {
    mocks.createServerClient.mockReset()
    mocks.supabaseAdmin.mockReset()
    mocks.supabaseAdmin.mockReturnValue({ marker: 'admin-client' })
  })

  it('throws UnauthorizedError when there is no session', async () => {
    mocks.createServerClient.mockResolvedValue(
      makeFakeUserClient({ user: null, conversationRow: null }),
    )

    await expect(requireConversationAccess('conv-1')).rejects.toBeInstanceOf(UnauthorizedError)
  })

  it('throws NotFoundError when RLS returns no row for a conversation the caller does not own', async () => {
    // This is the "wrong corretor" scenario: the row exists in the DB, but
    // the RLS-scoped SELECT (whatsapp_conversations_select policy: gestão OR
    // the owning corretor) returns nothing for this caller — indistinguishable
    // from the conversation simply not existing, by design.
    mocks.createServerClient.mockResolvedValue(
      makeFakeUserClient({ user: { id: 'user-not-owner' }, conversationRow: null }),
    )

    await expect(requireConversationAccess('conv-1')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('throws NotFoundError (not a 500) when the select itself errors', async () => {
    mocks.createServerClient.mockResolvedValue(
      makeFakeUserClient({
        user: { id: 'user-1' },
        conversationRow: null,
        selectError: { message: 'connection reset' },
      }),
    )

    await expect(requireConversationAccess('conv-1')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('returns the conversation + admin client when RLS confirms the caller can see it', async () => {
    const row = {
      id: 'conv-1',
      tenant_id: 'sunt',
      canal_id: 'canal-1',
      lead_id: 'lead-1',
      status: 'aberta',
    }
    mocks.createServerClient.mockResolvedValue(
      makeFakeUserClient({ user: { id: 'owner-corretor' }, conversationRow: row }),
    )

    const ctx = await requireConversationAccess('conv-1')

    expect(ctx.userId).toBe('owner-corretor')
    expect(ctx.conversation).toEqual(row)
    expect(ctx.admin).toEqual({ marker: 'admin-client' })
  })
})
