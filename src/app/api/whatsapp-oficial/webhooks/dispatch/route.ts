import { randomUUID, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/whatsapp-oficial/supabase-admin'
import { processWebhookDeliveryBatch } from '@/lib/whatsapp-oficial/outbound-webhooks'

/**
 * Tique do worker de outbound webhooks — chamado por cron, nunca por um humano.
 *
 * Autenticação por `x-cron-secret` em tempo constante, mesmo segredo e mesmo
 * formato de `outbox/run` e `campanhas/dispatch`: não existe usuário para
 * `requireGestaoSession` extrair, e a autorização de quem podia inscrever o
 * endpoint já aconteceu na criação da inscrição.
 *
 * Fica fora de `/api/whatsapp/**` de propósito: o middleware devolve 401 sem
 * sessão para aquele prefixo, e esta rota é chamada por máquina.
 *
 * A rota é fina. Claim, assinatura, entrega, backoff e dead-letter vivem em
 * `processWebhookDeliveryBatch` (`@/lib/whatsapp-oficial/outbound-webhooks`) e
 * nas RPCs — aqui só se autentica o chamador, se limitam os botões do lote e
 * se reportam os contadores.
 *
 * Isto NÃO envia mensagem de WhatsApp: webhook de saída fala com sistema.
 */

/**
 * `limit` é TETO de quantas entregas o tique pode reivindicar, não promessa de
 * quantas ele vai processar: 100 entregas sequenciais de até 10s não cabem em
 * lease nenhum aceito aqui. Quem decide onde parar é o orçamento de lease dentro
 * de `processWebhookDeliveryBatch`; o excedente sai em `remaining` e volta no
 * tique seguinte. Baixar `limit` só evita reivindicar à toa.
 */
const DEFAULT_LIMIT = 20
const MIN_LIMIT = 1
const MAX_LIMIT = 100

const DEFAULT_LEASE_SECONDS = 120
const MIN_LEASE_SECONDS = 30
const MAX_LEASE_SECONDS = 3600

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

interface RunBody {
  limit?: number
  leaseSeconds?: number
}

/** Corpo ausente ou inválido só significa "usa os padrões". */
async function parseBody(request: Request): Promise<RunBody> {
  try {
    const raw = await request.json()
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as RunBody
    }
    return {}
  } catch {
    return {}
  }
}

function isAuthorized(request: Request): boolean | 'not_configured' {
  const expected = process.env.WHATSAPP_OUTBOX_CRON_SECRET
  if (!expected) {
    return 'not_configured'
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  // timingSafeEqual lança quando os tamanhos diferem; comparar antes também
  // evita o vazamento de tamanho virar exceção 500.
  if (suppliedBuf.length !== expectedBuf.length) {
    return false
  }
  return timingSafeEqual(suppliedBuf, expectedBuf)
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
  const limit =
    typeof body.limit === 'number' && Number.isFinite(body.limit)
      ? clamp(Math.floor(body.limit), MIN_LIMIT, MAX_LIMIT)
      : DEFAULT_LIMIT
  const leaseSeconds =
    typeof body.leaseSeconds === 'number' && Number.isFinite(body.leaseSeconds)
      ? clamp(Math.floor(body.leaseSeconds), MIN_LEASE_SECONDS, MAX_LEASE_SECONDS)
      : DEFAULT_LEASE_SECONDS

  const workerId = `${process.env.HOSTNAME ?? 'wa-hub'}-${randomUUID().slice(0, 8)}`

  try {
    const result = await processWebhookDeliveryBatch({
      admin: supabaseAdmin(),
      workerId,
      limit,
      leaseSeconds,
    })

    return NextResponse.json({
      ok: true,
      claimed: result.claimed,
      delivered: result.delivered,
      retried: result.retried,
      deadLettered: result.deadLettered,
      // Reivindicadas que não couberam no lease e voltam no próximo tique. Sai na
      // resposta porque é o único jeito de a operação enxergar "o lote é grande
      // demais para o lease" — sem isto, um `limit` alto parece funcionar (nenhum
      // erro) enquanto entrega duplicado no destino a cada ciclo.
      remaining: result.remaining,
      outcomes: result.outcomes,
    })
  } catch (err) {
    // Só a RPC de claim (ou a falta de env do Supabase) chega aqui — falha de
    // entrega individual já foi tratada dentro do lote.
    console.error('[whatsapp-oficial/webhooks/dispatch] lote falhou:', err)
    return NextResponse.json({ error: 'webhook_dispatch_failed' }, { status: 500 })
  }
}
