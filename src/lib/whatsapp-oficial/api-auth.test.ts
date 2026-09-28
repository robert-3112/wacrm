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
  isGestao?: boolean
  corretorId?: string | null
  leadRow?: Record<string, unknown> | null
  channelRow?: Record<string, unknown> | null
  roleError?: { message: string } | null
  sharedAccess?: boolean
}) {
  const rows: Record<string, Record<string, unknown> | null> = {
    whatsapp_conversations: opts.conversationRow,
    leads: opts.leadRow ?? null,
    whatsapp_channels: opts.channelRow ?? null,
  }
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: opts.user },
        error: opts.user ? null : { message: 'no session' },
      }),
    },
    rpc: vi.fn(async (name: string) => ({
      data: name === 'crm_is_gestao' ? (opts.isGestao ?? true)
        : name === 'crm_current_corretor_id' ? opts.corretorId ?? null
          : opts.sharedAccess ?? false,
      error: opts.roleError ?? null,
    })),
    from: vi.fn((table: string) => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn().mockResolvedValue({
            data: rows[table] ?? null,
            error: table === 'whatsapp_conversations' ? opts.selectError ?? null : null,
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

  const row = {
    id: 'conv-1', tenant_id: 'sunt', canal_id: 'canal-1', lead_id: 'lead-1', status: 'aberta',
  }
  const lead = { id: 'lead-1', tenant_id: 'sunt', corretor_id: 'broker-1' }
  const channel = { id: 'canal-1', tenant_id: 'sunt', corretor_id: 'broker-1' }

  it('allows a broker only when the lead and channel belong to that same broker', async () => {
    const client = makeFakeUserClient({
      user: { id: 'user-1' }, conversationRow: row,
      isGestao: false, corretorId: 'broker-1', leadRow: lead, channelRow: channel,
    })
    mocks.createServerClient.mockResolvedValue(client)

    const ctx = await requireConversationAccess('conv-1')

    expect(ctx.conversation).toEqual(row)
    expect(client.rpc).toHaveBeenCalledWith('crm_current_corretor_id')
    expect(client.from).toHaveBeenCalledWith('leads')
    expect(client.from).toHaveBeenCalledWith('whatsapp_channels')
  })

  it('allows the shared 1266 only when the authenticated database gate attests default-channel access', async () => {
    const client = makeFakeUserClient({
      user: { id: 'user-1' }, conversationRow: row,
      isGestao: false, corretorId: 'broker-1', leadRow: lead,
      channelRow: null, sharedAccess: true,
    })
    mocks.createServerClient.mockResolvedValue(client)

    const ctx = await requireConversationAccess('conv-1')

    expect(ctx.conversation).toEqual(row)
    expect(client.rpc).toHaveBeenCalledWith('whatsapp_oficial_corretor_pode_ler_conversa', {
      p_conversation_id: 'conv-1',
    })
  })

  it.each([
    ['other broker channel', lead, { ...channel, corretor_id: 'broker-2' }],
    ['other broker lead', { ...lead, corretor_id: 'broker-2' }, channel],
    ['other tenant channel', lead, { ...channel, tenant_id: 'other' }],
    ['other tenant lead', { ...lead, tenant_id: 'other' }, channel],
    ['hidden channel', lead, null],
  ])('rejects a broker for %s before creating service_role', async (_case, leadRow, channelRow) => {
    mocks.createServerClient.mockResolvedValue(makeFakeUserClient({
      user: { id: 'user-1' }, conversationRow: row,
      isGestao: false, corretorId: 'broker-1', leadRow, channelRow,
    }))

    await expect(requireConversationAccess('conv-1')).rejects.toBeInstanceOf(NotFoundError)
    expect(mocks.supabaseAdmin).not.toHaveBeenCalled()
  })

  it('rejects broker access when role lookup fails or broker is inactive', async () => {
    mocks.createServerClient.mockResolvedValueOnce(makeFakeUserClient({
      user: { id: 'user-1' }, conversationRow: row, roleError: { message: 'rpc unavailable' },
    }))
    await expect(requireConversationAccess('conv-1')).rejects.toBeInstanceOf(NotFoundError)

    mocks.createServerClient.mockResolvedValueOnce(makeFakeUserClient({
      user: { id: 'user-1' }, conversationRow: row, isGestao: false, corretorId: null,
    }))
    await expect(requireConversationAccess('conv-1')).rejects.toBeInstanceOf(NotFoundError)
    expect(mocks.supabaseAdmin).not.toHaveBeenCalled()
  })
})
