import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PairProofSummary } from './pair-candidate-action'
import type { PairCandidate } from '@/lib/whatsapp-oficial/pair-actions'

const candidate: PairCandidate = {
  ok: true,
  outbound_conversation_id: '11111111-1111-4111-8111-111111111111',
  inbound_conversation_id: '22222222-2222-4222-8222-222222222222',
  outbound_message_id: '33333333-3333-4333-8333-333333333333',
  inbound_message_id: '44444444-4444-4444-8444-444444444444',
  status_webhook_event_id: '55555555-5555-4555-8555-555555555555',
  inbound_webhook_event_id: '66666666-6666-4666-8666-666666666666',
  status_at: '2026-09-28T00:00:00Z',
  inbound_at: '2026-09-28T00:01:00Z',
}

describe('manager pair evidence preview', () => {
  it('explains exact Meta match and read-only result before confirmation', () => {
    const html = renderToStaticMarkup(<PairProofSummary candidate={candidate} />)
    expect(html).toContain('Meta confirmou')
    expect(html).toContain('Somente leitura')
    expect(html).toContain('11111111-1111-4111-8111-111111111111')
    expect(html).toContain('22222222-2222-4222-8222-222222222222')
    expect(html).toContain('66666666-6666-4666-8666-666666666666')
    expect(html).not.toContain('Enviar mensagem')
  })
})
