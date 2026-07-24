/**
 * Explicit shadow -> real-queue promotion for `whatsapp_outbox` rows that
 * were simulated (status = 'simulado') while the worker ran in shadow
 * mode. Gated by the same shared cron secret as the other outbox routes.
 *
 * This route does NOT send anything by itself. It only flips the
 * targeted rows back into the pending queue (via the
 * `whatsapp_oficial_reenfileirar_simulados` RPC) so the next worker run
 * picks them up under whatever mode/flags are active at that time.
 */

import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/whatsapp-oficial/supabase-admin'

const MAX_OUTBOX_IDS = 500

interface ReenqueueBody {
  outboxIds?: string[]
  motivo?: string
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

async function parseBody(request: Request): Promise<ReenqueueBody> {
  try {
    const raw = await request.json()
    if (raw && typeof raw === 'object') {
      return raw as ReenqueueBody
    }
    return {}
  } catch {
    return {}
  }
}

function isValidOutboxIds(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false
  if (value.length === 0 || value.length > MAX_OUTBOX_IDS) return false
  return value.every((item) => typeof item === 'string' && item.length > 0)
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

  let outboxIds: string[] | null = null
  if (body.outboxIds !== undefined) {
    if (!isValidOutboxIds(body.outboxIds)) {
      return NextResponse.json({ error: 'invalid_outbox_ids' }, { status: 400 })
    }
    outboxIds = body.outboxIds
  }

  const motivo = typeof body.motivo === 'string' && body.motivo.length > 0 ? body.motivo : null

  const admin = supabaseAdmin()
  const { data, error } = await admin.rpc('whatsapp_oficial_reenfileirar_simulados', {
    p_outbox_ids: outboxIds,
    p_motivo: motivo,
  })

  if (error) {
    console.error('[whatsapp-oficial/outbox/reenqueue-simulados] rpc failed:', error.message)
    return NextResponse.json({ error: 'reenqueue_failed' }, { status: 500 })
  }

  const result = data as { ok: boolean; reenfileirados: number } | null

  return NextResponse.json({
    ok: result?.ok ?? false,
    reenfileirados: result?.reenfileirados ?? 0,
  })
}
