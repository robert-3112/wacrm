/**
 * GET /api/v1/conversations — lista conversas do canal oficial (escopo `conversations:read`).
 *
 * ⚠️ Esta rota SUBSTITUIU a implementação que o fork WACRM trazia neste mesmo caminho, que
 * consultava `conversations`/`account_id` — tabelas que NÃO existem no Supabase da SUNT
 * (`hokwmparmpwoylyukfnt`), porque as migrations 001-036 do fork nunca foram aplicadas lá. A
 * rota antiga não tinha como responder nada além de erro. Ver o relatório da Sessão 3.
 *
 * Isolamento: o `.eq('tenant_id', ctx.tenantId)` abaixo é a ÚNICA coisa que separa um tenant do
 * outro neste caminho. Não há RLS para servir de rede — o cliente é service_role, porque uma
 * chave de API não tem `auth.uid()` para a política casar. Por isso o filtro vem colado no
 * `.from()`, antes de qualquer filtro opcional.
 *
 * Paginação por cursor (keyset), nunca offset: `whatsapp_conversations` recebe insert
 * concorrente do webhook, e com offset uma conversa nova no topo empurra a lista — a página 2
 * repete uma linha que a página 1 já mostrou e pula outra.
 *
 * Dois detalhes que parecem redundantes e não são:
 *  1. O `.eq(EMBED_TENANT_FILTER, …)` filtra o tenant TAMBÉM dentro do embed de lead. O filtro
 *     da tabela base não alcança o recurso embedado, e não existe FK composta obrigando
 *     `leads.tenant_id = whatsapp_conversations.tenant_id` (ver `EMBED_TENANT_FILTER`).
 *  2. Mesmo assim, `serializeConversation` confere o tenant do lead de novo antes de emitir o
 *     contato. Não é cinto e suspensório por gosto: o filtro de recurso embedado é um
 *     comportamento do PostgREST que some sem erro se a forma do embed mudar (virar `!inner`,
 *     virar duas queries, mudar de versão) — falharia ABERTO, devolvendo o contato do vizinho
 *     com 200. A guarda no serializador falha FECHADO e não depende de versão de biblioteca.
 * O corpo devolvido depende dos escopos da chave; o porquê está em `serialize.ts`.
 */

import {
  requireApiKeyWithScope,
  apiV1Page,
  apiV1BadRequest,
  toApiV1Response,
} from '@/lib/whatsapp-oficial/api-key-auth'
import { parseListParams, keysetFilter, buildPage } from '@/lib/api/v1/pagination'
import {
  API_CONVERSATION_SELECT,
  CONVERSATION_STATUSES,
  EMBED_TENANT_FILTER,
  isUuid,
  serializeConversation,
  type RawConversationRow,
} from '../serialize'

export async function GET(request: Request): Promise<Response> {
  try {
    const ctx = await requireApiKeyWithScope(request, 'conversations:read')

    const url = new URL(request.url)
    const status = url.searchParams.get('status')
    const leadId = url.searchParams.get('lead_id')

    // Validar em vez de repassar: `?status=abert` devolveria lista vazia silenciosamente e o
    // integrador perderia a tarde procurando dado que existe.
    if (status !== null && !(CONVERSATION_STATUSES as readonly string[]).includes(status)) {
      throw apiV1BadRequest(`'status' must be one of: ${CONVERSATION_STATUSES.join(', ')}`)
    }
    if (leadId !== null && !isUuid(leadId)) {
      throw apiV1BadRequest("'lead_id' must be a UUID")
    }

    const { limit, cursor } = parseListParams(request)

    let query = ctx.admin
      .from('whatsapp_conversations')
      .select(API_CONVERSATION_SELECT)
      .eq('tenant_id', ctx.tenantId)
      // Filtro de recurso embedado: `lead.tenant_id=eq.<tenant>`. Sem `!inner`, de propósito —
      // conversa com lead divergente continua listada (ela É do tenant), só perde o contato.
      .eq(EMBED_TENANT_FILTER, ctx.tenantId)

    if (status !== null) query = query.eq('status', status)
    if (leadId !== null) query = query.eq('lead_id', leadId)

    query = query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1) // uma a mais: é assim que se sabe que existe próxima página

    const kf = keysetFilter(cursor)
    if (kf) query = query.or(kf)

    const { data, error } = await query
    if (error) {
      // A mensagem do PostgREST não vai para o fio — `toApiV1Response` colapsa em 500 genérico.
      console.error('[api/v1/conversations] falha ao listar:', error.message)
      throw new Error(error.message)
    }

    const { items, nextCursor } = buildPage(
      (data ?? []) as unknown as RawConversationRow[],
      limit,
    )
    // Escopos explícitos, nunca implícitos: é o que decide se preview e telefone saem.
    return apiV1Page(
      items.map((row) => serializeConversation(row, ctx.escopos)),
      nextCursor,
    )
  } catch (error) {
    return toApiV1Response(error)
  }
}
