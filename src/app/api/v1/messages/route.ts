/**
 * POST /api/v1/messages — enfileira uma mensagem de texto (escopo `messages:send`).
 *
 * ⚠️ Substituiu a rota do fork WACRM neste caminho. A antiga aceitava um telefone, criava
 * contato/conversa e chamava `sendMessageToConversation`, que ENTREGA de verdade na Meta —
 * sobre tabelas (`contacts`, `conversations`, `accounts`) que não existem no Supabase da SUNT.
 * Ver o relatório da Sessão 3.
 *
 * ── O problema do ator, e como foi resolvido ─────────────────────────────────────────────
 * `whatsapp_oficial_enfileirar_mensagem` exige `p_actor_user_id` e o valida contra
 * `app_roles`/`corretores`. Uma chave de API não é um usuário do `auth.users`, então não havia
 * uuid honesto para passar ali. As duas saídas fáceis são ruins:
 *   • inventar um uuid → a RPC recusa com 'sem_permissao';
 *   • reusar `whatsapp_api_keys.criado_por` → a mensagem ficaria assinada por uma pessoa que
 *     não a escreveu, e a integração quebraria no dia em que essa pessoa perdesse o papel de
 *     gestão ou saísse da empresa, por um motivo impossível de adivinhar lendo o erro.
 * Então o ator-máquina ganhou caminho próprio no banco:
 * `whatsapp_oficial_enfileirar_mensagem_api(p_conversation_id, p_content, p_api_key_id)`
 * (migration `20260726100000_whatsapp_api_v1.sql`), que autoriza pela própria chave — não
 * revogada, não expirada, com escopo `messages:send` e do MESMO tenant da conversa — e grava
 * `enviado_por = null` com `api_key_id` preenchido, que é a convenção que
 * `whatsapp_oficial_campanha_enfileirar_lote` já usava para mensagem de máquina.
 *
 * ── "enfileirado", não "enviado" ─────────────────────────────────────────────────────────
 * A resposta diz `enfileirado: true` porque é literalmente o que aconteceu: a linha entrou em
 * `whatsapp_outbox` com status `pendente`. Quem entrega é o worker da outbox, que hoje roda em
 * shadow. Responder "enviado" seria mentira e faria o integrador contar como entregue algo que
 * nunca saiu.
 */

import {
  requireApiKeyWithScope,
  apiV1Ok,
  apiV1BadRequest,
  apiV1NotFound,
  ApiV1Error,
  toApiV1Response,
} from '@/lib/whatsapp-oficial/api-key-auth'
import { isUuid } from '../serialize'

const MAX_CONTENT_LENGTH = 4096

/** Motivos que significam "a porta está fechada agora", não "seu pedido está malformado". */
const CONFLITO = new Set(['lead_optout_ou_inativo', 'canal_inativo', 'conversa_encerrada'])

interface Corpo {
  conversationId?: unknown
  content?: unknown
}

export async function POST(request: Request): Promise<Response> {
  try {
    const ctx = await requireApiKeyWithScope(request, 'messages:send')

    const body = (await request.json().catch(() => null)) as Corpo | null
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : ''
    const content = typeof body?.content === 'string' ? body.content.trim() : ''

    if (!conversationId) throw apiV1BadRequest("'conversationId' is required")
    if (!isUuid(conversationId)) throw apiV1BadRequest("'conversationId' must be a UUID")
    if (!content) throw apiV1BadRequest("'content' is required")
    if (content.length > MAX_CONTENT_LENGTH) {
      throw apiV1BadRequest(`'content' exceeds ${MAX_CONTENT_LENGTH} characters`)
    }

    const { data, error } = await ctx.admin.rpc('whatsapp_oficial_enfileirar_mensagem_api', {
      p_conversation_id: conversationId,
      p_content: content,
      p_api_key_id: ctx.apiKeyId,
    })

    if (error) {
      // A RPC levanta 42501 quando a chave foi revogada/expirou/perdeu escopo entre a
      // autenticação e agora. Ela é a autoridade; aqui só se repassa.
      const codigo = (error as { code?: string }).code
      if (codigo === '42501') {
        throw new ApiV1Error('unauthorized', 401, { message: 'Missing or invalid API key' })
      }
      console.error('[api/v1/messages] RPC de enfileiramento falhou:', error.message)
      throw new Error(error.message)
    }

    const resultado = (data ?? {}) as {
      ok?: boolean
      reason?: string
      message?: Record<string, unknown>
    }

    if (resultado.ok !== true || !resultado.message) {
      const reason = resultado.reason ?? 'message_enqueue_rejected'
      // Conversa de outro tenant volta como 'conversa_nao_encontrada' — mesmo 404 de uma
      // conversa inexistente, para não virar oráculo de ids alheios.
      if (reason === 'conversa_nao_encontrada') throw apiV1NotFound('Conversation not found')
      throw new ApiV1Error(reason, CONFLITO.has(reason) ? 409 : 422)
    }

    const mensagem = resultado.message
    return apiV1Ok(
      {
        enfileirado: true,
        message: {
          id: mensagem.id,
          conversation_id: mensagem.conversation_id,
          direction: mensagem.direction,
          type: mensagem.message_type,
          content: mensagem.content,
          status: mensagem.status,
          created_at: mensagem.created_at,
        },
      },
      201,
    )
  } catch (error) {
    return toApiV1Response(error)
  }
}
