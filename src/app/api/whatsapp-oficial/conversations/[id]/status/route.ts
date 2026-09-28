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
import type { WhatsAppConversationStatus } from '@/types/whatsapp-oficial'

/** Encerrar/reabrir a triagem do Hub com autorização revalidada no banco. */

const VALID_STATUSES: WhatsAppConversationStatus[] = ['aberta', 'pendente', 'encerrada']

interface UpdateStatusBody {
  status?: unknown
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params
    const body = (await request.json().catch(() => null)) as UpdateStatusBody | null
    const status = typeof body?.status === 'string' ? body.status : ''

    if (!VALID_STATUSES.includes(status as WhatsAppConversationStatus)) {
      throw new BadRequestError(`status must be one of: ${VALID_STATUSES.join(', ')}`)
    }

    const { userId, conversation, supabaseUser } = await requireConversationAccess(id)

    const rl = checkRateLimit(
      `whatsapp-oficial-conversation-status:${userId}`,
      WHATSAPP_OFICIAL_RATE_LIMITS.inboxWriteAction,
    )
    if (!rl.success) return rateLimitResponse(rl)

    // A RPC usa auth.uid(), bloqueia as linhas de autorização e atualiza na
    // mesma transação. O SELECT anterior é somente UX; não autoriza o write.
    const { data, error } = await supabaseUser.rpc('whatsapp_oficial_atualizar_conversa', {
      p_conversation_id: conversation.id,
      p_operation: 'status',
      p_status: status,
    })
    if (error) throw error
    if (data?.ok !== true || data.status !== status) throw new Error('Conversation status update failed')

    return NextResponse.json({ ok: true, status })
  } catch (error) {
    return toErrorResponse(error)
  }
}
