import { NextResponse } from 'next/server'
import { requireGestaoSession, toErrorResponse, NotFoundError } from '@/lib/whatsapp-oficial/api-auth'
import {
  WHATSAPP_OFICIAL_RATE_LIMITS,
  checkRateLimit,
  rateLimitResponse,
} from '@/lib/whatsapp-oficial/rate-limit'

/**
 * Aprova uma campanha (quatro-olhos: a RPC recusa quando o aprovador é o mesmo
 * usuário que criou).
 *
 * Aprovar NÃO envia nada — só libera a campanha para o dispatch enfileirar
 * lotes na outbox, que continua sob as travas fail-closed do worker.
 *
 * Todas as recusas da RPC aqui são conflito de ESTADO da campanha (status
 * errado, mesmo ator, público não gerado, público vazio), não entrada inválida
 * — por isso 409 e não 422.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const CONFLITOS_DE_ESTADO = [
  'status_invalido',
  'aprovador_igual_criador',
  'destinatarios_nao_gerados',
  'sem_destinatario_elegivel',
]

interface AprovarResult {
  ok?: boolean
  reason?: string
  status?: string
  destinatarios?: number
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params
    const { userId, admin } = await requireGestaoSession()

    const rl = checkRateLimit(
      `whatsapp-oficial-campanhas-aprovar:${userId}`,
      WHATSAPP_OFICIAL_RATE_LIMITS.campanhaWrite,
    )
    if (!rl.success) return rateLimitResponse(rl)

    if (!UUID_RE.test(id)) throw new NotFoundError('Campanha não encontrada')

    const { data, error } = await admin.rpc('whatsapp_oficial_campanha_aprovar', {
      p_actor_user_id: userId,
      p_broadcast_id: id,
    })

    // 42501 (ator sem papel de gestão) vira 403 no `toErrorResponse`.
    if (error) throw error

    const result = (data ?? null) as AprovarResult | null
    if (!result?.ok) {
      const reason = result?.reason ?? 'campanha_nao_aprovada'
      const status =
        reason === 'campanha_nao_encontrada' ? 404 : CONFLITOS_DE_ESTADO.includes(reason) ? 409 : 422
      return NextResponse.json(
        { error: reason, ...(result?.status ? { status: result.status } : {}) },
        { status },
      )
    }

    return NextResponse.json(result)
  } catch (error) {
    return toErrorResponse(error)
  }
}
