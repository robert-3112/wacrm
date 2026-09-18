/** Leitura de um lead que pertence ao tenant da chave e tem conversa neste tenant. */

import {
  apiV1BadRequest,
  apiV1NotFound,
  apiV1Ok,
  requireApiKeyWithScope,
  toApiV1Response,
} from '@/lib/whatsapp-oficial/api-key-auth'
import { API_LEAD_FIELDS, isUuid, serializeContactRow, type RawContactRow } from '../../serialize'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const ctx = await requireApiKeyWithScope(request, 'contacts:read')
    const { id } = await params
    if (!isUuid(id)) throw apiV1BadRequest('contact id must be a UUID')

    // A service_role ignora RLS: os dois lados do vínculo exigem o mesmo tenant.
    const { data: conversation, error: conversationError } = await ctx.admin
      .from('whatsapp_conversations')
      .select('id')
      .eq('tenant_id', ctx.tenantId)
      .eq('lead_id', id)
      .limit(1)
      .maybeSingle()
    if (conversationError) throw new Error(conversationError.message)
    if (!conversation) throw apiV1NotFound('Contact not found')

    const { data: lead, error: leadError } = await ctx.admin
      .from('leads')
      .select(API_LEAD_FIELDS)
      .eq('tenant_id', ctx.tenantId)
      .eq('id', id)
      .maybeSingle()
    if (leadError) throw new Error(leadError.message)
    if (!lead) throw apiV1NotFound('Contact not found')

    const response = apiV1Ok(serializeContactRow(lead as RawContactRow))
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  } catch (error) {
    return toApiV1Response(error)
  }
}
