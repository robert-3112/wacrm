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
 * Queue a text reply for an official-channel conversation.
 *
 * Authorization is checked twice:
 * 1. `requireConversationAccess` proves the user can see the conversation via RLS.
 * 2. `whatsapp_oficial_enfileirar_mensagem` revalidates actor/tenant/owner in Postgres.
 *
 * The RPC inserts the message, outbox row and conversation preview atomically.
 * No Meta Graph API call happens here; the future outbox worker owns delivery.
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

    if (!conversationId) throw new BadRequestError('conversationId is required')
    if (!content) throw new BadRequestError('content is required')
    if (content.length > MAX_CONTENT_LENGTH) {
      throw new BadRequestError(`content exceeds ${MAX_CONTENT_LENGTH} characters`)
    }

    const { userId, conversation, admin } = await requireConversationAccess(conversationId)

    const rl = checkRateLimit(
      `whatsapp-oficial-message-send:${userId}`,
      WHATSAPP_OFICIAL_RATE_LIMITS.messageSend,
    )
    if (!rl.success) return rateLimitResponse(rl)

    const { data, error } = await admin.rpc('whatsapp_oficial_enfileirar_mensagem', {
      p_conversation_id: conversation.id,
      p_content: content,
      p_actor_user_id: userId,
    })

    if (error) {
      console.error('[whatsapp-oficial/messages/send] atomic enqueue RPC failed:', error.message)
      return NextResponse.json({ error: 'Failed to queue message' }, { status: 500 })
    }

    const result = data as {
      ok: boolean
      reason?: string
      message?: Record<string, unknown>
    }
    if (!result?.ok || !result.message) {
      const status =
        result?.reason === 'lead_optout_ou_inativo' ||
        result?.reason === 'canal_inativo' ||
        result?.reason === 'conversa_encerrada'
          ? 409
          : 422
      return NextResponse.json({ error: result?.reason ?? 'message_enqueue_rejected' }, { status })
    }

    return NextResponse.json({ ok: true, message: result.message }, { status: 201 })
  } catch (error) {
    return toErrorResponse(error)
  }
}
