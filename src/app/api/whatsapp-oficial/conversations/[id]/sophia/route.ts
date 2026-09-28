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
const CHANNEL_DISABLED = 'Sophia não está habilitada neste número. O atendimento permanece humano.'

async function context(params: Params['params']) {
  const { id } = await params
  if (!isUuid(id)) throw new BadRequestError('Conversa inválida.')
  return requireConversationAccess(id)
}

async function channelState(admin: Awaited<ReturnType<typeof context>>['admin'], conversation: Awaited<ReturnType<typeof context>>['conversation']) {
  const { data, error } = await admin
    .from('whatsapp_channels')
    .select('provider, sophia_permitida')
    .eq('id', conversation.canal_id)
    .eq('tenant_id', conversation.tenant_id)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new NotFoundError('Canal não encontrado.')
  return {
    supported: data.provider === 'meta_cloud' && data.sophia_permitida === true,
    reason: data.provider !== 'meta_cloud'
      ? 'Sophia não está disponível para este tipo de conexão.'
      : CHANNEL_DISABLED,
  }
}

function isChannelDisabled(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const { code, message } = error as { code?: unknown; message?: unknown }
  return code === '23514' && message === 'sophia_nao_permitida_no_canal'
}

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  try {
    const { conversation, admin } = await context(params)
    const channel = await channelState(admin, conversation)

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
        supported: channel.supported,
        reason: channel.supported ? null : channel.reason,
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

    // A pausa continua permitida mesmo se o canal perdeu a permissão.
    if (body.ativa) {
      const channel = await channelState(admin, conversation)
      if (!channel.supported) {
        return NextResponse.json({ error: channel.reason }, { status: 409 })
      }
    }

    const { data, error } = await admin.rpc('whatsapp_sophia_definir_estado', {
      p_conversation_id: conversation.id,
      p_actor_user_id: userId,
      p_ativa: body.ativa,
    })
    if (error) {
      if (isChannelDisabled(error)) {
        return NextResponse.json({ error: CHANNEL_DISABLED }, { status: 409 })
      }
      throw error
    }
    const result = data as { ok?: boolean; reason?: string; sophia_ativa?: boolean; cancelled_replies?: number; in_flight_replies?: number }
    if (result?.ok !== true) {
      return NextResponse.json({ error: result?.reason ?? 'Alteração recusada.' }, { status: 409 })
    }
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return toErrorResponse(error)
  }
}
