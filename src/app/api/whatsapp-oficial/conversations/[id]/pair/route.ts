import { NextResponse } from 'next/server'
import {
  BadRequestError, isPostgrestPermissionError, requireGestaoSession, toErrorResponse,
} from '@/lib/whatsapp-oficial/api-auth'
import { WHATSAPP_OFICIAL_RATE_LIMITS, checkRateLimit, rateLimitResponse } from '@/lib/whatsapp-oficial/rate-limit'
import type { SupabaseClient } from '@supabase/supabase-js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const linkEnabled = () => process.env.WHATSAPP_PAIR_LINK_ENABLED === 'true'
const PROOF_KEYS = [
  'outbound_conversation_id', 'inbound_conversation_id',
  'outbound_message_id', 'inbound_message_id',
  'status_webhook_event_id', 'inbound_webhook_event_id',
] as const
type ProofKey = typeof PROOF_KEYS[number]
type Proof = Record<ProofKey, string>
type Candidate = Proof & { ok: true; status_at: string; inbound_at: string }

function readProof(value: unknown): Proof | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (!PROOF_KEYS.every(key => typeof record[key] === 'string' && UUID.test(record[key]))) return null
  return Object.fromEntries(PROOF_KEYS.map(key => [key, record[key]])) as Proof
}

function readCandidate(value: unknown, outboundId: string): Candidate | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const proof = readProof(value)
  if (record.ok !== true || !proof || proof.outbound_conversation_id !== outboundId ||
    typeof record.status_at !== 'string' || !Number.isFinite(Date.parse(record.status_at)) ||
    typeof record.inbound_at !== 'string' || !Number.isFinite(Date.parse(record.inbound_at))) return null
  return { ok: true, ...proof, status_at: record.status_at, inbound_at: record.inbound_at }
}

function previewFailure(value: unknown): Response {
  const reason = value && typeof value === 'object' ? (value as { reason?: unknown }).reason : null
  if (reason === 'not_found') return NextResponse.json({ error: 'Nenhum histórico relacionado confirmado pela Meta.' }, { status: 404 })
  if (reason === 'ambiguous') return NextResponse.json({ error: 'Mais de um histórico possível. Revisão manual necessária.' }, { status: 409 })
  if (reason === 'already_linked') return NextResponse.json({ error: 'Uma das conversas já está vinculada.' }, { status: 409 })
  if (reason === 'active_outbox') return NextResponse.json({ error: 'Há mensagens em processamento. Aguarde antes de vincular.' }, { status: 409 })
  return NextResponse.json({ error: 'Não foi possível validar a evidência.' }, { status: 502 })
}

async function preview(supabaseUser: SupabaseClient, outboundId: string): Promise<Candidate | Response> {
  const { data, error } = await supabaseUser.rpc('whatsapp_oficial_prever_par', {
    p_outbound_conversation_id: outboundId,
  })
  if (error) {
    if (isPostgrestPermissionError(error)) return NextResponse.json({ error: 'Sem permissão.' }, { status: 403 })
    return NextResponse.json({ error: 'Não foi possível consultar a evidência.' }, { status: 502 })
  }
  return readCandidate(data, outboundId) ?? previewFailure(data)
}

function assertId(id: string): void {
  if (!UUID.test(id)) throw new BadRequestError('Identificador de conversa inválido.')
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params
    assertId(id)
    const { userId, supabaseUser } = await requireGestaoSession()
    const limit = checkRateLimit(`whatsapp-pair-preview:${userId}`, WHATSAPP_OFICIAL_RATE_LIMITS.gestaoList)
    if (!limit.success) return rateLimitResponse(limit)
    const result = await preview(supabaseUser, id)
    return result instanceof Response ? result : NextResponse.json({ candidate: result, linkEnabled: linkEnabled() })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params
    assertId(id)
    const requested = readProof(await request.json().catch(() => null))
    if (!requested || requested.outbound_conversation_id !== id) throw new BadRequestError('Prova inválida.')
    const { userId, supabaseUser } = await requireGestaoSession()
    const limit = checkRateLimit(`whatsapp-pair-link:${userId}`, WHATSAPP_OFICIAL_RATE_LIMITS.inboxWriteAction)
    if (!limit.success) return rateLimitResponse(limit)
    if (!linkEnabled()) return NextResponse.json({ error: 'Vínculo indisponível até habilitação segura de envio para ambos os históricos.' }, { status: 403 })
    const fresh = await preview(supabaseUser, id)
    if (fresh instanceof Response) return fresh
    if (PROOF_KEYS.some(key => fresh[key] !== requested[key])) {
      return NextResponse.json({ error: 'A evidência mudou. Confira a prévia novamente.' }, { status: 409 })
    }
    const { data, error } = await supabaseUser.rpc('whatsapp_oficial_vincular_conversas', {
      p_outbound_conversation_id: fresh.outbound_conversation_id,
      p_inbound_conversation_id: fresh.inbound_conversation_id,
      p_outbound_message_id: fresh.outbound_message_id,
      p_inbound_message_id: fresh.inbound_message_id,
      p_status_webhook_event_id: fresh.status_webhook_event_id,
      p_inbound_webhook_event_id: fresh.inbound_webhook_event_id,
    })
    if (error) {
      if (isPostgrestPermissionError(error)) return NextResponse.json({ error: 'Sem permissão.' }, { status: 403 })
      if (error.code === '23505' || error.code === '22023' || error.code === '23514') {
        return NextResponse.json({ error: 'O vínculo não pode ser criado neste momento.' }, { status: 409 })
      }
      return NextResponse.json({ error: 'Não foi possível vincular os históricos.' }, { status: 502 })
    }
    if (typeof data !== 'string' || !UUID.test(data)) return NextResponse.json({ error: 'Resposta de vínculo inválida.' }, { status: 502 })
    return NextResponse.json({ ok: true, pairId: data })
  } catch (error) {
    return toErrorResponse(error)
  }
}
