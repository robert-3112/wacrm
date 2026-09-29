import { NextResponse } from 'next/server'
import {
  BadRequestError, isPostgrestPermissionError, NotFoundError,
  requireConversationAccess, requireGestaoSession, toErrorResponse,
} from '@/lib/whatsapp-oficial/api-auth'
import { readConversationWindow } from '@/lib/whatsapp-oficial/conversation-window'
import { checkRateLimit, rateLimitResponse, WHATSAPP_OFICIAL_RATE_LIMITS } from '@/lib/whatsapp-oficial/rate-limit'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_CONTENT_LENGTH = 4096
const enabled = () => process.env.WHATSAPP_PAIR_REPLY_ENABLED === 'true'
type PairRow = { id: string; tenant_id: string; outbound_conversation_id: string; inbound_conversation_id: string }

async function access(pairId: string) {
  if (!UUID.test(pairId)) throw new BadRequestError('Vínculo inválido.')
  const session = await requireGestaoSession() // Authenticated session; SQL owns the role decision.
  const { data: pair, error } = await session.supabaseUser.from('whatsapp_conversation_pairs')
    .select('id,tenant_id,outbound_conversation_id,inbound_conversation_id')
    .eq('id', pairId).maybeSingle()
  if (error || !pair) throw new NotFoundError('Vínculo indisponível para esta sessão.')
  const row = pair as PairRow
  const [outbound, inbound] = await Promise.all([
    requireConversationAccess(row.outbound_conversation_id),
    requireConversationAccess(row.inbound_conversation_id),
  ])
  if (outbound.conversation.tenant_id !== row.tenant_id || inbound.conversation.tenant_id !== row.tenant_id ||
      outbound.conversation.canal_id !== inbound.conversation.canal_id) throw new NotFoundError()
  return { ...session, pair: row, inbound: inbound.conversation, outbound: outbound.conversation }
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await params
    const context = await access(id)
    const limit = checkRateLimit(`whatsapp-pair-reply-window:${context.userId}`, WHATSAPP_OFICIAL_RATE_LIMITS.gestaoList)
    if (!limit.success) return rateLimitResponse(limit)
    const window = await readConversationWindow(context.admin, context.inbound)
    return NextResponse.json({ enabled: enabled(), window }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) { return toErrorResponse(error) }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await params
    const context = await access(id)
    const limit = checkRateLimit(`whatsapp-pair-reply:${context.userId}`, WHATSAPP_OFICIAL_RATE_LIMITS.messageSend)
    if (!limit.success) return rateLimitResponse(limit)
    if (!enabled()) return NextResponse.json({ error: 'Resposta vinculada ainda desabilitada.' }, { status: 403 })
    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(key => key !== 'content' && key !== 'clientRequestId')) throw new BadRequestError('Envie somente texto e identificador da tentativa.')
    const content = typeof body.content === 'string' ? body.content.trim() : ''
    if (!content || content.length > MAX_CONTENT_LENGTH || typeof body.clientRequestId !== 'string' || !UUID.test(body.clientRequestId)) {
      throw new BadRequestError('Texto ou identificador da tentativa inválido.')
    }
    // The authenticated RPC atomically rechecks both leads, opt-outs, actor,
    // Meta identity, inbound window and idempotency. Replay is checked by SQL
    // before its window check, so a late retry can recover the original result.
    // Never send from this route.
    const { data, error } = await context.supabaseUser.rpc('whatsapp_oficial_enfileirar_resposta_par', {
      p_pair_id: context.pair.id,
      p_content: content,
      p_client_request_id: body.clientRequestId,
    })
    if (error) {
      if (isPostgrestPermissionError(error)) return NextResponse.json({ error: 'Sem permissão.' }, { status: 403 })
      if (error.code === '23514' || error.code === '22023') return NextResponse.json({ error: 'Resposta vinculada recusada.' }, { status: 409 })
      console.error('[whatsapp-oficial/pair-reply] enqueue RPC failed:', error.message)
      return NextResponse.json({ error: 'Não foi possível enfileirar a resposta.' }, { status: 502 })
    }
    const result = data as { ok?: boolean; reason?: string; pair_id?: string; conversation_id?: string; message_id?: string; replayed?: boolean } | null
    if (result?.ok !== true || result.pair_id !== context.pair.id ||
        result.conversation_id !== context.inbound.id || !result.message_id || !UUID.test(result.message_id)) {
      return NextResponse.json({ error: result?.ok === false ? 'Resposta vinculada recusada.' : 'Resposta inválida do banco.' }, { status: result?.ok === false ? 409 : 502 })
    }
    return NextResponse.json({ ok: true, messageId: result.message_id, conversationId: context.inbound.id, replayed: result.replayed === true }, { status: result.replayed ? 200 : 201 })
  } catch (error) { return toErrorResponse(error) }
}
