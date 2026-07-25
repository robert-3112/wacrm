import { NextResponse } from 'next/server'
import { requireGestaoSession, toErrorResponse, NotFoundError } from '@/lib/whatsapp-oficial/api-auth'
import {
  WHATSAPP_OFICIAL_RATE_LIMITS,
  checkRateLimit,
  rateLimitResponse,
} from '@/lib/whatsapp-oficial/rate-limit'

/**
 * Pausa uma campanha em andamento — o botão de freio do operador.
 *
 * Pausar só muda o status: o dispatch para de enfileirar novos lotes, mas o
 * que já está na outbox segue o destino que o worker der. É por isso que
 * cancelar existe separado (aquele sim cancela os itens pendentes).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const MOTIVO_MAX_LENGTH = 500

interface PausarBody {
  motivo?: unknown
}

interface PausarResult {
  ok?: boolean
  reason?: string
  status?: string
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params
    const { userId, admin } = await requireGestaoSession()

    const rl = checkRateLimit(
      `whatsapp-oficial-campanhas-pausar:${userId}`,
      WHATSAPP_OFICIAL_RATE_LIMITS.campanhaWrite,
    )
    if (!rl.success) return rateLimitResponse(rl)

    if (!UUID_RE.test(id)) throw new NotFoundError('Campanha não encontrada')

    const raw = (await request.json().catch(() => null)) as unknown
    const body: PausarBody =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as PausarBody) : {}

    let motivo: string | null = null
    if (body.motivo !== undefined && body.motivo !== null) {
      if (typeof body.motivo !== 'string') return NextResponse.json({ error: 'motivo_invalido' }, { status: 422 })
      const trimmed = body.motivo.trim().slice(0, MOTIVO_MAX_LENGTH)
      motivo = trimmed.length > 0 ? trimmed : null
    }

    const { data, error } = await admin.rpc('whatsapp_oficial_campanha_pausar', {
      p_actor_user_id: userId,
      p_broadcast_id: id,
      p_motivo: motivo,
    })

    // 42501 (ator sem papel de gestão) vira 403 no `toErrorResponse`.
    if (error) throw error

    const result = (data ?? null) as PausarResult | null
    if (!result?.ok) {
      const reason = result?.reason ?? 'campanha_nao_pausada'
      const status =
        reason === 'campanha_nao_encontrada' ? 404 : reason === 'status_invalido' ? 409 : 422
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
