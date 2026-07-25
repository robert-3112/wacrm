import { NextResponse } from 'next/server'
import { requireGestaoSession, toErrorResponse, NotFoundError } from '@/lib/whatsapp-oficial/api-auth'
import {
  WHATSAPP_OFICIAL_RATE_LIMITS,
  checkRateLimit,
  rateLimitResponse,
} from '@/lib/whatsapp-oficial/rate-limit'

/**
 * Retoma uma campanha pausada.
 *
 * A RPC devolve o status resultante (`aprovado` ou `enviando`, conforme o
 * ponto em que ela parou) em vez de a rota adivinhar, e recusa com
 * `sem_aprovador` uma campanha que perdeu a aprovação — retomar nunca pode ser
 * um caminho lateral para enviar sem quatro-olhos.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const CONFLITOS_DE_ESTADO = ['status_invalido', 'sem_aprovador']

interface RetomarResult {
  ok?: boolean
  reason?: string
  status?: string
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params
    const { userId, admin } = await requireGestaoSession()

    const rl = checkRateLimit(
      `whatsapp-oficial-campanhas-retomar:${userId}`,
      WHATSAPP_OFICIAL_RATE_LIMITS.campanhaWrite,
    )
    if (!rl.success) return rateLimitResponse(rl)

    if (!UUID_RE.test(id)) throw new NotFoundError('Campanha não encontrada')

    const { data, error } = await admin.rpc('whatsapp_oficial_campanha_retomar', {
      p_actor_user_id: userId,
      p_broadcast_id: id,
    })

    // 42501 (ator sem papel de gestão) vira 403 no `toErrorResponse`.
    if (error) throw error

    const result = (data ?? null) as RetomarResult | null
    if (!result?.ok) {
      const reason = result?.reason ?? 'campanha_nao_retomada'
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
