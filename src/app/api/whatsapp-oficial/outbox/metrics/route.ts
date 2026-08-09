/**
 * Aggregate health/depth metrics for `whatsapp_outbox`, gated by the same
 * shared cron secret as `/api/whatsapp-oficial/outbox/run` (this is
 * operational telemetry, not a public status page — it exposes queue
 * shape, not message content).
 *
 * Conta NO BANCO (`count: 'exact', head: true`), nunca em JS sobre linhas
 * transferidas: o PostgREST corta qualquer select de linhas no `db-max-rows`
 * (1000 no default do Supabase), então a versão anterior — varrer a tabela e
 * somar em memória — mentia silenciosamente a partir da 1001ª linha. Mesmo
 * motivo do teto paginado documentado em `campanhas/[id]/route.ts`. Nada aqui
 * seleciona ou devolve `payload`, telefone ou conteúdo de mensagem.
 */

import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/whatsapp-oficial/supabase-admin'
import { readWhatsappFlags, isSendEnabledFor } from '@/lib/whatsapp-oficial/env-flags'

type OutboxStatus = 'pendente' | 'processando' | 'enviado' | 'falhou' | 'morto' | 'simulado'

const TRACKED_STATUSES: OutboxStatus[] = [
  'pendente',
  'processando',
  'falhou',
  'simulado',
  'morto',
  'enviado',
]

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

export async function GET(request: Request): Promise<NextResponse> {
  const auth = isAuthorized(request)
  if (auth === 'not_configured') {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  if (auth !== true) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()

  try {
    // Uma consulta head+count por status, mais dead-letter e o pendente mais
    // antigo — 8 idas leves ao banco em paralelo, zero linhas transferidas.
    const [contagens, deadLetter, maisAntiga] = await Promise.all([
      Promise.all(
        TRACKED_STATUSES.map(async (status) => {
          const { count, error } = await admin
            .from('whatsapp_outbox')
            .select('id', { count: 'exact', head: true })
            .eq('status', status)
          if (error) throw error
          return [status, count ?? 0] as const
        }),
      ),
      admin
        .from('whatsapp_outbox')
        .select('id', { count: 'exact', head: true })
        .not('dead_letter_at', 'is', null),
      admin
        .from('whatsapp_outbox')
        .select('created_at')
        .in('status', ['pendente', 'falhou'])
        .order('created_at', { ascending: true })
        .limit(1),
    ])
    if (deadLetter.error) throw deadLetter.error
    if (maisAntiga.error) throw maisAntiga.error

    const depthByStatus = Object.fromEntries(contagens) as Record<OutboxStatus, number>

    const oldestRow = ((maisAntiga.data ?? []) as Array<{ created_at: string }>)[0]
    const oldestMs = oldestRow ? new Date(oldestRow.created_at).getTime() : NaN
    const oldestPendingAgeSeconds = Number.isNaN(oldestMs)
      ? null
      : Math.max(0, Math.floor((Date.now() - oldestMs) / 1000))

    const flags = readWhatsappFlags()

    return NextResponse.json({
      depthByStatus,
      oldestPendingAgeSeconds,
      deadLetterTotal: deadLetter.count ?? 0,
      mode: flags.mode,
      providersEnabled: {
        meta_cloud: isSendEnabledFor('meta_cloud', flags),
        evolution: isSendEnabledFor('evolution', flags),
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[whatsapp-oficial/outbox/metrics] query failed:', message)
    return NextResponse.json({ error: 'outbox_metrics_failed' }, { status: 500 })
  }
}
