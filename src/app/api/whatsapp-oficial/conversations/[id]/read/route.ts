import { NextResponse } from 'next/server'
import { requireConversationAccess, toErrorResponse } from '@/lib/whatsapp-oficial/api-auth'
import {
  WHATSAPP_OFICIAL_RATE_LIMITS,
  checkRateLimit,
  rateLimitResponse,
} from '@/lib/whatsapp-oficial/rate-limit'

/**
 * Mark a conversation as read — zeroes `whatsapp_conversations.nao_lidas_corretor`
 * (Fase 6, mission item 1: "contagem de não lidas"). Plain UPDATE via the
 * service-role client after the same RLS-backed authorization check every
 * other write route in this directory uses — no RPC needed for a single
 * counter reset (mirrors the mission brief's guidance for
 * encerrar/reabrir: "pode ser um UPDATE direto com o client admin").
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params
    const { userId, conversation, admin } = await requireConversationAccess(id)

    const rl = checkRateLimit(
      `whatsapp-oficial-conversation-read:${userId}`,
      WHATSAPP_OFICIAL_RATE_LIMITS.inboxWriteAction,
    )
    if (!rl.success) return rateLimitResponse(rl)

    const { error } = await admin
      .from('whatsapp_conversations')
      .update({ nao_lidas_corretor: 0 })
      .eq('id', conversation.id)

    if (error) {
      console.error('[whatsapp-oficial/conversations/read] failed to update:', error.message)
      return NextResponse.json({ error: 'Failed to mark as read' }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
