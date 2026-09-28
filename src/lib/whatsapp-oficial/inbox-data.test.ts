import { describe, expect, it, vi } from 'vitest'
import {
  buildInboxItems,
  fetchPairedMessages,
  mergePairedMessages,
  leadDisplayName,
  matchesInboxFilter,
  matchesSearch,
  normalizeConversationRow,
} from './inbox-data'
import type { WhatsAppConversation, WhatsAppConversationPair, WhatsAppMessage } from '@/types/whatsapp-oficial'

function makeConversation(
  overrides: Partial<WhatsAppConversation> = {},
  leadOverrides: Partial<NonNullable<WhatsAppConversation['lead']>> | null = {},
): WhatsAppConversation {
  return {
    id: 'conv-1',
    tenant_id: 'sunt',
    canal_id: 'canal-1',
    lead_id: 'lead-1',
    wa_contact_name: null,
    status: 'aberta',
    optout_em: null,
    ultima_mensagem_em: null,
    ultima_mensagem_preview: null,
    nao_lidas_corretor: 0,
    created_at: '2026-07-01T00:00:00Z',
    lead:
      leadOverrides === null
        ? null
        : {
            id: 'lead-1',
            nome: 'Maria Silva',
            whatsapp: '5547999990000',
            etapa: 'novo',
            temperatura: 'morno',
            urgente: false,
            empreendimento_interesse_slug: null,
            corretor_id: 'corretor-1',
            status: 'new',
            corretor: { id: 'corretor-1', nome: 'Eduardo' },
            ...leadOverrides,
          },
    ...overrides,
  }
}

describe('normalizeConversationRow', () => {
  it('coalesces the legacy nome/name pair, preferring nome', () => {
    const raw = {
      ...makeConversation(),
      lead: {
        id: 'lead-1',
        nome: 'Maria Silva',
        name: 'Legacy Name',
        whatsapp: '5547999990000',
        phone: null,
        etapa: 'novo',
        temperatura: null,
        urgente: false,
        empreendimento_interesse_slug: null,
        corretor_id: null,
        status: 'new',
        corretor: null,
      },
    } as never
    const result = normalizeConversationRow(raw)
    expect(result.lead?.nome).toBe('Maria Silva')
  })

  it('falls back to `name` when `nome` is blank', () => {
    const raw = {
      ...makeConversation(),
      lead: {
        id: 'lead-1',
        nome: '  ',
        name: 'Legacy Name',
        whatsapp: null,
        phone: '5547999990000',
        etapa: 'novo',
        temperatura: null,
        urgente: false,
        empreendimento_interesse_slug: null,
        corretor_id: null,
        status: 'new',
        corretor: null,
      },
    } as never
    const result = normalizeConversationRow(raw)
    expect(result.lead?.nome).toBe('Legacy Name')
    expect(result.lead?.whatsapp).toBe('5547999990000')
  })

  it('unwraps an embedded lead/corretor returned as a 1-item array', () => {
    const raw = {
      ...makeConversation(),
      lead: [
        {
          id: 'lead-1',
          nome: 'Maria Silva',
          name: null,
          whatsapp: '5547999990000',
          phone: null,
          etapa: 'novo',
          temperatura: null,
          urgente: false,
          empreendimento_interesse_slug: null,
          corretor_id: 'corretor-1',
          status: 'new',
          corretor: [{ id: 'corretor-1', nome: 'Eduardo' }],
        },
      ],
    } as never
    const result = normalizeConversationRow(raw)
    expect(result.lead?.nome).toBe('Maria Silva')
    expect(result.lead?.corretor?.nome).toBe('Eduardo')
  })

  it('handles a conversation with no matched lead gracefully', () => {
    const raw = { ...makeConversation(), lead: null } as never
    const result = normalizeConversationRow(raw)
    expect(result.lead).toBeNull()
  })
})

describe('leadDisplayName', () => {
  it('prefers the lead name', () => {
    expect(leadDisplayName(makeConversation())).toBe('Maria Silva')
  })

  it('falls back to the WhatsApp profile name, then phone, then a generic label', () => {
    expect(
      leadDisplayName(makeConversation({ wa_contact_name: 'Profile Name' }, { nome: null })),
    ).toBe('Profile Name')
    expect(
      leadDisplayName(
        makeConversation({ wa_contact_name: null }, { nome: null, whatsapp: '5547988887777' }),
      ),
    ).toBe('5547988887777')
    expect(
      leadDisplayName(makeConversation({ wa_contact_name: null }, { nome: null, whatsapp: null })),
    ).toBe('Contato sem nome')
  })
})

describe('matchesInboxFilter', () => {
  it('"todas" matches everything', () => {
    expect(matchesInboxFilter(makeConversation({ status: 'encerrada' }), 'todas')).toBe(true)
  })

  it('matches the conversation status filters', () => {
    const pendente = makeConversation({ status: 'pendente' })
    expect(matchesInboxFilter(pendente, 'pendente')).toBe(true)
    expect(matchesInboxFilter(pendente, 'aberta')).toBe(false)
  })

  it('"sem_dono" matches a lead with no corretor_id', () => {
    const semDono = makeConversation({}, { corretor_id: null, corretor: null })
    const comDono = makeConversation({}, { corretor_id: 'corretor-1' })
    expect(matchesInboxFilter(semDono, 'sem_dono')).toBe(true)
    expect(matchesInboxFilter(comDono, 'sem_dono')).toBe(false)
  })

  it('"urgente" matches leads.urgente = true', () => {
    const urgente = makeConversation({}, { urgente: true })
    const normal = makeConversation({}, { urgente: false })
    expect(matchesInboxFilter(urgente, 'urgente')).toBe(true)
    expect(matchesInboxFilter(normal, 'urgente')).toBe(false)
  })

  it('a conversation with no matched lead never matches sem_dono/urgente', () => {
    const noLead = makeConversation({}, null)
    expect(matchesInboxFilter(noLead, 'sem_dono')).toBe(true)
    expect(matchesInboxFilter(noLead, 'urgente')).toBe(false)
  })
})

describe('matchesSearch', () => {
  it('matches by name, case/diacritic-insensitively', () => {
    const conv = makeConversation({}, { nome: 'José Álvares' })
    expect(matchesSearch(conv, 'jose alvares')).toBe(true)
    expect(matchesSearch(conv, 'JOSÉ')).toBe(true)
    expect(matchesSearch(conv, 'outro nome')).toBe(false)
  })

  it('matches by phone number substring', () => {
    const conv = makeConversation({}, { whatsapp: '5547999990000' })
    expect(matchesSearch(conv, '99999')).toBe(true)
    expect(matchesSearch(conv, '00001')).toBe(false)
  })

  it('an empty query matches everything', () => {
    expect(matchesSearch(makeConversation(), '   ')).toBe(true)
  })
})

const pair: WhatsAppConversationPair = {
  id: 'pair-1', tenant_id: 'sunt', outbound_conversation_id: 'out', inbound_conversation_id: 'in',
  outbound_message_id: 'message-out', inbound_message_id: 'message-in',
  status_webhook_event_id: null, inbound_webhook_event_id: null,
  linked_by: null, linked_at: '2026-07-01T00:00:00Z',
}

describe('paired inbox view', () => {
  it('collapses only a verified pair with both RLS-visible members and retains source IDs', () => {
    const outbound = makeConversation({ id: 'out', ultima_mensagem_em: '2026-07-01T01:00:00Z', nao_lidas_corretor: 1 })
    const inbound = makeConversation({ id: 'in', ultima_mensagem_em: '2026-07-01T02:00:00Z', nao_lidas_corretor: 2, optout_em: '2026-07-01T03:00:00Z' })
    const [item] = buildInboxItems([outbound, inbound], [pair])
    expect(item.kind).toBe('pair')
    if (item.kind !== 'pair') return
    expect(item.outbound.id).toBe('out')
    expect(item.inbound.id).toBe('in')
    expect(item.conversation.nao_lidas_corretor).toBe(3)
    expect(item.conversation.optout_em).toBe(inbound.optout_em)
    expect(item.conversation.ultima_mensagem_em).toBe(inbound.ultima_mensagem_em)
    expect(buildInboxItems([outbound], [pair]).map(item => item.id)).toEqual(['out'])
    expect(buildInboxItems([outbound, { ...inbound, tenant_id: 'other' }], [pair]).map(item => item.id)).toEqual(['out', 'in'])
  })

  it('keeps a standalone conversation and blocks pairing across channels', () => {
    const outbound = makeConversation({ id: 'out' })
    const inbound = makeConversation({ id: 'in', canal_id: 'other-channel' })
    expect(buildInboxItems([outbound, inbound], [pair]).every(item => item.kind === 'single')).toBe(true)
  })

  it('orders each original message by provider time, then creation time', () => {
    const message = (id: string, conversation_id: string, created_at: string, wpp_timestamp: string | null = null) =>
      ({ id, conversation_id, created_at, wpp_timestamp } as WhatsAppMessage)
    const result = mergePairedMessages(
      [message('first', 'out', '2026-07-01T04:00:00Z', '2026-07-01T01:00:00Z')],
      [message('second', 'in', '2026-07-01T02:00:00Z')],
    )
    expect(result.map(message => [message.id, message.conversation_id])).toEqual([['first', 'out'], ['second', 'in']])
  })

  it('does not read either history when one member is no longer RLS-visible', async () => {
    const messageSelect = vi.fn()
    const supabase = { from: (table: string) => ({ select: () => {
      if (table === 'whatsapp_messages') { messageSelect(); return {} }
      return { eq: (_column: string, id: string) => ({ maybeSingle: async () => ({
        data: table === 'whatsapp_conversation_pairs' ? pair : id === 'out' ? makeConversation({ id: 'out' }, null) : null,
        error: null,
      }) }) }
    } }) }
    const result = await fetchPairedMessages(supabase as never, pair)
    expect(result.data).toEqual([])
    expect(result.error).toMatch(/indisponível/)
    expect(messageSelect).not.toHaveBeenCalled()
  })

  it('rejects a partial history when the verified inbound anchor is not visible', async () => {
    const supabase = { from: (table: string) => ({ select: () => ({
      eq: (_column: string, id: string) => table === 'whatsapp_messages'
        ? { order: async () => ({ data: id === 'out' ? [{ id: 'message-out' }] : [], error: null }) }
        : { maybeSingle: async () => ({
          data: table === 'whatsapp_conversation_pairs' ? pair : makeConversation({ id }, null), error: null,
        }) },
    }) }) }
    const result = await fetchPairedMessages(supabase as never, pair)
    expect(result.data).toEqual([])
    expect(result.error).toMatch(/indisponível/)
  })
})
