/**
 * Aggregate health/depth metrics for `whatsapp_outbox`, gated by the same
 * shared cron secret as `/api/whatsapp-oficial/outbox/run` (this is
 * operational telemetry, not a public status page — it exposes queue
 * shape, not message content).
 *
 * Deliberately avoids a dedicated aggregate RPC: pulls the small set of
 * columns needed (`status, created_at, attempts, dead_letter_at`) and
 * reduces them in JS. Never selects or returns `payload`, phone numbers,
 * or any message content.
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

interface MetricsRow {
  status: string
  created_at: string
  attempts: number | null
  dead_letter_at: string | null
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

export async function GET(request: Request): Promise<NextResponse> {
  const auth = isAuthorized(request)
  if (auth === 'not_configured') {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  if (auth !== true) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const { data, error } = await admin
    .from('whatsapp_outbox')
    .select('status, created_at, attempts, dead_letter_at')

  if (error) {
    console.error('[whatsapp-oficial/outbox/metrics] query failed:', error.message)
    return NextResponse.json({ error: 'outbox_metrics_failed' }, { status: 500 })
  }

  const rows = (data ?? []) as MetricsRow[]

  const depthByStatus: Record<OutboxStatus, number> = {
    pendente: 0,
    processando: 0,
    enviado: 0,
    falhou: 0,
    morto: 0,
    simulado: 0,
  }

  let deadLetterTotal = 0
  let attemptsSum = 0
  let oldestWaitingMs: number | null = null

  for (const row of rows) {
    if (TRACKED_STATUSES.includes(row.status as OutboxStatus)) {
      depthByStatus[row.status as OutboxStatus] += 1
    }
    if (row.dead_letter_at) {
      deadLetterTotal += 1
    }
    attemptsSum += row.attempts ?? 0

    if (row.status === 'pendente' || row.status === 'falhou') {
      const createdMs = new Date(row.created_at).getTime()
      if (!Number.isNaN(createdMs) && (oldestWaitingMs === null || createdMs < oldestWaitingMs)) {
        oldestWaitingMs = createdMs
      }
    }
  }

  const oldestPendingAgeSeconds =
    oldestWaitingMs === null ? null : Math.max(0, Math.floor((Date.now() - oldestWaitingMs) / 1000))

  const flags = readWhatsappFlags()

  return NextResponse.json({
    depthByStatus,
    oldestPendingAgeSeconds,
    deadLetterTotal,
    attemptsSum,
    mode: flags.mode,
    providersEnabled: {
      meta_cloud: isSendEnabledFor('meta_cloud', flags),
      evolution: isSendEnabledFor('evolution', flags),
    },
  })
}
