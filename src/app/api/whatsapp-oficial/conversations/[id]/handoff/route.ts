import { NextResponse } from 'next/server'
import { requireConversationAccess, toErrorResponse } from '@/lib/whatsapp-oficial/api-auth'
import {
  WHATSAPP_OFICIAL_RATE_LIMITS,
  checkRateLimit,
  rateLimitResponse,
} from '@/lib/whatsapp-oficial/rate-limit'

/**
 * Handoff action (Fase 6, mission item 6) — advances the lead to
 * `qualificado` via `whatsapp_oficial_registrar_handoff` (Fase 5 RPC).
 * That RPC is `service_role`-gated (`SECURITY DEFINER`, checks
 * `auth.jwt()->>'role' = 'service_role'`) — it can NEVER be called directly
 * from the client, even by an authenticated corretor. This route is the
 * only legitimate caller: it re-uses `requireConversationAccess` for the
 * "can this user act on this conversation" check (same rule the RPC's own
 * design doc, ADR D10, specifies for `whatsapp_enviar_mensagem`: "só o
 * corretor dono ou gestão"), THEN calls the RPC with the service-role
 * client.
 */

interface HandoffBody {
  empreendimento_interesse_slug?: unknown
  intencao?: unknown
  regiao_interesse?: unknown
  interesse?: unknown
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params
    const body = (await request.json().catch(() => ({}))) as HandoffBody

    const { userId, conversation, admin } = await requireConversationAccess(id)

    const rl = checkRateLimit(
      `whatsapp-oficial-conversation-handoff:${userId}`,
      WHATSAPP_OFICIAL_RATE_LIMITS.inboxWriteAction,
    )
    if (!rl.success) return rateLimitResponse(rl)

    const { data, error } = await admin.rpc('whatsapp_oficial_registrar_handoff', {
      p_lead_id: conversation.lead_id,
      p_empreendimento_interesse_slug: stringOrNull(body.empreendimento_interesse_slug),
      p_intencao: stringOrNull(body.intencao),
      p_regiao_interesse: stringOrNull(body.regiao_interesse),
      p_interesse: stringOrNull(body.interesse),
    })

    if (error) {
      console.error('[whatsapp-oficial/conversations/handoff] RPC failed:', error.message)
      return NextResponse.json({ error: 'Failed to register handoff' }, { status: 500 })
    }

    const result = data as { ok: boolean; reason?: string }
    if (!result.ok) {
      return NextResponse.json({ error: result.reason ?? 'handoff_rejected' }, { status: 422 })
    }

    return NextResponse.json({ ...result, ok: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
