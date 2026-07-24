/**
 * Cron-triggered entry point for the outbox worker (ADR WhatsApp Hub —
 * Fase 7 runtime). Meant to be hit on a schedule (Vercel Cron / external
 * pinger / Coolify scheduled job) — requires a shared secret via the
 * `x-cron-secret` header matching `WHATSAPP_OUTBOX_CRON_SECRET`, same
 * pattern as `src/app/api/automations/cron/route.ts`.
 *
 * This route is intentionally thin: all outbox semantics (claim, shadow
 * vs live decision, adapter dispatch, retry/dead-letter bookkeeping) live
 * in `processOutboxBatch` (`@/lib/whatsapp-oficial/outbox-worker`). The
 * route only authenticates the caller, parses/clamps the optional batch
 * knobs, and reports the resulting counters.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/whatsapp-oficial/supabase-admin'
import { readWhatsappFlags } from '@/lib/whatsapp-oficial/env-flags'
import { processOutboxBatch } from '@/lib/whatsapp-oficial/outbox-worker'

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

/** Best-effort JSON body parse — a missing/invalid body just means "use defaults". */
async function parseBody(request: Request): Promise<RunBody> {
  try {
    const raw = await request.json()
    if (raw && typeof raw === 'object') {
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

  const flags = readWhatsappFlags()
  const workerId = `${process.env.HOSTNAME ?? 'wa-hub'}-${randomUUID().slice(0, 8)}`

  try {
    const result = await processOutboxBatch({
      admin: supabaseAdmin(),
      flags,
      workerId,
      limit,
      leaseSeconds,
    })

    return NextResponse.json({
      mode: flags.mode,
      claimed: result.claimed,
      simulated: result.simulated,
      sent: result.sent,
      retried: result.retried,
      deadLettered: result.deadLettered,
      blocked: result.blocked,
      outcomes: result.outcomes,
    })
  } catch (err) {
    console.error('[whatsapp-oficial/outbox/run] batch failed:', err)
    return NextResponse.json({ error: 'outbox_run_failed' }, { status: 500 })
  }
}
