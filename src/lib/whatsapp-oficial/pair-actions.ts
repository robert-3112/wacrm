export interface PairCandidate {
  ok: true
  outbound_conversation_id: string
  inbound_conversation_id: string
  outbound_message_id: string
  inbound_message_id: string
  status_webhook_event_id: string
  inbound_webhook_event_id: string
  status_at: string
  inbound_at: string
}

type Result<T> = { ok: true } & T | { ok: false; error: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SIX = [
  'outbound_conversation_id', 'inbound_conversation_id',
  'outbound_message_id', 'inbound_message_id',
  'status_webhook_event_id', 'inbound_webhook_event_id',
] as const

function errorFrom(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
    return (body as { error: string }).error
  }
  return fallback
}

export async function previewConversationPair(conversationId: string): Promise<Result<{ candidate: PairCandidate; linkEnabled: boolean }>> {
  try {
    const response = await fetch(`/api/whatsapp-oficial/conversations/${conversationId}/pair`, { cache: 'no-store' })
    const body = await response.json().catch(() => null)
    if (!response.ok) return { ok: false, error: errorFrom(body, 'Não foi possível verificar o vínculo.') }
    const candidate = body && typeof body === 'object' ? (body as { candidate?: unknown }).candidate : null
    if (!candidate || typeof candidate !== 'object' ||
      (candidate as { ok?: unknown }).ok !== true ||
      SIX.some(key => !UUID.test(String((candidate as Record<string, unknown>)[key] ?? ''))) ||
      typeof (candidate as { status_at?: unknown }).status_at !== 'string' ||
      typeof (candidate as { inbound_at?: unknown }).inbound_at !== 'string' ||
      (candidate as PairCandidate).outbound_conversation_id !== conversationId) {
      return { ok: false, error: 'Prévia inválida. Tente novamente.' }
    }
    return { ok: true, candidate: candidate as PairCandidate, linkEnabled: (body as { linkEnabled?: unknown }).linkEnabled === true }
  } catch {
    return { ok: false, error: 'Falha de rede. Tente novamente.' }
  }
}

export async function confirmConversationPair(candidate: PairCandidate): Promise<Result<{ pairId: string }>> {
  try {
    const body = Object.fromEntries(SIX.map(key => [key, candidate[key]]))
    const response = await fetch(`/api/whatsapp-oficial/conversations/${candidate.outbound_conversation_id}/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const result = await response.json().catch(() => null)
    if (!response.ok) return { ok: false, error: errorFrom(result, 'Não foi possível vincular os históricos.') }
    if (!result || typeof result.pairId !== 'string') return { ok: false, error: 'Resposta de vínculo inválida.' }
    return { ok: true, pairId: result.pairId }
  } catch {
    return { ok: false, error: 'Falha de rede. Tente novamente.' }
  }
}
