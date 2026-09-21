/** GET /api/v1/messages/{id} — leitura pontual após um evento de webhook sem conteúdo. */

import {
  apiV1BadRequest,
  apiV1NotFound,
  apiV1Ok,
  requireApiKeyWithScope,
  toApiV1Response,
} from '@/lib/whatsapp-oficial/api-key-auth';
import {
  API_MESSAGE_SELECT,
  isUuid,
  serializeMessage,
  type RawMessageRow,
} from '../../serialize';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const ctx = await requireApiKeyWithScope(request, 'messages:read');
    const { id } = await params;
    if (!isUuid(id)) throw apiV1BadRequest('message id must be a UUID');

    const { data: message, error: messageError } = await ctx.admin
      .from('whatsapp_messages')
      .select(API_MESSAGE_SELECT)
      .eq('tenant_id', ctx.tenantId)
      .eq('id', id)
      .maybeSingle();

    if (messageError) {
      console.error(
        '[api/v1/messages] falha ao ler mensagem:',
        messageError.message
      );
      throw new Error(messageError.message);
    }
    if (!message) throw apiV1NotFound('Message not found');

    // Mesmo que uma linha esteja ligada por engano a uma conversa de outro tenant, a chave
    // nunca recebe seu conteúdo. A service_role não aplica RLS a nenhuma das duas consultas.
    const raw = message as unknown as RawMessageRow;
    if (!raw.conversation_id || !isUuid(raw.conversation_id)) {
      throw apiV1NotFound('Message not found');
    }
    const { data: conversation, error: conversationError } = await ctx.admin
      .from('whatsapp_conversations')
      .select('id')
      .eq('tenant_id', ctx.tenantId)
      .eq('id', raw.conversation_id)
      .maybeSingle();

    if (conversationError) {
      console.error(
        '[api/v1/messages] falha ao checar conversa:',
        conversationError.message
      );
      throw new Error(conversationError.message);
    }
    if (!conversation) throw apiV1NotFound('Message not found');

    const response = apiV1Ok(serializeMessage(raw));
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    return toApiV1Response(error);
  }
}
