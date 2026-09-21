import { NextResponse } from 'next/server'
import { BadRequestError, isPostgrestPermissionError, requireConversationAccess, toErrorResponse } from '@/lib/whatsapp-oficial/api-auth'
import { isAllowlisted } from '@/lib/whatsapp-oficial/allowlist'
import { loadChannelCredential } from '@/lib/whatsapp-oficial/channel-credentials'
import { isSendEnabledFor, readWhatsappFlags } from '@/lib/whatsapp-oficial/env-flags'
import { MetaApiError, uploadMedia } from '@/lib/whatsapp-oficial/meta-api'
import { isInsideFreeFormWindow } from '@/lib/whatsapp-oficial/meta-window'
import { MediaValidationError, validateOutboundMedia } from '@/lib/whatsapp-oficial/outbound-media'
import { WHATSAPP_OFICIAL_RATE_LIMITS, checkRateLimit, rateLimitResponse } from '@/lib/whatsapp-oficial/rate-limit'
import { pauseSophiaForHumanSend } from '@/lib/whatsapp-oficial/sophia-pause'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_MULTIPART_BYTES = 16 * 1024 * 1024 + 256 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

class PayloadTooLargeError extends Error {}

/** Bound streaming multipart input before calling formData(), which buffers it. */
async function readBoundedForm(request: Request): Promise<FormData> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new BadRequestError('Use multipart/form-data')
  const declared = Number(request.headers.get('content-length'))
  if (declared > MAX_MULTIPART_BYTES) throw new PayloadTooLargeError()
  if (!request.body) throw new BadRequestError('Arquivo ausente')

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_MULTIPART_BYTES) {
        await reader.cancel()
        throw new PayloadTooLargeError()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try {
    return await new Request('http://localhost/media', {
      method: 'POST', headers: { 'content-type': contentType }, body: bytes,
    }).formData()
  } catch {
    throw new BadRequestError('Formulário de mídia inválido')
  }
}

function mediaEnabled(): boolean {
  return process.env.WHATSAPP_MEDIA_SEND_ENABLED === 'true' &&
    isSendEnabledFor('meta_cloud', readWhatsappFlags())
}

/** UI capability only. The POST repeats every gate and the RPC is authoritative. */
export async function GET(): Promise<Response> {
  return NextResponse.json({ enabled: mediaEnabled() }, { headers: { 'Cache-Control': 'no-store' } })
}

/** Uploads validated media to Meta, then atomically queues its media ID. No recipient send occurs here. */
export async function POST(request: Request): Promise<Response> {
  try {
    const conversationId = request.headers.get('x-conversation-id') ?? ''
    const requestId = request.headers.get('x-client-request-id') ?? ''
    if (!UUID.test(conversationId) || !UUID.test(requestId)) {
      throw new BadRequestError('conversationId e clientRequestId válidos são obrigatórios')
    }
    const { userId, conversation, admin } = await requireConversationAccess(conversationId)
    const rl = checkRateLimit(`whatsapp-oficial-message-send:${userId}`,
      WHATSAPP_OFICIAL_RATE_LIMITS.messageSend)
    if (!rl.success) return rateLimitResponse(rl)

    const form = await readBoundedForm(request)
    if ([...form.keys()].some((key) => key !== 'file' && key !== 'caption') ||
        form.getAll('file').length !== 1 || form.getAll('caption').length > 1) {
      throw new BadRequestError('Formulário de mídia inválido')
    }
    const file = form.get('file')
    const rawCaption = form.get('caption') ?? ''
    if (!(file instanceof File) || typeof rawCaption !== 'string') {
      throw new BadRequestError('Arquivo e legenda inválidos')
    }
    const media = await validateOutboundMedia(file, rawCaption)
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
    const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')

    // Recover a committed request whose HTTP response was lost, before another
    // upload. A reused request ID with different content is a conflict.
    const { data: existing, error: replayError } = await admin.from('whatsapp_messages')
      .select('id,tenant_id,conversation_id,direction,message_type,content,media_url,media_mime_type,media_filename,media_sha256,status,enviado_por,created_at')
      .eq('tenant_id', conversation.tenant_id)
      .eq('conversation_id', conversation.id)
      .eq('client_request_id', requestId)
      .maybeSingle()
    if (replayError) throw replayError
    if (existing) {
      const storedFilename = media.kind === 'document' ? media.filename : null
      if (existing.enviado_por !== userId || existing.message_type !== media.kind ||
          existing.media_mime_type !== media.mimeType || existing.media_filename !== storedFilename ||
          existing.media_sha256 !== sha256 || (existing.content ?? '') !== media.caption) {
        return NextResponse.json({ error: 'idempotency_conflict' }, { status: 409 })
      }
      return NextResponse.json({ ok: true, message: existing, replayed: true }, { status: 200 })
    }

    if (!mediaEnabled()) {
      return NextResponse.json({ error: 'Envio de mídia indisponível' }, { status: 409 })
    }
    const { data: state, error: stateError } = await admin.from('whatsapp_conversations')
      .select('status,optout_em').eq('id', conversation.id).eq('tenant_id', conversation.tenant_id).maybeSingle()
    if (stateError) throw stateError
    if (!state || state.status === 'encerrada' || state.optout_em) {
      return NextResponse.json({ error: 'Conversa encerrada ou com opt-out' }, { status: 409 })
    }
    const { data: channel, error: channelError } = await admin.from('whatsapp_channels')
      .select('tenant_id,provider,status,phone_number_id')
      .eq('id', conversation.canal_id).eq('tenant_id', conversation.tenant_id).maybeSingle()
    if (channelError) throw channelError
    if (!channel || channel.provider !== 'meta_cloud' || channel.status !== 'ativo' || !channel.phone_number_id) {
      return NextResponse.json({ error: 'Canal oficial indisponível' }, { status: 409 })
    }
    const { data: lead, error: leadError } = await admin.from('leads')
      .select('status_saida,whatsapp').eq('id', conversation.lead_id)
      .eq('tenant_id', conversation.tenant_id).maybeSingle()
    if (leadError) throw leadError
    const flags = readWhatsappFlags()
    if (!lead || lead.status_saida !== 'ativo' || !lead.whatsapp || !isAllowlisted(lead.whatsapp, flags)) {
      return NextResponse.json({ error: 'Contato inativo ou fora do piloto' }, { status: 409 })
    }
    const { data: inbound, error: inboundError } = await admin.from('whatsapp_messages')
      .select('wpp_timestamp').eq('tenant_id', conversation.tenant_id)
      .eq('conversation_id', conversation.id).eq('direction', 'inbound')
      .not('wpp_timestamp', 'is', null)
      .order('wpp_timestamp', { ascending: false }).limit(1).maybeSingle()
    if (inboundError) throw inboundError
    if (!isInsideFreeFormWindow(inbound?.wpp_timestamp)) {
      return NextResponse.json({ error: 'Fora da janela de 24 horas; use um template aprovado' }, { status: 409 })
    }

    const accessToken = await loadChannelCredential(admin, conversation.canal_id, 'meta_cloud')
    let mediaId: string
    try {
      const uploaded = await uploadMedia({
        phoneNumberId: channel.phone_number_id, accessToken, file, filename: media.filename,
      })
      mediaId = uploaded.mediaId
    } catch (error) {
      // Uploading a file never sends a message, so the client may safely retry
      // with the same request id. Do not expose the Meta response or token.
      if (error instanceof MetaApiError && error.httpStatus === 400) {
        const detail = media.kind === 'video'
          ? ' Para vídeo, confira MP4 com H.264/AAC.'
          : media.kind === 'audio'
            ? ' Para áudio, confira o formato MP3.'
            : ''
        return NextResponse.json({ error: `A Meta recusou o arquivo.${detail}` }, { status: 422 })
      }
      return NextResponse.json({ error: 'Falha ao carregar mídia na Meta; tente novamente' }, { status: 502 })
    }
    const sophia = await pauseSophiaForHumanSend(admin, conversation, userId)
    if (sophia instanceof Response) return sophia
    const { data, error } = await admin.rpc('whatsapp_oficial_enfileirar_midia', {
      p_conversation_id: conversation.id,
      p_actor_user_id: userId,
      p_media_id: mediaId,
      p_media_kind: media.kind,
      p_media_mime_type: media.mimeType,
      p_media_filename: media.filename,
      p_caption: media.caption,
      p_client_request_id: requestId,
      p_media_sha256: sha256,
    })
    if (error) {
      if (isPostgrestPermissionError(error)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      console.error('[whatsapp-oficial/messages/media] enqueue RPC failed:', error.message)
      return NextResponse.json({ error: 'Falha ao enfileirar mídia' }, { status: 500 })
    }
    const result = data as { ok?: boolean; reason?: string; message?: Record<string, unknown>; replayed?: boolean } | null
    if (!result?.ok || !result.message) {
      return NextResponse.json({ error: result?.reason ?? 'media_enqueue_rejected' }, { status: 409 })
    }
    return NextResponse.json({ ok: true, message: result.message, replayed: result.replayed === true, ...sophia },
      { status: result.replayed ? 200 : 201 })
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return NextResponse.json({ error: 'Arquivo acima do limite de 16 MB' }, { status: 413 })
    }
    if (error instanceof MediaValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    return toErrorResponse(error)
  }
}
