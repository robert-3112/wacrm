/**
 * GET /api/v1/contacts — leads que têm conversa no canal oficial (escopo `contacts:read`),
 * paginados por cursor.
 *
 * ⚠️ Substituiu a rota do fork WACRM neste caminho, que lia/escrevia a tabela `contacts` por
 * `account_id` — inexistente no Supabase da SUNT. O POST (escopo `contacts:write`) que existia
 * ali NÃO foi reescrito: criar lead no CRM da SUNT passa por regras de rodízio/atribuição que
 * são de outra frente, e um endpoint público que cria lead sem dono definido é exatamente o
 * tipo de coisa que não se improvisa. O escopo `contacts:write` continua válido no CHECK do
 * banco, apenas não tem rota ainda. Ver o relatório da Sessão 3.
 *
 * "Contato" aqui é deliberadamente um subconjunto de `leads`: só quem tem conversa no canal
 * oficial. Expor a base de leads inteira por uma chave de API seria exportar o CRM, não a
 * caixa de entrada — e o `!inner` abaixo é o que faz essa diferença.
 *
 * Isolamento: `.eq('tenant_id', ctx.tenantId)` sobre `leads`. Como em toda rota desta API o
 * cliente é service_role, esse filtro é a separação inteira entre tenants.
 */

import {
  requireApiKeyWithScope,
  apiV1Page,
  toApiV1Response,
} from '@/lib/whatsapp-oficial/api-key-auth'
import { parseListParams, keysetFilter, buildPage } from '@/lib/api/v1/pagination'
import { API_LEAD_FIELDS, serializeContactRow, type RawContactRow } from '../serialize'

export async function GET(request: Request): Promise<Response> {
  try {
    const ctx = await requireApiKeyWithScope(request, 'contacts:read')
    const { limit, cursor } = parseListParams(request)

    let query = ctx.admin
      .from('leads')
      // `!inner` = só leads COM conversa. Sem ele o embed viraria left join e a lista traria
      // a base inteira de leads do tenant, com `[]` no lugar da conversa.
      .select(`${API_LEAD_FIELDS}, whatsapp_conversations!inner ( id )`)
      .eq('tenant_id', ctx.tenantId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1)

    const kf = keysetFilter(cursor)
    if (kf) query = query.or(kf)

    const { data, error } = await query
    if (error) {
      console.error('[api/v1/contacts] falha ao listar:', error.message)
      throw new Error(error.message)
    }

    const { items, nextCursor } = buildPage((data ?? []) as unknown as RawContactRow[], limit)
    return apiV1Page(items.map(serializeContactRow), nextCursor)
  } catch (error) {
    return toApiV1Response(error)
  }
}
