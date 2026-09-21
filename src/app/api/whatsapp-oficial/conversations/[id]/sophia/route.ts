import { NextResponse } from 'next/server'
import { isUuid } from '@/app/api/v1/serialize'
import {
  BadRequestError,
  NotFoundError,
  requireConversationAccess,
  toErrorResponse,
} from '@/lib/whatsapp-oficial/api-auth'
import {
  WHATSAPP_OFICIAL_RATE_LIMITS,
  checkRateLimit,
  rateLimitResponse,
} from '@/lib/whatsapp-oficial/rate-limit'

type Params = { params: Promise<{ id: string }> }

async function context(params: Params['params']) {
  const { id } = await params
  if (!isUuid(id)) throw new BadRequestError('Conversa inválida.')
  return requireConversationAccess(id)
}

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  try {
    const { conversation, admin } = await context(params)
    const { data: channel, error: channelError } = await admin
      .from('whatsapp_channels')
      .select('provider')
      .eq('id', conversation.canal_id)
      .eq('tenant_id', conversation.tenant_id)
      .maybeSingle()
    if (channelError) throw channelError
    if (!channel) throw new NotFoundError('Canal não encontrado.')

    const { data, error } = await admin
      .from('whatsapp_conversations')
      .select('sophia_ativa, sophia_alterada_em')
      .eq('id', conversation.id)
      .eq('tenant_id', conversation.tenant_id)
      .maybeSingle()
    if (error) throw error
    if (!data) throw new NotFoundError('Conversa não encontrada.')

    return NextResponse.json(
      {
        ok: true,
        supported: channel.provider === 'meta_cloud',
        sophia_ativa: data.sophia_ativa === true,
        sophia_alterada_em: data.sophia_alterada_em,
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  try {
    const body = (await request.json().catch(() => null)) as { ativa?: unknown } | null
    if (typeof body?.ativa !== 'boolean') {
      throw new BadRequestError("'ativa' deve ser um booleano.")
    }
    const { userId, conversation, admin } = await context(params)
    const rl = checkRateLimit(
      `whatsapp-oficial-conversation-sophia:${userId}`,
      WHATSAPP_OFICIAL_RATE_LIMITS.inboxWriteAction,
    )
    if (!rl.success) return rateLimitResponse(rl)

    const { data, error } = await admin.rpc('whatsapp_sophia_definir_estado', {
      p_conversation_id: conversation.id,
      p_actor_user_id: userId,
      p_ativa: body.ativa,
    })
    if (error) throw error
    const result = data as { ok?: boolean; reason?: string; sophia_ativa?: boolean; cancelled_replies?: number; in_flight_replies?: number }
    if (result?.ok !== true) {
      return NextResponse.json({ error: result?.reason ?? 'Alteração recusada.' }, { status: 409 })
    }
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return toErrorResponse(error)
  }
}
