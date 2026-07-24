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

/**
 * Encerrar/reabrir uma conversa (Fase 6, mission item 6). Plain UPDATE via
 * the service-role client — the mission brief explicitly says this doesn't
 * need a new RPC ("pode ser um UPDATE direto com o client admin"), unlike
 * handoff/opt-out which are RPC-gated because they also touch `public.leads`.
 * `whatsapp_conversations.status` is a triage field ownedentirely by the
 * Hub (harvest matrix area 7: "distinto do funil comercial de leads.status/
 * etapa" — the two never sync automatically).
 */

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

    const { userId, conversation, admin } = await requireConversationAccess(id)

    const rl = checkRateLimit(
      `whatsapp-oficial-conversation-status:${userId}`,
      WHATSAPP_OFICIAL_RATE_LIMITS.inboxWriteAction,
    )
    if (!rl.success) return rateLimitResponse(rl)

    const { error } = await admin
      .from('whatsapp_conversations')
      .update({ status })
      .eq('id', conversation.id)

    if (error) {
      console.error('[whatsapp-oficial/conversations/status] failed to update:', error.message)
      return NextResponse.json({ error: 'Failed to update status' }, { status: 500 })
    }

    return NextResponse.json({ ok: true, status })
  } catch (error) {
    return toErrorResponse(error)
  }
}
