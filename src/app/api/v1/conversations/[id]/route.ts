/** GET /api/v1/conversations/{id} — uma conversa oficial do tenant da chave. */

import {
  apiV1BadRequest,
  apiV1NotFound,
  apiV1Ok,
  requireApiKeyWithScope,
  toApiV1Response,
} from '@/lib/whatsapp-oficial/api-key-auth';
import {
  API_CONVERSATION_SELECT,
  EMBED_TENANT_FILTER,
  isUuid,
  serializeConversation,
  type RawConversationRow,
} from '../../serialize';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const ctx = await requireApiKeyWithScope(request, 'conversations:read');
    const { id } = await params;
    if (!isUuid(id)) throw apiV1BadRequest('conversation id must be a UUID');

    // service_role ignora RLS. O filtro do tenant precisa existir tanto na conversa quanto no
    // lead embutido; serializeConversation ainda valida o tenant do lead antes de publicá-lo.
    const { data, error } = await ctx.admin
      .from('whatsapp_conversations')
      .select(API_CONVERSATION_SELECT)
      .eq('tenant_id', ctx.tenantId)
      .eq('id', id)
      .eq(EMBED_TENANT_FILTER, ctx.tenantId)
      .maybeSingle();

    if (error) {
      console.error('[api/v1/conversations] falha ao ler:', error.message);
      throw new Error(error.message);
    }
    if (!data) throw apiV1NotFound('Conversation not found');

    const response = apiV1Ok(
      serializeConversation(data as unknown as RawConversationRow, ctx.escopos)
    );
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    return toApiV1Response(error);
  }
}
