import { NextResponse } from 'next/server'
import { requireConversationAccess, toErrorResponse } from '@/lib/whatsapp-oficial/api-auth'
import {
  WHATSAPP_OFICIAL_RATE_LIMITS,
  checkRateLimit,
  rateLimitResponse,
} from '@/lib/whatsapp-oficial/rate-limit'

/** Zera não lidas dentro da mesma transação que revalida o acesso. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params
    const { userId, conversation, supabaseUser } = await requireConversationAccess(id)

    const rl = checkRateLimit(
      `whatsapp-oficial-conversation-read:${userId}`,
      WHATSAPP_OFICIAL_RATE_LIMITS.inboxWriteAction,
    )
    if (!rl.success) return rateLimitResponse(rl)

    const { data, error } = await supabaseUser.rpc('whatsapp_oficial_atualizar_conversa', {
      p_conversation_id: conversation.id,
      p_operation: 'read',
      p_status: null,
    })
    if (error) throw error
    if (data?.ok !== true) throw new Error('Conversation read update failed')

    return NextResponse.json({ ok: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
