import crypto from 'node:crypto'
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp-oficial/webhook-signature'
import { supabaseAdmin } from '@/lib/whatsapp-oficial/supabase-admin'
import { mapMetaStatusToDb } from '@/lib/whatsapp-oficial/status'
import { normalizeQualityScore } from '@/lib/whatsapp-oficial/meta-templates'
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
 * POST — inbound message + status + template-lifecycle events. Idempotent insert-first into
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
 * the audit trail this leaves. Esse índice é AUDITORIA, não fila: nada
 * neste repositório varre `processed_at IS NULL`, então quem retoma um
 * evento falho é a redelivery da Meta — e ela só acontece se a resposta
 * for non-2xx (ver `processWebhookBody`, que coleta as falhas do lote e
 * devolve 503 no fim).
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
  document?: {
    id: string
    mime_type: string
    filename?: string
    caption?: string
  }
  audio?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  location?: {
    latitude: number
    longitude: number
    name?: string
    address?: string
  }
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

/**
 * `message_template_*` events carry a completely different `value` shape:
 * no `metadata.phone_number_id`, no `messages`/`statuses`. The channel is
 * resolved from the WABA id in `entry.id` instead (see
 * `processTemplateLifecycleChange`).
 *
 * ADAPTED from `src/lib/whatsapp/template-webhook.ts` (WACRM) — the field
 * names are Meta's, but the WACRM handler keys off `meta_template_id` to
 * UPDATE its account-scoped `message_templates` table directly. Here the
 * key is (tenant, canal, nome, idioma) and the write goes through the
 * `whatsapp_oficial_registrar_status_template` RPC, because
 * `whatsapp_templates` is tenant-scoped and only service_role may touch it.
 */
interface MetaTemplateLifecycleValue {
  /** Only on message_template_status_update — APPROVED / REJECTED / PAUSED / ... */
  event?: string
  message_template_id?: string | number
  message_template_name?: string
  message_template_language?: string
  reason?: string
  /** Only on message_template_quality_update. */
  new_quality_score?: string | { score?: string }
  previous_quality_score?: string | { score?: string }
}

interface MetaWebhookEntry {
  id: string
  /** Unix seconds. Part of the template dedup key — Meta omits it on some deliveries. */
  time?: number
  changes: Array<{ field: string; value: MetaWebhookChangeValue | MetaTemplateLifecycleValue }>
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
// shape (template name/language + waba id, not phone_number_id +
// messages/statuses), so they must never fall through to
// `processMessagingChange` and get misparsed as messaging changes.
//
// ─── Requisito de configuração (fora de banda) ────────────────────
// Estes três campos NÃO vêm assinados por padrão. No Meta App Dashboard →
// WhatsApp → Configuration → Webhooks é preciso marcar cada um na mão (não
// há API para isso em apps Cloud API). Enquanto não estiverem marcados, o
// status de template só chega pelo sync manual — que continua sendo o único
// caminho que CRIA linha, porque o webhook não carrega os componentes.
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

  return new Response(challenge, {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  })
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
    // The raw event is durable. A 503 asks Meta to redeliver; insert-first
    // dedup resumes only rows that still have processed_at = null.
    console.error('[whatsapp-oficial/webhook] processing failed; requesting redelivery:', error)
    return NextResponse.json({ error: 'Temporary processing failure' }, { status: 503 })
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

  // Uma falha em UMA change não derruba as outras — mensagem inbound é dado do
  // cliente e não se recupera sozinha, então ela precisa ser gravada mesmo que
  // o evento de template vizinho tenha explodido. Mas engolir a falha e
  // responder 200 PERDE o evento de vez: a Meta só reentrega em resposta
  // non-2xx e não existe consumidor de whatsapp_webhook_events com
  // processed_at IS NULL neste repositório — a linha marcada por
  // markEventFailed nunca seria retomada. Por isso as falhas transitórias são
  // COLETADAS e, no fim do lote, viram 503: a redelivery é segura porque o
  // insert-first dedup pula o que já foi processado com sucesso.
  const falhasTransitorias: string[] = []

  for (const entry of body.entry) {
    for (const change of entry.changes ?? []) {
      try {
        if (TEMPLATE_LIFECYCLE_FIELDS.has(change.field)) {
          await processTemplateLifecycleChange(
            entry,
            change.field,
            change.value as MetaTemplateLifecycleValue,
            admin,
          )
        } else {
          await processMessagingChange(change.value as MetaWebhookChangeValue, admin)
        }
      } catch (error) {
        const detalhe = error instanceof Error ? error.message : String(error)
        falhasTransitorias.push(`${change.field}: ${detalhe}`)
        console.error(
          `[whatsapp-oficial/webhook] change (${change.field}) failed; continuing with the ` +
            'rest of the batch and asking Meta to redeliver at the end:',
          error,
        )
      }
    }
  }

  // Rejeição de regra de negócio NÃO passa por aqui: template desconhecido
  // volta { ok: true, atualizado: false } sem lançar, fica registrado e o lote
  // responde 200 — reentregar não mudaria nada.
  if (falhasTransitorias.length > 0) {
    throw new Error(
      `${falhasTransitorias.length} evento(s) do lote falharam: ${falhasTransitorias.join(' | ')}`,
    )
  }
}

/**
 * Resolve o canal pelo WABA id que vem em `entry.id` — eventos de template
 * não trazem `phone_number_id`. Devolve null (em vez de lançar) quando não há
 * exatamente um canal: sem canal não dá nem para registrar em
 * `whatsapp_webhook_events` (canal_id é NOT NULL), e forçar redelivery de um
 * evento que nunca vai resolver só empilharia retry na Meta.
 */
async function findChannelByWabaId(
  wabaId: string,
  admin: SupabaseClient,
): Promise<ChannelRow | null> {
  const { data, error } = await admin
    .from('whatsapp_channels')
    .select('id, tenant_id, status')
    .eq('waba_id', wabaId)

  if (error) {
    throw new Error(`failed to look up channel for waba_id ${wabaId}: ${error.message}`)
  }
  const rows = (data ?? []) as ChannelRow[]
  if (rows.length === 0) {
    console.error('[whatsapp-oficial/webhook] no channel configured for waba_id:', wabaId)
    return null
  }
  if (rows.length > 1) {
    console.error(
      `[whatsapp-oficial/webhook] ${rows.length} channels matched waba_id ${wabaId}; ` +
        'skipping the template event to avoid ambiguous tenancy.',
    )
    return null
  }
  return rows[0]
}

/**
 * Aplica um evento de lifecycle de template via
 * `whatsapp_oficial_registrar_status_template`.
 *
 * A RPC NÃO cria linha: o webhook não carrega `components`, então um template
 * ainda não sincronizado volta `atualizado = false` — isso é informação, não
 * erro. Nada aqui devolve status != 200 para a Meta.
 */
async function processTemplateLifecycleChange(
  entry: MetaWebhookEntry,
  field: string,
  value: MetaTemplateLifecycleValue,
  admin: SupabaseClient,
): Promise<void> {
  const nome = (value.message_template_name ?? '').trim()
  if (!nome) {
    console.warn(
      `[whatsapp-oficial/webhook] ${field} without message_template_name — nothing to match on, skipped.`,
    )
    return
  }

  const wabaId = (entry.id ?? '').trim()
  if (!wabaId) {
    console.error(`[whatsapp-oficial/webhook] ${field} without entry.id (waba id), skipped.`)
    return
  }
  const channel = await findChannelByWabaId(wabaId, admin)
  if (!channel) return

  const idioma = (value.message_template_language ?? '').trim() || null
  // Cada campo traz UMA das duas informações. `p_status` null faz a RPC
  // preservar o status atual (é o caso do quality_update), e um score null
  // preserva o score — nunca zera o que a outra rota gravou.
  const status =
    field === 'message_template_status_update' ? (value.event ?? '').trim() || null : null
  const qualityScore =
    field === 'message_template_quality_update' ? normalizeQualityScore(value.new_quality_score) : null

  // Dedup composta, mesma lógica de `processStatusEvent`: a Meta reusa nome +
  // idioma em toda transição do mesmo template, então o discriminante é o
  // evento em si mais o instante da entrega.
  //
  // Só que `entry.time` é OPCIONAL (a Meta o omite em algumas entregas) e sem
  // ele a chave deixa de ser estável: PAUSED → APPROVED → PAUSED de novo faria
  // a terceira transição colidir com a primeira e ser descartada como replay,
  // deixando o template 'aprovado' aqui enquanto está pausado na Meta — e
  // campanhas continuariam sendo liberadas. Sem instante de entrega não há como
  // separar replay de transição nova, então escolhemos o erro barato: chave
  // não-colidente, evento processado. Reaplicar o mesmo status é inofensivo (a
  // RPC é idempotente); PERDER uma transição não é.
  const discriminanteEntrega =
    typeof entry.time === 'number' ? String(entry.time) : `sem-time:${crypto.randomUUID()}`
  const externalId = `${nome}:${idioma ?? '*'}:${field}:${status ?? qualityScore ?? '-'}:${discriminanteEntrega}`

  const { error: insertEventError } = await admin.from('whatsapp_webhook_events').insert({
    tenant_id: channel.tenant_id,
    canal_id: channel.id,
    event_type: 'template_status',
    external_id: externalId,
    payload: { field, value },
  })

  if (insertEventError) {
    if (isUniqueViolation(insertEventError)) {
      console.info(
        '[whatsapp-oficial/webhook] duplicate template event ignored (idempotent replay):',
        externalId,
      )
      if (!(await shouldResumeExistingEvent(admin, channel.id, 'template_status', externalId))) {
        return
      }
      console.info('[whatsapp-oficial/webhook] resuming failed template event:', externalId)
    } else {
      throw new Error(`failed to record template webhook event: ${insertEventError.message}`)
    }
  }

  if (channel.status !== 'ativo') {
    await markEventProcessed(
      admin,
      channel.id,
      'template_status',
      externalId,
      'canal inativo/pausado — evento apenas registrado',
    )
    return
  }

  // components_update avisa que a Meta alterou o template, mas não manda os
  // componentes novos. Gravar meio template seria pior que não gravar nada —
  // fica registrado e o sync manual traz a versão completa.
  if (field === 'message_template_components_update') {
    await markEventProcessed(
      admin,
      channel.id,
      'template_status',
      externalId,
      'componentes alterados pela Meta — rode o sync de templates',
    )
    return
  }

  if (!status && !qualityScore) {
    await markEventProcessed(
      admin,
      channel.id,
      'template_status',
      externalId,
      `evento sem status nem quality_score reconhecido: ${field}`,
    )
    return
  }

  // `p_idioma` null é CURINGA na RPC (`v_idioma is null or t.idioma = v_idioma`):
  // aplicaria o evento em TODAS as variantes de idioma do mesmo nome. Um
  // status_update APPROVED sem `message_template_language` promoveria junto o
  // en_US que a Meta rejeitou, e ele passaria a satisfazer o gate
  // `status_aprovacao <> 'aprovado'` de enfileirar_template/campanha_criar.
  // Campo faltando não pode AMPLIAR o efeito do evento — o curinga continua
  // disponível para quem o pedir explicitamente, mas o webhook nunca o
  // exercita por omissão. Não inventamos idioma padrão: registra e ignora,
  // igual ao nome ausente. O sync manual reconstrói o catálogo inteiro.
  if (!idioma) {
    console.warn(
      `[whatsapp-oficial/webhook] ${field} sem message_template_language (${nome}) — ignorado ` +
        'para não aplicar o evento a todos os idiomas do mesmo template.',
    )
    await markEventProcessed(
      admin,
      channel.id,
      'template_status',
      externalId,
      `evento sem message_template_language — ignorado (curinga de idioma nao e aplicado por omissao): ${field}`,
    )
    return
  }

  const { data: rpcResult, error: rpcError } = await admin.rpc(
    'whatsapp_oficial_registrar_status_template',
    {
      p_tenant_id: channel.tenant_id,
      p_canal_id: channel.id,
      p_nome: nome,
      p_idioma: idioma,
      p_status: status,
      p_motivo: (value.reason ?? '').trim() || null,
      p_quality_score: qualityScore,
    },
  )

  if (rpcError) {
    console.error(
      '[whatsapp-oficial/webhook] whatsapp_oficial_registrar_status_template RPC failed:',
      rpcError.message,
    )
    await markEventFailed(admin, channel.id, 'template_status', externalId, rpcError.message)
    throw new Error(`whatsapp_oficial_registrar_status_template failed: ${rpcError.message}`)
  }

  const result = rpcResult as { ok: boolean; atualizado?: boolean; reason?: string }
  if (!result?.ok) {
    await markEventProcessed(
      admin,
      channel.id,
      'template_status',
      externalId,
      result?.reason ?? 'rejeitado',
    )
    return
  }
  if (result.atualizado !== true) {
    // Template ainda não sincronizado — esperado, não é erro.
    console.info(
      `[whatsapp-oficial/webhook] ${field} for a template not yet synced (${nome}/${idioma ?? '*'}):`,
      result.reason ?? 'template_desconhecido',
    )
    await markEventProcessed(
      admin,
      channel.id,
      'template_status',
      externalId,
      result.reason ?? 'template_desconhecido',
    )
    return
  }

  await markEventProcessed(admin, channel.id, 'template_status', externalId, null)
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
    throw new Error(
      `failed to look up channel for phone_number_id ${phoneNumberId}: ${channelError.message}`,
    )
  }
  if (!channels || channels.length === 0) {
    console.error(
      '[whatsapp-oficial/webhook] no channel configured; requesting retry ' +
        '(cannot log to whatsapp_webhook_events either, canal_id is required):',
      phoneNumberId,
    )
    throw new Error(`no channel configured for phone_number_id ${phoneNumberId}`)
  }
  if (channels.length > 1) {
    console.error(
      `[whatsapp-oficial/webhook] ${channels.length} channels matched phone_number_id ` +
        `${phoneNumberId}; requesting retry to avoid ambiguous tenancy.`,
    )
    throw new Error(`ambiguous channel configuration for phone_number_id ${phoneNumberId}`)
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
    .update({
      processed_at: new Date().toISOString(),
      processing_error: processingError,
    })
    .eq('canal_id', canalId)
    .eq('event_type', eventType)
    .eq('external_id', externalId)
  if (error) {
    throw new Error(`failed to mark webhook event processed: ${error.message}`)
  }
}

async function markEventFailed(
  admin: SupabaseClient,
  canalId: string,
  eventType: string,
  externalId: string,
  processingError: string,
): Promise<void> {
  const { error } = await admin
    .from('whatsapp_webhook_events')
    .update({ processing_error: processingError })
    .eq('canal_id', canalId)
    .eq('event_type', eventType)
    .eq('external_id', externalId)
  if (error) {
    console.error('[whatsapp-oficial/webhook] failed to record processing error:', error.message)
  }
}

async function shouldResumeExistingEvent(
  admin: SupabaseClient,
  canalId: string,
  eventType: string,
  externalId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from('whatsapp_webhook_events')
    .select('processed_at')
    .eq('canal_id', canalId)
    .eq('event_type', eventType)
    .eq('external_id', externalId)
    .maybeSingle()

  if (error || !data) {
    throw new Error(
      `failed to inspect duplicate webhook event: ${error?.message ?? 'row not found'}`,
    )
  }
  return data.processed_at == null
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
      if (!(await shouldResumeExistingEvent(admin, channel.id, 'message', externalId))) return
      console.info('[whatsapp-oficial/webhook] resuming failed inbound event:', externalId)
    } else {
      throw new Error(`failed to record inbound webhook event: ${insertEventError.message}`)
    }
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

  const { messageType, content, mediaUrl, mediaMimeType } = parseMessageContent(message)

  // Single entry point into the bridge (Fase 5, applied after this route was
  // first written — see docs/decisions/ADR-WHATSAPP-OFFICIAL-WACRM.md D5).
  // Finds-or-creates the lead by (tenant_id, whatsapp), finds-or-creates the
  // conversation by (tenant_id, canal_id, lead_id), and inserts the message
  // idempotently by (tenant_id, wamid) — all inside one SECURITY DEFINER
  // transaction, replacing what used to be four separate client-side
  // read/write round trips (and the "lead não encontrado" TODO below it).
  const { data: rpcResult, error: rpcError } = await admin.rpc(
    'whatsapp_oficial_processar_inbound',
    {
      p_tenant_id: channel.tenant_id,
      p_canal_id: channel.id,
      p_whatsapp: phone,
      p_wa_contact_name: contact?.profile?.name ?? null,
      p_wamid: message.id,
      p_message_type: messageType,
      p_content: content,
      p_media_url: mediaUrl,
      p_media_mime_type: mediaMimeType,
      p_wpp_timestamp: new Date(Number(message.timestamp) * 1000).toISOString(),
      p_raw_payload: { message, contact },
    },
  )

  if (rpcError) {
    console.error(
      '[whatsapp-oficial/webhook] whatsapp_oficial_processar_inbound RPC failed:',
      rpcError.message,
    )
    await markEventFailed(admin, channel.id, 'message', externalId, rpcError.message)
    throw new Error(`whatsapp_oficial_processar_inbound failed: ${rpcError.message}`)
  }

  const result = rpcResult as {
    ok: boolean
    reason?: string
    lead_id?: string
    conversation_id?: string
  }
  if (!result.ok) {
    // Business-rule rejection (whatsapp_invalido, canal_invalido, lead_nao_ativo)
    // rather than an infra error — the raw event stays recorded either way.
    await markEventProcessed(admin, channel.id, 'message', externalId, result.reason ?? 'rejeitado')
    return
  }

  await markEventProcessed(admin, channel.id, 'message', externalId, null)
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
      return {
        ...empty,
        messageType: 'text',
        content: message.text?.body ?? null,
      }

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
      return {
        ...empty,
        messageType: 'interactive',
        content: reply?.title ?? reply?.id ?? null,
      }
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
      if (!(await shouldResumeExistingEvent(admin, channel.id, 'status', externalId))) return
      console.info('[whatsapp-oficial/webhook] resuming failed status event:', externalId)
    } else {
      throw new Error(`failed to record status webhook event: ${insertEventError.message}`)
    }
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

  // Single entry point into the bridge (Fase 5). Looks the message up by
  // (tenant_id, wamid), dedupes the status event by meta_status_id, and
  // applies the rank-based non-regression rule — including the terminal
  // `falhou` guard (fixed in migration 20260724150000 after this route was
  // first wired to a two-step rank-fetch/compare that had the same gap;
  // see docs/decisions/ADR-WHATSAPP-OFFICIAL-WACRM.md D7 and
  // src/lib/whatsapp-oficial/status.ts, which now only documents the rule
  // rather than deciding it). `p_detalhe` carries both the flat code/message
  // the RPC reads for `falhou` and the full raw Meta status payload for audit.
  const detalhe: Record<string, unknown> = { status }
  if (mapped === 'falhou' && status.errors?.[0]) {
    detalhe.code = String(status.errors[0].code)
    detalhe.message = status.errors[0].message ?? status.errors[0].title ?? null
  }

  const { data: rpcResult, error: rpcError } = await admin.rpc(
    'whatsapp_oficial_registrar_status',
    {
      p_tenant_id: channel.tenant_id,
      p_wamid: status.id,
      p_novo_status: mapped,
      p_meta_status_id: `${status.id}:${status.status}`,
      p_ocorrido_em: new Date(Number(status.timestamp) * 1000).toISOString(),
      p_detalhe: detalhe,
    },
  )

  if (rpcError) {
    console.error(
      '[whatsapp-oficial/webhook] whatsapp_oficial_registrar_status RPC failed:',
      rpcError.message,
    )
    await markEventFailed(admin, channel.id, 'status', externalId, rpcError.message)
    throw new Error(`whatsapp_oficial_registrar_status failed: ${rpcError.message}`)
  }

  const result = rpcResult as { ok: boolean; reason?: string }
  await markEventProcessed(
    admin,
    channel.id,
    'status',
    externalId,
    result.ok ? null : (result.reason ?? 'rejeitado'),
  )
}
