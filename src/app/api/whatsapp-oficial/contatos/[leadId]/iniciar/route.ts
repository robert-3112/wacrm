import { NextResponse } from 'next/server'
import {
  BadRequestError, ForbiddenError, NotFoundError,
  requireGestaoSession, toErrorResponse,
} from '@/lib/whatsapp-oficial/api-auth'
import { isAllowlisted } from '@/lib/whatsapp-oficial/allowlist'
import { readBoundedJson } from '@/lib/whatsapp-oficial/bounded-json'
import { readWhatsappFlags } from '@/lib/whatsapp-oficial/env-flags'
import { TEMPLATE_MAX_TAMANHO_VALOR, TEMPLATE_MAX_VALORES } from '@/lib/whatsapp-oficial/meta-templates'
import {
  WHATSAPP_OFICIAL_RATE_LIMITS, checkRateLimit, rateLimitResponse,
} from '@/lib/whatsapp-oficial/rate-limit'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type StartBody = {
  canalId?: unknown
  templateId?: unknown
  clientRequestId?: unknown
  variaveis?: unknown
}

type StartResult = {
  ok?: boolean
  reason?: string
  conversation_id?: string
  message_id?: string
  template_id?: string
  preview?: unknown
  replayed?: boolean
}

const STATE_REASONS = new Set([
  'lead_optout_ou_inativo', 'consentimento_revogado', 'consentimento_ausente',
  'canal_inativo', 'provider_sem_template', 'template_de_outro_canal',
  'template_nao_aprovado', 'conversa_encerrada', 'idempotency_conflict',
  'destinatario_fora_allowlist', 'cooldown_24h',
  'destinatario_optout_duplicado', 'sophia_resposta_em_transito',
])

function readUuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new BadRequestError(`${name} inválido`)
  return value
}

/** Phase A deliberately supports text-only variables. More complex templates
 * stay in the catalog until the UI can preview their full payload. */
function readVariaveis(value: unknown): { body?: string[]; headerText?: string } {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new BadRequestError('variaveis inválidas')
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some((key) => key !== 'body' && key !== 'headerText')) {
    throw new BadRequestError('variaveis inválidas')
  }
  const result: { body?: string[]; headerText?: string } = {}
  if (raw.body !== undefined) {
    if (!Array.isArray(raw.body) || raw.body.length > TEMPLATE_MAX_VALORES ||
      !Array.from(raw.body).every((item) => typeof item === 'string' && item.length <= TEMPLATE_MAX_TAMANHO_VALOR)) {
      throw new BadRequestError('variaveis.body inválidas')
    }
    result.body = raw.body
  }
  if (raw.headerText !== undefined) {
    if (typeof raw.headerText !== 'string' || raw.headerText.length > TEMPLATE_MAX_TAMANHO_VALOR) {
      throw new BadRequestError('variaveis.headerText inválidas')
    }
    result.headerText = raw.headerText
  }
  return result
}

function refused(reason: string, status: number): NextResponse {
  return NextResponse.json({ error: reason }, { status, headers: { 'Cache-Control': 'private, no-store' } })
}

/** Queue one approved template for an existing CRM lead with no prior inbox conversation. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ leadId: string }> },
): Promise<Response> {
  try {
    const { userId, supabaseUser, admin } = await requireGestaoSession()
    const rate = checkRateLimit(`whatsapp-oficial-contato-iniciar:${userId}`, WHATSAPP_OFICIAL_RATE_LIMITS.messageSend)
    if (!rate.success) return rateLimitResponse(rate)

    // This endpoint is only the controlled 1266 pilot. The channel identity is
    // configured in deployment, never inferred from a displayed phone suffix.
    const pilotChannelId = process.env.WHATSAPP_PILOT_CHANNEL_ID
    const flags = readWhatsappFlags()
    if (!pilotChannelId || !UUID.test(pilotChannelId) || !flags.pilotMode) {
      return refused('piloto_nao_configurado', 503)
    }

    const leadId = readUuid((await params).leadId, 'leadId')
    let input: StartBody
    try {
      input = await readBoundedJson(request, 16_384) as StartBody
    } catch {
      throw new BadRequestError('JSON inválido ou grande demais')
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestError('JSON inválido')
    const canalId = readUuid(input.canalId, 'canalId')
    const templateId = readUuid(input.templateId, 'templateId')
    const clientRequestId = readUuid(input.clientRequestId, 'clientRequestId')
    const variaveis = readVariaveis(input.variaveis)
    if (canalId !== pilotChannelId) throw new ForbiddenError()

    // These are RLS-scoped reads. Neither contact details nor another tenant's
    // channel/template may be obtained through service_role in this route.
    const { data: lead, error: leadError } = await supabaseUser.from('leads')
      .select('id,tenant_id,whatsapp').eq('id', leadId).maybeSingle()
    if (leadError || !lead) throw new NotFoundError('Lead não encontrado')

    const { data: allowed, error: roleError } = await admin.rpc('whatsapp_campanha_ator_autorizado', {
      p_actor_user_id: userId, p_tenant_id: lead.tenant_id,
    })
    if (roleError) throw roleError
    if (allowed !== true) throw new ForbiddenError()

    if (!isAllowlisted(lead.whatsapp, flags)) return refused('destinatario_fora_allowlist', 409)

    const { data: channel, error: channelError } = await supabaseUser.from('whatsapp_channels')
      .select('id,tenant_id,provider,status').eq('id', canalId).maybeSingle()
    if (channelError || !channel || channel.tenant_id !== lead.tenant_id) throw new NotFoundError('Canal não encontrado')
    if (channel.status !== 'ativo') return refused('canal_inativo', 409)
    if (channel.provider !== 'meta_cloud') return refused('provider_sem_template', 409)

    const { data: template, error: templateError } = await supabaseUser.from('whatsapp_templates')
      .select('id,tenant_id,canal_id,status_aprovacao').eq('id', templateId).maybeSingle()
    if (templateError || !template || template.tenant_id !== lead.tenant_id) {
      throw new NotFoundError('Template não encontrado')
    }
    if (template.canal_id !== canalId) return refused('template_de_outro_canal', 409)
    if (template.status_aprovacao !== 'aprovado') return refused('template_nao_aprovado', 409)

    const { data, error } = await admin.rpc('whatsapp_oficial_iniciar_template', {
      p_lead_id: leadId,
      p_canal_id: canalId,
      p_template_id: templateId,
      p_variaveis: variaveis,
      p_actor_user_id: userId,
      p_client_request_id: clientRequestId,
    })
    if (error) throw error
    const result = (data ?? {}) as StartResult
    if (!result.ok || !result.conversation_id || !result.message_id) {
      const reason = result.reason ?? 'template_enqueue_rejected'
      return refused(reason, STATE_REASONS.has(reason) ? 409 : reason.endsWith('_nao_encontrado') ? 404 : 422)
    }
    return NextResponse.json({
      ok: true, enfileirado: true, replayed: result.replayed === true,
      conversationId: result.conversation_id, messageId: result.message_id,
      templateId: result.template_id ?? templateId, preview: result.preview ?? null,
    }, { status: result.replayed ? 200 : 201, headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return toErrorResponse(error)
  }
}
