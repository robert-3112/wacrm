import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MessageThread } from './message-thread'
import type { InboxItem } from '@/lib/whatsapp-oficial/inbox-data'
import type { WhatsAppConversation } from '@/types/whatsapp-oficial'

const conversation: WhatsAppConversation = {
  id: 'in', tenant_id: 'sunt', canal_id: 'canal', lead_id: 'lead',
  wa_contact_name: 'Robert', status: 'aberta', optout_em: null,
  ultima_mensagem_em: null, ultima_mensagem_preview: null,
  nao_lidas_corretor: 0, created_at: '2026-07-01T00:00:00Z', lead: null,
}

describe('linked read-only thread', () => {
  it('shows the verified pair without send, template or mutation controls', () => {
    const linkedPair: Extract<InboxItem, { kind: 'pair' }> = {
      kind: 'pair', id: 'pair:p', outbound: { ...conversation, id: 'out' }, inbound: conversation,
      conversation,
      pair: { id: 'p', tenant_id: 'sunt', outbound_conversation_id: 'out', inbound_conversation_id: 'in',
        outbound_message_id: 'm1', inbound_message_id: 'm2', status_webhook_event_id: null,
        inbound_webhook_event_id: null, linked_by: null, linked_at: '2026-07-01T00:00:00Z' },
    }
    const html = renderToStaticMarkup(<MessageThread conversation={null} linkedPair={linkedPair}
      messages={[]} loading={false} envioReal={true} onMessageSent={() => {}}
      onConversationChanged={() => {}} />)
    expect(html).toContain('Visão vinculada')
    expect(html).toContain('Consulta apenas')
    for (const control of ['Usar template aprovado', 'Handoff', 'Opt-out', 'Reabrir', 'Encerrar', 'Enviar mensagem']) {
      expect(html).not.toContain(control)
    }
  })
})
