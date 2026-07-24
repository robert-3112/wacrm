import { NextResponse } from 'next/server'
import { requireConversationAccess, toErrorResponse } from '@/lib/whatsapp-oficial/api-auth'
import {
  WHATSAPP_OFICIAL_RATE_LIMITS,
  checkRateLimit,
  rateLimitResponse,
} from '@/lib/whatsapp-oficial/rate-limit'

/**
 * Opt-out action (Fase 6, mission item 6) — marks `leads.status='opt_out'`
 * and `whatsapp_conversations.optout_em` on every official conversation for
 * that lead, via `whatsapp_oficial_registrar_optout` (Fase 5 RPC,
 * `service_role`-gated — same reasoning as the handoff route above).
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params
    const { userId, conversation, admin } = await requireConversationAccess(id)

    const rl = checkRateLimit(
      `whatsapp-oficial-conversation-optout:${userId}`,
      WHATSAPP_OFICIAL_RATE_LIMITS.inboxWriteAction,
    )
    if (!rl.success) return rateLimitResponse(rl)

    const { data, error } = await admin.rpc('whatsapp_oficial_registrar_optout', {
      p_lead_id: conversation.lead_id,
    })

    if (error) {
      console.error('[whatsapp-oficial/conversations/optout] RPC failed:', error.message)
      return NextResponse.json({ error: 'Failed to register opt-out' }, { status: 500 })
    }

    const result = data as { ok: boolean; reason?: string }
    if (!result.ok) {
      return NextResponse.json({ error: result.reason ?? 'optout_rejected' }, { status: 422 })
    }

    return NextResponse.json({ ...result, ok: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
