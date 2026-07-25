import { NextResponse } from 'next/server'
import { requireGestaoSession, toErrorResponse, NotFoundError } from '@/lib/whatsapp-oficial/api-auth'
import {
  WHATSAPP_OFICIAL_RATE_LIMITS,
  checkRateLimit,
  rateLimitResponse,
} from '@/lib/whatsapp-oficial/rate-limit'

/**
 * Gera (ou simula) o público de uma campanha.
 *
 * REGRA CENTRAL DESTA ROTA: `dryRun` é TRUE por padrão. Só materializa
 * `whatsapp_broadcast_recipients` quando o corpo trouxer literalmente
 * `dryRun: false`. Qualquer outra coisa — campo ausente, `null`, `"false"`
 * como string, corpo vazio, JSON quebrado — cai no dry-run. Um cliente que
 * esqueceu o campo (ou um retry automático de um corpo truncado) NÃO pode
 * gravar público de campanha; o erro barato é simular de novo, o erro caro é
 * fixar 12 mil destinatários por engano.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface GerarDestinatariosBody {
  dryRun?: unknown
  limite?: unknown
}

interface GerarDestinatariosResult {
  ok?: boolean
  reason?: string
  status?: string
  dry_run?: boolean
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params
    const { userId, admin } = await requireGestaoSession()

    const rl = checkRateLimit(
      `whatsapp-oficial-campanhas-destinatarios:${userId}`,
      WHATSAPP_OFICIAL_RATE_LIMITS.campanhaWrite,
    )
    if (!rl.success) return rateLimitResponse(rl)

    if (!UUID_RE.test(id)) throw new NotFoundError('Campanha não encontrada')

    const raw = (await request.json().catch(() => null)) as unknown
    const body: GerarDestinatariosBody =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as GerarDestinatariosBody) : {}

    // `=== false` e não `!== true`: o default seguro é simular.
    const dryRun = body.dryRun === false ? false : true

    let limite: number | null = null
    if (body.limite !== undefined && body.limite !== null) {
      if (typeof body.limite !== 'number' || !Number.isInteger(body.limite) || body.limite < 1) {
        return NextResponse.json({ error: 'limite_invalido' }, { status: 422 })
      }
      limite = body.limite
    }

    const { data, error } = await admin.rpc('whatsapp_oficial_campanha_gerar_destinatarios', {
      p_actor_user_id: userId,
      p_broadcast_id: id,
      p_dry_run: dryRun,
      p_limite: limite,
    })

    // 42501 (ator sem papel de gestão) vira 403 no `toErrorResponse`.
    if (error) throw error

    const result = (data ?? null) as GerarDestinatariosResult | null
    if (!result?.ok) {
      const reason = result?.reason ?? 'destinatarios_nao_gerados'
      const status =
        reason === 'campanha_nao_encontrada' ? 404 : reason === 'campanha_nao_editavel' ? 409 : 422
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
