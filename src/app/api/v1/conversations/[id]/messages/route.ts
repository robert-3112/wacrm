/**
 * GET /api/v1/conversations/{id}/messages — mensagens de uma conversa (escopo `messages:read`),
 * em ordem cronológica reversa (mais nova primeiro), paginadas por cursor.
 *
 * ⚠️ Substituiu a rota do fork WACRM neste caminho, que lia `conversations`/`messages` por
 * `account_id` — tabelas ausentes no Supabase da SUNT. Ver o relatório da Sessão 3.
 *
 * O dono da conversa é conferido ANTES de qualquer mensagem sair: id de outro tenant e id
 * inexistente devolvem o mesmo 404. Fosse 403 no primeiro caso, a diferença entre as duas
 * respostas seria um oráculo para enumerar conversas alheias.
 *
 * Note que o filtro por tenant é aplicado DUAS vezes — na conversa e de novo nas mensagens.
 * Não é redundância à toa: `whatsapp_messages` carrega o próprio `tenant_id`, e amarrar os dois
 * significa que nem um `conversation_id` que por algum acidente tenha mensagens de outro tenant
 * atravessa daqui.
 */

import {
  requireApiKeyWithScope,
  apiV1Page,
  apiV1NotFound,
  apiV1BadRequest,
  toApiV1Response,
} from '@/lib/whatsapp-oficial/api-key-auth'
import { parseListParams, keysetFilter, buildPage } from '@/lib/api/v1/pagination'
import { API_MESSAGE_SELECT, isUuid, serializeMessage, type RawMessageRow } from '../../../serialize'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const ctx = await requireApiKeyWithScope(request, 'messages:read')
    const { id } = await params

    // Um id fora do formato faria o PostgREST devolver 22P02; 400 explícito é mais honesto.
    if (!isUuid(id)) throw apiV1BadRequest('conversation id must be a UUID')

    const { data: conversa, error: convError } = await ctx.admin
      .from('whatsapp_conversations')
      .select('id')
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .maybeSingle()

    if (convError) {
      console.error('[api/v1/conversations/messages] falha ao checar a conversa:', convError.message)
      throw new Error(convError.message)
    }
    if (!conversa) throw apiV1NotFound('Conversation not found')

    const { limit, cursor } = parseListParams(request)

    let query = ctx.admin
      .from('whatsapp_messages')
      .select(API_MESSAGE_SELECT)
      .eq('tenant_id', ctx.tenantId)
      .eq('conversation_id', id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1)

    const kf = keysetFilter(cursor)
    if (kf) query = query.or(kf)

    const { data, error } = await query
    if (error) {
      console.error('[api/v1/conversations/messages] falha ao listar:', error.message)
      throw new Error(error.message)
    }

    const { items, nextCursor } = buildPage((data ?? []) as unknown as RawMessageRow[], limit)
    return apiV1Page(items.map(serializeMessage), nextCursor)
  } catch (error) {
    return toApiV1Response(error)
  }
}
