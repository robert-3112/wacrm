import { NextResponse } from 'next/server'
import {
  requireConversationAccess,
  toErrorResponse,
  BadRequestError,
} from '@/lib/whatsapp-oficial/api-auth'
import {
  WHATSAPP_OFICIAL_RATE_LIMITS,
  checkRateLimit,
  rateLimitResponse,
} from '@/lib/whatsapp-oficial/rate-limit'

/**
 * Send a text reply in an official-channel conversation (Fase 6, mission
 * item 3 — "Composer").
 *
 * WRITTEN FROM SCRATCH for this mission (no WACRM route to adapt — that
 * project's `send-message.ts` calls the Meta Graph API directly, which is
 * explicitly OUT OF SCOPE here). Authorization is `requireConversationAccess`
 * (see that module's doc comment): only the corretor who owns the
 * conversation's lead, or gestão, gets past the RLS-backed check.
 *
 * TODO (future phase, explicitly out of scope here — see
 * docs/runbooks/WHATSAPP-OFFICIAL-OPERACAO.md and the mission brief):
 *   - This route ONLY inserts the message (`status='pendente'`) and enqueues
 *     it into `whatsapp_outbox` (`status='pendente'`). No call to the Meta
 *     Graph API happens here or anywhere in Fase 6 — PROHIBITED by the
 *     mission's security rules. A future outbox worker (mirroring the
 *     pattern already shipped for the CRM's calendar worker) has to drain
 *     `whatsapp_outbox`, call `sendTextMessage` (`lib/whatsapp-oficial/meta-api.ts`,
 *     already written in Fase 4 but unused until that worker exists), and
 *     apply `whatsapp_oficial_registrar_status` idempotently on success/failure.
 *   - Media attachments are not supported by this route yet (text only) —
 *     mission explicitly allows deferring this ("Sem envio real de mídia
 *     nesta fase é aceitável").
 */

const MAX_CONTENT_LENGTH = 4096

interface SendMessageBody {
  conversationId?: unknown
  content?: unknown
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json().catch(() => null)) as SendMessageBody | null
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : ''
    const content = typeof body?.content === 'string' ? body.content.trim() : ''

    if (!conversationId) {
      throw new BadRequestError('conversationId is required')
    }
    if (!content) {
      throw new BadRequestError('content is required')
    }
    if (content.length > MAX_CONTENT_LENGTH) {
      throw new BadRequestError(`content exceeds ${MAX_CONTENT_LENGTH} characters`)
    }

    const { userId, conversation, admin } = await requireConversationAccess(conversationId)

    const rl = checkRateLimit(
      `whatsapp-oficial-message-send:${userId}`,
      WHATSAPP_OFICIAL_RATE_LIMITS.messageSend,
    )
    if (!rl.success) return rateLimitResponse(rl)

    const { data: message, error: insertError } = await admin
      .from('whatsapp_messages')
      .insert({
        tenant_id: conversation.tenant_id,
        conversation_id: conversation.id,
        direction: 'outbound',
        message_type: 'text',
        content,
        status: 'pendente',
        enviado_por: userId,
      })
      .select('id, tenant_id, conversation_id, direction, message_type, content, status, enviado_por, created_at')
      .single()

    if (insertError || !message) {
      console.error('[whatsapp-oficial/messages/send] failed to insert message:', insertError?.message)
      return NextResponse.json({ error: 'Failed to send message' }, { status: 500 })
    }

    const { error: outboxError } = await admin.from('whatsapp_outbox').insert({
      tenant_id: conversation.tenant_id,
      canal_id: conversation.canal_id,
      conversation_id: conversation.id,
      message_id: (message as { id: string }).id,
      tipo: 'mensagem',
      payload: { content, message_type: 'text' },
      status: 'pendente',
    })

    if (outboxError) {
      // The message row already exists — surface the outbox failure but
      // don't roll back the insert. An operator can find `pendente`
      // messages with no matching outbox row and requeue them by hand
      // until the worker exists; failing the whole request here would
      // make the user retry and could enqueue a duplicate visible message.
      console.error('[whatsapp-oficial/messages/send] failed to enqueue outbox row:', outboxError.message)
    }

    const preview = content.length > 200 ? `${content.slice(0, 200)}…` : content
    const { error: previewError } = await admin
      .from('whatsapp_conversations')
      .update({ ultima_mensagem_em: new Date().toISOString(), ultima_mensagem_preview: preview })
      .eq('id', conversation.id)
    if (previewError) {
      console.error('[whatsapp-oficial/messages/send] failed to update conversation preview:', previewError.message)
    }

    return NextResponse.json({ ok: true, message }, { status: 201 })
  } catch (error) {
    return toErrorResponse(error)
  }
}
