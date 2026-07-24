/**
 * Client-side action helpers for the official-channel inbox (Fase 6) WRITE
 * routes — thin `fetch` wrappers around `src/app/api/whatsapp-oficial/**`
 * (see that directory + `api-auth.ts` for the server-side contract each of
 * these calls into). Centralizes the fetch/JSON/error-shape boilerplate
 * that would otherwise be duplicated in every component that triggers a
 * write, mirroring the role `inbox-data.ts` plays for reads.
 *
 * WRITTEN FROM SCRATCH for this mission — no WACRM equivalent (that
 * project's inbox components call `fetch` inline per-component; this
 * module exists because Fase 6 has six independent write actions sharing
 * the exact same request/error shape, so a shared helper pays for itself
 * immediately rather than being speculative abstraction).
 */

import type {
  WhatsAppConversationStatus,
  WhatsAppInternalNote,
  WhatsAppMessage,
} from '@/types/whatsapp-oficial'

export interface ActionSuccess<T> {
  ok: true
  data: T
}

export interface ActionFailure {
  ok: false
  error: string
}

export type ActionResult<T> = ActionSuccess<T> | ActionFailure

/**
 * POST/PATCH `url` with a JSON body and normalize the response into
 * {@link ActionResult}. Every write route in this subsystem returns either
 * `{ ok: true, ... }` (2xx) or `{ error: string }` (4xx/5xx) — see
 * `api-auth.ts#toErrorResponse` and each route's handler — so a single
 * generic covers all six call sites below.
 */
async function request<T>(
  url: string,
  method: 'POST' | 'PATCH',
  body?: unknown,
): Promise<ActionResult<T>> {
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
  } catch {
    return { ok: false, error: 'Falha de rede — verifique a conexão e tente novamente.' }
  }

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>

  if (!res.ok) {
    const error = typeof json.error === 'string' ? json.error : `Falha na requisição (${res.status})`
    return { ok: false, error }
  }

  return { ok: true, data: json as T }
}

/** Fase 6 mission item 3 — text-only composer send. */
export function sendTextMessage(
  conversationId: string,
  content: string,
): Promise<ActionResult<{ ok: true; message: WhatsAppMessage }>> {
  return request('/api/whatsapp-oficial/messages/send', 'POST', { conversationId, content })
}

/** Fase 6 mission item 4 — internal note (never reaches the contact). */
export function addInternalNote(
  conversationId: string,
  conteudo: string,
): Promise<ActionResult<{ ok: true; note: WhatsAppInternalNote }>> {
  return request('/api/whatsapp-oficial/notes', 'POST', { conversationId, conteudo })
}

/** Fase 6 mission item 1 — zero the unread counter. */
export function markConversationRead(conversationId: string): Promise<ActionResult<{ ok: true }>> {
  return request(`/api/whatsapp-oficial/conversations/${conversationId}/read`, 'POST')
}

/** Fase 6 mission item 6 — encerrar/reabrir (a plain status UPDATE). */
export function updateConversationStatus(
  conversationId: string,
  status: WhatsAppConversationStatus,
): Promise<ActionResult<{ ok: true; status: WhatsAppConversationStatus }>> {
  return request(`/api/whatsapp-oficial/conversations/${conversationId}/status`, 'PATCH', { status })
}

/** Optional qualification fields the `whatsapp_oficial_registrar_handoff`
 *  RPC accepts — all optional, blank strings are treated as absent by the
 *  route (`stringOrNull`). */
export interface HandoffInput {
  empreendimentoInteresseSlug?: string
  intencao?: string
  regiaoInteresse?: string
  interesse?: string
}

/** Fase 6 mission item 6 — handoff action. */
export function registerHandoff(
  conversationId: string,
  input: HandoffInput = {},
): Promise<ActionResult<{ ok: true; reason?: string }>> {
  return request(`/api/whatsapp-oficial/conversations/${conversationId}/handoff`, 'POST', {
    empreendimento_interesse_slug: input.empreendimentoInteresseSlug,
    intencao: input.intencao,
    regiao_interesse: input.regiaoInteresse,
    interesse: input.interesse,
  })
}

/** Fase 6 mission item 6 — opt-out action. */
export function registerOptout(
  conversationId: string,
): Promise<ActionResult<{ ok: true; reason?: string }>> {
  return request(`/api/whatsapp-oficial/conversations/${conversationId}/optout`, 'POST')
}
