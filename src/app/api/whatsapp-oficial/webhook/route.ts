import crypto from 'node:crypto'
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp-oficial/webhook-signature'
import { supabaseAdmin } from '@/lib/whatsapp-oficial/supabase-admin'
import { mapMetaStatusToDb, shouldApplyStatusTransition } from '@/lib/whatsapp-oficial/status'
import { isValidLeadPhone, normalizePhoneDigits } from '@/lib/whatsapp-oficial/phone'
import {
  WHATSAPP_OFICIAL_RATE_LIMITS,
  checkRateLimit,
  rateLimitResponse,
} from '@/lib/whatsapp-oficial/rate-limit'

/**
 * Meta WhatsApp Cloud API webhook (official channel).
 *
 * GET  — hub.challenge verification (ADAPTED from WACRM's per-account loop
 *        in `src/app/api/whatsapp/webhook/route.ts`: `whatsapp_channels` has
 *        no `verify_token` column in the SUNT schema — a single shared
 *        `META_WEBHOOK_VERIFY_TOKEN` env var is compared instead, matching
 *        `docs/runbooks/META-CLOUD-SETUP-SUNT.md` step 2, which documents
 *        it as "você escolhe essa string", not per-channel Meta config).
 * POST — inbound message + status events. Idempotent insert-first into
 *        `whatsapp_webhook_events` (ADR D7) BEFORE any side-effect write;
 *        status transitions never regress (ADR D7, via
 *        `public.whatsapp_status_rank`). WRITTEN FROM SCRATCH — the WACRM
 *        upstream has neither of these on `main` (harvest matrix area 3,
 *        items "Idempotência por wamid" and the `messages` status mirror
 *        gap).
 *
 * Deliberately does NOT use Next's `after()` (unlike the WACRM original,
 * which needs it to survive a Vercel serverless freeze after the response
 * flushes — see the harvest matrix note on issue #301). SUNT-WA-Hub runs
 * as a long-lived Node process on Coolify, not serverless, and processing
 * fully before responding both matches the deployment target and makes
 * the whole pipeline directly testable (no fake request-scope needed for
 * `after()` in tests). If a bug throws mid-processing anyway, the raw
 * event already landed in `whatsapp_webhook_events` (inserted before any
 * downstream write) — see `whatsapp_webhook_events_unprocessed_idx` for
 * the reprocessing/audit trail this leaves.
 */

// ============================================================
// Meta payload shape (only the fields this route reads)
// ============================================================

interface MetaWebhookMessage {
  id: string
  from: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  location?: { latitude: number; longitude: number; name?: string; address?: string }
  contacts?: unknown
  interactive?: {
    type: string
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
  }
}

interface MetaWebhookStatus {
  id: string
  status: string
  timestamp: string
  recipient_id: string
  errors?: Array<{ code: number; title?: string; message?: string }>
}

interface MetaWebhookChangeValue {
  messaging_product?: string
  metadata: { display_phone_number: string; phone_number_id: string }
  contacts?: Array<{ profile: { name: string }; wa_id: string }>
  messages?: MetaWebhookMessage[]
  statuses?: MetaWebhookStatus[]
}

interface MetaWebhookEntry {
  id: string
  changes: Array<{ field: string; value: MetaWebhookChangeValue }>
}

export interface MetaWebhookBody {
  object?: string
  entry?: MetaWebhookEntry[]
}

interface ChannelRow {
  id: string
  tenant_id: string
  status: string
}

// Meta sends these on a different change.field with a different value
// shape (template id / waba id, not phone_number_id + messages/statuses).
// Fase 7 owns the actual handler (writing whatsapp_templates.status_aprovacao
// / quality_score) — the routing skeleton is kept here so these events
// don't fall through and get misparsed as messaging changes (harvest
// matrix area 3: "é grátis incluir o roteamento mesmo sem implementar o
// handler ainda").
const TEMPLATE_LIFECYCLE_FIELDS = new Set([
  'message_template_status_update',
  'message_template_quality_update',
  'message_template_components_update',
])

// ============================================================
// GET — hub.challenge verification
// ============================================================

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url)
  const mode = searchParams.get('hub.mode')
  const challenge = searchParams.get('hub.challenge')
  const token = searchParams.get('hub.verify_token')

  if (mode !== 'subscribe' || !challenge || !token) {
    return NextResponse.json({ error: 'Missing verification parameters' }, { status: 400 })
  }

  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN
  if (!expected) {
    console.error(
      '[whatsapp-oficial/webhook] META_WEBHOOK_VERIFY_TOKEN is not set — rejecting ' +
        'verification (fail-closed).',
    )
    return NextResponse.json({ error: 'Verification not configured' }, { status: 403 })
  }

  if (!timingSafeStringEqual(token, expected)) {
    return NextResponse.json({ error: 'Verification token mismatch' }, { status: 403 })
  }

  return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

// ============================================================
// POST — inbound events
// ============================================================

export async function POST(request: Request): Promise<Response> {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const rl = checkRateLimit(
    `whatsapp-oficial-webhook:${ip}`,
    WHATSAPP_OFICIAL_RATE_LIMITS.webhookInbound,
  )
  if (!rl.success) return rateLimitResponse(rl)

  // Read the raw body BEFORE any JSON parsing — Meta signs the exact bytes;
  // reserializing (request.json()) would break the HMAC comparison.
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    console.warn('[whatsapp-oficial/webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: MetaWebhookBody
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  try {
    await processWebhookBody(body, supabaseAdmin())
  } catch (error) {
    // Never let a processing bug turn into a Meta retry-storm — the raw
    // event is already durably recorded (insert-first, before any
    // downstream write) by the time any of this can throw, so there's
    // nothing gained by making Meta believe the delivery failed.
    console.error('[whatsapp-oficial/webhook] unhandled processing error:', error)
  }

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

/** Postgres unique_violation SQLSTATE — the signal that insert-first dedup caught a replay. */
function isUniqueViolation(error: { code?: string } | null | undefined): boolean {
  return error?.code === '23505'
}

export async function processWebhookBody(
  body: MetaWebhookBody,
  admin: SupabaseClient,
): Promise<void> {
  if (!body.entry) return

  for (const entry of body.entry) {
    for (const change of entry.changes ?? []) {
      if (TEMPLATE_LIFECYCLE_FIELDS.has(change.field)) {
        console.info(
          `[whatsapp-oficial/webhook] template lifecycle event (${change.field}) — ` +
            'Fase 7 TODO, skipped (routing preserved so it does not fall through as a messaging change).',
        )
        continue
      }
      await processMessagingChange(change.value, admin)
    }
  }
}

async function processMessagingChange(
  value: MetaWebhookChangeValue,
  admin: SupabaseClient,
): Promise<void> {
  const phoneNumberId = value.metadata?.phone_number_id
  if (!phoneNumberId) return

  const { data: channels, error: channelError } = await admin
    .from('whatsapp_channels')
    .select('id, tenant_id, status')
    .eq('phone_number_id', phoneNumberId)

  if (channelError) {
    console.error(
      '[whatsapp-oficial/webhook] failed to look up channel for phone_number_id:',
      phoneNumberId,
      channelError.message,
    )
    return
  }
  if (!channels || channels.length === 0) {
    console.error(
      '[whatsapp-oficial/webhook] no whatsapp_channels row for phone_number_id — event dropped ' +
        '(cannot log to whatsapp_webhook_events either, canal_id is required):',
      phoneNumberId,
    )
    return
  }
  if (channels.length > 1) {
    console.error(
      `[whatsapp-oficial/webhook] ${channels.length} channels matched phone_number_id ` +
        `${phoneNumberId} — dropping event to avoid ambiguous tenancy.`,
    )
    return
  }
  const channel = channels[0] as ChannelRow

  const contacts = value.contacts ?? []
  for (const message of value.messages ?? []) {
    const contact = contacts.find((c) => c.wa_id === message.from) ?? contacts[0]
    await processInboundMessage(message, contact, channel, admin)
  }

  for (const status of value.statuses ?? []) {
    await processStatusEvent(status, channel, admin)
  }
}

async function markEventProcessed(
  admin: SupabaseClient,
  canalId: string,
  eventType: string,
  externalId: string,
  processingError: string | null,
): Promise<void> {
  const { error } = await admin
    .from('whatsapp_webhook_events')
    .update({ processed_at: new Date().toISOString(), processing_error: processingError })
    .eq('canal_id', canalId)
    .eq('event_type', eventType)
    .eq('external_id', externalId)
  if (error) {
    console.error('[whatsapp-oficial/webhook] failed to mark event processed:', error.message)
  }
}

async function processInboundMessage(
  message: MetaWebhookMessage,
  contact: { profile: { name: string }; wa_id: string } | undefined,
  channel: ChannelRow,
  admin: SupabaseClient,
): Promise<void> {
  const externalId = message.id

  // Insert-first (ADR D7): try to record the raw event BEFORE any
  // processing. A unique-constraint conflict means we've already seen
  // this exact message id for this channel — a Meta replay — and we
  // return without touching whatsapp_conversations/whatsapp_messages again.
  const { error: insertEventError } = await admin.from('whatsapp_webhook_events').insert({
    tenant_id: channel.tenant_id,
    canal_id: channel.id,
    event_type: 'message',
    external_id: externalId,
    payload: { message, contact },
  })

  if (insertEventError) {
    if (isUniqueViolation(insertEventError)) {
      console.info(
        '[whatsapp-oficial/webhook] duplicate inbound message ignored (idempotent replay):',
        externalId,
      )
      return
    }
    console.error(
      '[whatsapp-oficial/webhook] failed to record inbound message webhook event:',
      insertEventError.message,
    )
    return
  }

  if (channel.status !== 'ativo') {
    await markEventProcessed(
      admin,
      channel.id,
      'message',
      externalId,
      'canal inativo/pausado — evento apenas registrado',
    )
    return
  }

  const phone = normalizePhoneDigits(message.from)
  if (!isValidLeadPhone(phone)) {
    await markEventProcessed(
      admin,
      channel.id,
      'message',
      externalId,
      `telefone invalido (esperado ^[0-9]{10,15}$): ${message.from}`,
    )
    return
  }

  const { data: lead, error: leadError } = await admin
    .from('leads')
    .select('id')
    .eq('tenant_id', channel.tenant_id)
    .eq('whatsapp', phone)
    .maybeSingle()

  if (leadError) {
    console.error('[whatsapp-oficial/webhook] failed to look up lead by phone:', leadError.message)
    return
  }

  if (!lead) {
    // TODO (Fase 5): once `whatsapp_oficial_criar_lead_inbound` exists,
    // call it here to create the lead and retry conversation resolution
    // in the same pass. Until then, the raw event above is durably
    // recorded (see whatsapp_webhook_events_unprocessed_idx) so a Fase 5
    // backfill job can find and reprocess every inbound message that
    // arrived before its lead existed — nothing is lost, just deferred.
    await markEventProcessed(
      admin,
      channel.id,
      'message',
      externalId,
      `lead nao encontrado para o telefone ${phone} — aguardando RPC ` +
        'whatsapp_oficial_criar_lead_inbound (Fase 5)',
    )
    return
  }

  const conversation = await findOrCreateConversation(admin, channel, lead.id as string)
  if (!conversation) {
    await markEventProcessed(
      admin,
      channel.id,
      'message',
      externalId,
      'falha ao resolver/criar whatsapp_conversations',
    )
    return
  }

  const { messageType, content, mediaUrl, mediaMimeType } = parseMessageContent(message)

  const { error: msgInsertError } = await admin.from('whatsapp_messages').insert({
    tenant_id: channel.tenant_id,
    conversation_id: conversation.id,
    wamid: message.id,
    direction: 'inbound',
    message_type: messageType,
    content,
    media_url: mediaUrl,
    media_mime_type: mediaMimeType,
    status: 'recebida',
    raw_payload: { message, contact },
    wpp_timestamp: new Date(Number(message.timestamp) * 1000).toISOString(),
  })

  if (msgInsertError) {
    // Defense-in-depth: whatsapp_webhook_events dedup above should already
    // have caught a replay, but whatsapp_messages also carries its own
    // UNIQUE(tenant_id, wamid) — treat a conflict here as the same
    // "already processed" outcome rather than an error.
    if (!isUniqueViolation(msgInsertError)) {
      console.error(
        '[whatsapp-oficial/webhook] failed to insert whatsapp_messages:',
        msgInsertError.message,
      )
    }
    await markEventProcessed(
      admin,
      channel.id,
      'message',
      externalId,
      isUniqueViolation(msgInsertError) ? 'duplicado (unique wamid)' : msgInsertError.message,
    )
    return
  }

  const preview = content ? content.slice(0, 200) : `[${messageType}]`
  const { error: convUpdateError } = await admin
    .from('whatsapp_conversations')
    .update({
      ultima_mensagem_em: new Date().toISOString(),
      ultima_mensagem_preview: preview,
      nao_lidas_corretor: (conversation.nao_lidas_corretor ?? 0) + 1,
    })
    .eq('id', conversation.id)
  if (convUpdateError) {
    console.error(
      '[whatsapp-oficial/webhook] failed to update conversation preview/unread count:',
      convUpdateError.message,
    )
  }

  await markEventProcessed(admin, channel.id, 'message', externalId, null)
}

interface ConversationRow {
  id: string
  nao_lidas_corretor: number | null
}

async function findOrCreateConversation(
  admin: SupabaseClient,
  channel: ChannelRow,
  leadId: string,
): Promise<ConversationRow | null> {
  const { data: existing, error: findError } = await admin
    .from('whatsapp_conversations')
    .select('id, nao_lidas_corretor')
    .eq('tenant_id', channel.tenant_id)
    .eq('canal_id', channel.id)
    .eq('lead_id', leadId)
    .maybeSingle()

  if (findError) {
    console.error('[whatsapp-oficial/webhook] failed to look up conversation:', findError.message)
    return null
  }
  if (existing) return existing as ConversationRow

  const { data: created, error: createError } = await admin
    .from('whatsapp_conversations')
    .insert({ tenant_id: channel.tenant_id, canal_id: channel.id, lead_id: leadId })
    .select('id, nao_lidas_corretor')
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      // Lost a race with a concurrent delivery for the same (canal, lead) —
      // re-select the row the other request created instead of failing.
      const { data: raced } = await admin
        .from('whatsapp_conversations')
        .select('id, nao_lidas_corretor')
        .eq('tenant_id', channel.tenant_id)
        .eq('canal_id', channel.id)
        .eq('lead_id', leadId)
        .maybeSingle()
      return (raced as ConversationRow | null) ?? null
    }
    console.error('[whatsapp-oficial/webhook] failed to create conversation:', createError.message)
    return null
  }

  return created as ConversationRow
}

interface ParsedMessageContent {
  messageType: string
  content: string | null
  mediaUrl: string | null
  mediaMimeType: string | null
}

/** Relay path served by `src/app/api/whatsapp-oficial/media/[mediaId]/route.ts`. */
function mediaRelayUrl(mediaId: string): string {
  return `/api/whatsapp-oficial/media/${mediaId}`
}

function parseMessageContent(message: MetaWebhookMessage): ParsedMessageContent {
  const empty: ParsedMessageContent = {
    messageType: 'unsupported',
    content: null,
    mediaUrl: null,
    mediaMimeType: null,
  }

  switch (message.type) {
    case 'text':
      return { ...empty, messageType: 'text', content: message.text?.body ?? null }

    case 'image':
      if (message.image?.id) {
        return {
          messageType: 'image',
          content: message.image.caption ?? null,
          mediaUrl: mediaRelayUrl(message.image.id),
          mediaMimeType: message.image.mime_type ?? null,
        }
      }
      return empty

    case 'video':
      if (message.video?.id) {
        return {
          messageType: 'video',
          content: message.video.caption ?? null,
          mediaUrl: mediaRelayUrl(message.video.id),
          mediaMimeType: message.video.mime_type ?? null,
        }
      }
      return empty

    case 'document':
      if (message.document?.id) {
        return {
          messageType: 'document',
          content: message.document.caption ?? message.document.filename ?? null,
          mediaUrl: mediaRelayUrl(message.document.id),
          mediaMimeType: message.document.mime_type ?? null,
        }
      }
      return empty

    case 'audio':
      if (message.audio?.id) {
        return {
          ...empty,
          messageType: 'audio',
          mediaUrl: mediaRelayUrl(message.audio.id),
          mediaMimeType: message.audio.mime_type ?? null,
        }
      }
      return empty

    case 'sticker':
      if (message.sticker?.id) {
        return {
          ...empty,
          messageType: 'sticker',
          mediaUrl: mediaRelayUrl(message.sticker.id),
          mediaMimeType: message.sticker.mime_type ?? null,
        }
      }
      return empty

    case 'location':
      if (message.location) {
        const { latitude, longitude, name, address } = message.location
        const text = [name, address, `${latitude},${longitude}`].filter(Boolean).join(' - ')
        return { ...empty, messageType: 'location', content: text }
      }
      return empty

    case 'contacts':
      return { ...empty, messageType: 'contacts' }

    case 'interactive': {
      const reply = message.interactive?.button_reply ?? message.interactive?.list_reply
      return { ...empty, messageType: 'interactive', content: reply?.title ?? reply?.id ?? null }
    }

    default:
      return { ...empty, content: `[Tipo nao suportado: ${message.type}]` }
  }
}

async function processStatusEvent(
  status: MetaWebhookStatus,
  channel: ChannelRow,
  admin: SupabaseClient,
): Promise<void> {
  // Composite dedup key — see module doc comment. Meta reuses `status.id`
  // (the wamid) across every transition of the same message (sent, then
  // delivered, then read all share the same id); folding in status +
  // timestamp gives each real transition its own row while still catching
  // a literal re-delivery of the exact same event. Not specified by the
  // schema — a deliberate design decision made for this mission.
  const externalId = `${status.id}:${status.status}:${status.timestamp}`

  const { error: insertEventError } = await admin.from('whatsapp_webhook_events').insert({
    tenant_id: channel.tenant_id,
    canal_id: channel.id,
    event_type: 'status',
    external_id: externalId,
    payload: status,
  })

  if (insertEventError) {
    if (isUniqueViolation(insertEventError)) {
      console.info(
        '[whatsapp-oficial/webhook] duplicate status event ignored (idempotent replay):',
        externalId,
      )
      return
    }
    console.error(
      '[whatsapp-oficial/webhook] failed to record status webhook event:',
      insertEventError.message,
    )
    return
  }

  if (channel.status !== 'ativo') {
    await markEventProcessed(
      admin,
      channel.id,
      'status',
      externalId,
      'canal inativo/pausado — evento apenas registrado',
    )
    return
  }

  const mapped = mapMetaStatusToDb(status.status)
  if (!mapped) {
    await markEventProcessed(
      admin,
      channel.id,
      'status',
      externalId,
      `status Meta nao reconhecido: ${status.status}`,
    )
    return
  }

  const { data: msg, error: msgError } = await admin
    .from('whatsapp_messages')
    .select('id, status')
    .eq('tenant_id', channel.tenant_id)
    .eq('wamid', status.id)
    .maybeSingle()

  if (msgError) {
    console.error(
      '[whatsapp-oficial/webhook] failed to look up message for status update:',
      msgError.message,
    )
    return
  }
  if (!msg) {
    await markEventProcessed(
      admin,
      channel.id,
      'status',
      externalId,
      `whatsapp_messages nao encontrada para wamid ${status.id}`,
    )
    return
  }

  // Fetch both ranks from the single source of truth — public.whatsapp_status_rank
  // — rather than re-deriving them in TypeScript, per the mission spec.
  const [currentRankResult, incomingRankResult] = await Promise.all([
    admin.rpc('whatsapp_status_rank', { p_status: msg.status }),
    admin.rpc('whatsapp_status_rank', { p_status: mapped }),
  ])
  if (currentRankResult.error || incomingRankResult.error) {
    console.error(
      '[whatsapp-oficial/webhook] whatsapp_status_rank RPC failed:',
      currentRankResult.error?.message ?? incomingRankResult.error?.message,
    )
    return
  }
  const currentRank = Number(currentRankResult.data)
  const incomingRank = Number(incomingRankResult.data)

  if (shouldApplyStatusTransition(msg.status as string, currentRank, mapped, incomingRank)) {
    const update: Record<string, unknown> = { status: mapped }
    if (mapped === 'falhou' && status.errors?.[0]) {
      update.erro_code = String(status.errors[0].code)
      update.erro_detalhe = status.errors[0].message ?? status.errors[0].title ?? null
    }
    const { error: updateError } = await admin
      .from('whatsapp_messages')
      .update(update)
      .eq('id', msg.id)
    if (updateError) {
      console.error(
        '[whatsapp-oficial/webhook] failed to update whatsapp_messages status:',
        updateError.message,
      )
    }
  }

  const { error: eventInsertError } = await admin.from('whatsapp_message_events').insert({
    tenant_id: channel.tenant_id,
    message_id: msg.id,
    meta_status_id: `${status.id}:${status.status}`,
    tipo: status.status,
    detalhe: { status },
    ocorrido_em: new Date(Number(status.timestamp) * 1000).toISOString(),
  })
  if (eventInsertError && !isUniqueViolation(eventInsertError)) {
    console.error(
      '[whatsapp-oficial/webhook] failed to insert whatsapp_message_events:',
      eventInsertError.message,
    )
  }

  await markEventProcessed(admin, channel.id, 'status', externalId, null)
}
