import { describe, expect, it } from 'vitest'
import {
  leadDisplayName,
  matchesInboxFilter,
  matchesSearch,
  normalizeConversationRow,
} from './inbox-data'
import type { WhatsAppConversation } from '@/types/whatsapp-oficial'

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
