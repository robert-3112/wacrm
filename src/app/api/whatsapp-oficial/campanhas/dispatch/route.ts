import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/whatsapp-oficial/supabase-admin'

/**
 * Tique do dispatcher de campanhas — chamado por cron, nunca por um humano.
 *
 * Autenticação por `x-cron-secret` (mesmo segredo e mesma comparação em tempo
 * constante das rotas de outbox), e NÃO por sessão: não existe usuário para
 * `requireGestaoSession` extrair, e a autorização de quem podia disparar já
 * aconteceu na aprovação da campanha.
 *
 * O que ele faz é só empurrar lotes para `whatsapp_outbox`. Todas as travas de
 * negócio (kill-switch do broadcast, agendamento, janela de horário/dia,
 * cadência, limite diário, template ainda aprovado) vivem dentro de
 * `whatsapp_oficial_campanha_enfileirar_lote` e devolvem `enfileirados: 0` com
 * um `reason` — a rota nem tenta reimplementá-las. E o que entra na outbox
 * ainda passa pelo worker em shadow: este endpoint não envia mensagem.
 *
 * Uma campanha que exploda NÃO derruba as outras: o erro entra no array de
 * resultados e o laço continua. Um dispatcher que aborta na primeira campanha
 * quebrada deixaria todas as seguintes paradas até alguém perceber.
 */

const LIMITE_MIN = 1
const LIMITE_MAX = 50

interface DispatchBody {
  limite?: unknown
}

interface CampanhaPendente {
  broadcast_id?: string
  tenant_id?: string
  nome?: string
  status?: string
}

interface LoteResult {
  ok?: boolean
  enfileirados?: number
  lote?: number
  reason?: string
}

interface ResultadoCampanha {
  broadcast_id: string
  enfileirados: number
  reason?: string
}

function isAuthorized(request: Request): boolean | 'not_configured' {
  const expected = process.env.WHATSAPP_OUTBOX_CRON_SECRET
  if (!expected) {
    return 'not_configured'
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (suppliedBuf.length !== expectedBuf.length) {
    return false
  }
  return timingSafeEqual(suppliedBuf, expectedBuf)
}

async function parseBody(request: Request): Promise<DispatchBody> {
  try {
    const raw = await request.json()
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as DispatchBody
    }
    return {}
  } catch {
    return {}
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const auth = isAuthorized(request)
  if (auth === 'not_configured') {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  if (auth !== true) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await parseBody(request)
  let limite: number | null = null
  if (typeof body.limite === 'number' && Number.isFinite(body.limite)) {
    limite = Math.min(Math.max(Math.trunc(body.limite), LIMITE_MIN), LIMITE_MAX)
  }

  const admin = supabaseAdmin()

  const { data, error } = await admin.rpc('whatsapp_oficial_campanhas_pendentes', {
    p_limite: limite,
  })

  if (error) {
    console.error('[whatsapp-oficial/campanhas/dispatch] campanhas_pendentes falhou:', error.message)
    return NextResponse.json({ error: 'dispatch_failed' }, { status: 500 })
  }

  const pendentes = ((data as { campanhas?: CampanhaPendente[] } | null)?.campanhas ??
    []) as CampanhaPendente[]

  const resultados: ResultadoCampanha[] = []
  let enfileiradosTotal = 0

  for (const campanha of pendentes) {
    const broadcastId = campanha?.broadcast_id
    if (!broadcastId) continue

    try {
      const { data: loteData, error: loteError } = await admin.rpc(
        'whatsapp_oficial_campanha_enfileirar_lote',
        { p_broadcast_id: broadcastId, p_limite: null },
      )
      if (loteError) throw loteError

      const lote = (loteData ?? null) as LoteResult | null
      const enfileirados = typeof lote?.enfileirados === 'number' ? lote.enfileirados : 0
      enfileiradosTotal += enfileirados
      resultados.push({
        broadcast_id: broadcastId,
        enfileirados,
        ...(lote?.reason ? { reason: lote.reason } : {}),
      })
    } catch (err) {
      const mensagem = err instanceof Error ? err.message : String(err)
      console.error(
        `[whatsapp-oficial/campanhas/dispatch] campanha ${broadcastId} falhou:`,
        mensagem,
      )
      resultados.push({ broadcast_id: broadcastId, enfileirados: 0, reason: 'erro_ao_enfileirar' })
    }
  }

  return NextResponse.json({
    ok: true,
    campanhas: resultados.length,
    enfileirados: enfileiradosTotal,
    resultados,
  })
}
