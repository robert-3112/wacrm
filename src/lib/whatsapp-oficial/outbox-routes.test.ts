/**
 * Contract tests for the four outbox HTTP routes
 * (`src/app/api/whatsapp-oficial/{outbox/run,health,outbox/metrics,
 * outbox/reenqueue-simulados}/route.ts`). Handlers are imported directly
 * (no real HTTP server) and every collaborator (`outbox-worker`,
 * `supabase-admin`, `env-flags`) is mocked — these never touch a real
 * Supabase project or the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  processOutboxBatch: vi.fn(),
  supabaseAdmin: vi.fn(),
  readWhatsappFlags: vi.fn(),
  isSendEnabledFor: vi.fn(),
}))

vi.mock('@/lib/whatsapp-oficial/outbox-worker', () => ({
  processOutboxBatch: mocks.processOutboxBatch,
}))

vi.mock('@/lib/whatsapp-oficial/supabase-admin', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}))

vi.mock('@/lib/whatsapp-oficial/env-flags', () => ({
  readWhatsappFlags: mocks.readWhatsappFlags,
  isSendEnabledFor: mocks.isSendEnabledFor,
}))

import * as runRoute from '../../app/api/whatsapp-oficial/outbox/run/route'
import * as healthRoute from '../../app/api/whatsapp-oficial/health/route'
import * as metricsRoute from '../../app/api/whatsapp-oficial/outbox/metrics/route'
import * as reenqueueRoute from '../../app/api/whatsapp-oficial/outbox/reenqueue-simulados/route'

const CRON_SECRET = 'test-cron-secret'

function makeRequest(opts: {
  headers?: Record<string, string>
  body?: unknown
} = {}): Request {
  const headers = new Headers(opts.headers ?? {})
  const init: RequestInit = { method: 'POST', headers }
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body)
    headers.set('content-type', 'application/json')
  }
  return new Request('http://localhost/api/whatsapp-oficial/route-under-test', init)
}

describe('POST /api/whatsapp-oficial/outbox/run', () => {
  beforeEach(() => {
    mocks.processOutboxBatch.mockReset()
    mocks.supabaseAdmin.mockReset().mockReturnValue({ marker: 'admin' })
    mocks.readWhatsappFlags.mockReset().mockReturnValue({
      mode: 'shadow',
      metaSendEnabled: false,
      evolutionSendEnabled: false,
      broadcastEnabled: false,
      pilotMode: false,
      allowlist: [],
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('exports only POST, not GET', () => {
    expect(typeof runRoute.POST).toBe('function')
    expect((runRoute as Record<string, unknown>).GET).toBeUndefined()
  })

  it('returns 401 when the header is missing', async () => {
    vi.stubEnv('WHATSAPP_OUTBOX_CRON_SECRET', CRON_SECRET)

    const res = await runRoute.POST(makeRequest())

    expect(res.status).toBe(401)
    expect(mocks.processOutboxBatch).not.toHaveBeenCalled()
  })

  it('returns 503 when the secret env var is not configured', async () => {
    vi.stubEnv('WHATSAPP_OUTBOX_CRON_SECRET', '')

    const res = await runRoute.POST(
      makeRequest({ headers: { 'x-cron-secret': 'anything' } }),
    )

    expect(res.status).toBe(503)
    expect(mocks.processOutboxBatch).not.toHaveBeenCalled()
  })

  it('returns 200 and calls processOutboxBatch once when the header matches', async () => {
    vi.stubEnv('WHATSAPP_OUTBOX_CRON_SECRET', CRON_SECRET)
    mocks.processOutboxBatch.mockResolvedValue({
      claimed: 3,
      simulated: 2,
      sent: 1,
      retried: 0,
      deadLettered: 0,
      blocked: 0,
      outcomes: [],
    })

    const res = await runRoute.POST(
      makeRequest({ headers: { 'x-cron-secret': CRON_SECRET } }),
    )
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(mocks.processOutboxBatch).toHaveBeenCalledTimes(1)
    expect(json.mode).toBe('shadow')
    expect(json.claimed).toBe(3)
  })
})

describe('GET /api/whatsapp-oficial/health', () => {
  it('returns exactly {ok, version, timestamp}, no mode/config leak', async () => {
    const res = await healthRoute.GET()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(Object.keys(json).sort()).toEqual(['ok', 'timestamp', 'version'])
    expect(json.ok).toBe(true)
  })
})

describe('GET /api/whatsapp-oficial/outbox/metrics', () => {
  beforeEach(() => {
    mocks.readWhatsappFlags.mockReset().mockReturnValue({
      mode: 'shadow',
      metaSendEnabled: false,
      evolutionSendEnabled: false,
      broadcastEnabled: false,
      pilotMode: false,
      allowlist: [],
    })
    mocks.isSendEnabledFor.mockReset().mockReturnValue(false)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns 401 when the header is missing', async () => {
    vi.stubEnv('WHATSAPP_OUTBOX_CRON_SECRET', CRON_SECRET)
    mocks.supabaseAdmin.mockReset()

    const res = await metricsRoute.GET(makeRequest())

    expect(res.status).toBe(401)
  })

  it('aggregates counts correctly from fake rows', async () => {
    vi.stubEnv('WHATSAPP_OUTBOX_CRON_SECRET', CRON_SECRET)

    const now = Date.now()
    const rows = [
      { status: 'pendente', created_at: new Date(now - 60_000).toISOString(), attempts: 0, dead_letter_at: null },
      { status: 'pendente', created_at: new Date(now - 5_000).toISOString(), attempts: 1, dead_letter_at: null },
      { status: 'falhou', created_at: new Date(now - 120_000).toISOString(), attempts: 2, dead_letter_at: null },
      { status: 'simulado', created_at: new Date(now).toISOString(), attempts: 0, dead_letter_at: null },
      { status: 'morto', created_at: new Date(now).toISOString(), attempts: 5, dead_letter_at: new Date(now).toISOString() },
      { status: 'enviado', created_at: new Date(now).toISOString(), attempts: 1, dead_letter_at: null },
    ]

    mocks.supabaseAdmin.mockReturnValue({
      from: vi.fn(() => ({
        select: vi.fn().mockResolvedValue({ data: rows, error: null }),
      })),
    })

    const res = await metricsRoute.GET(
      makeRequest({ headers: { 'x-cron-secret': CRON_SECRET } }),
    )
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.depthByStatus).toEqual({
      pendente: 2,
      processando: 0,
      enviado: 1,
      falhou: 1,
      morto: 1,
      simulado: 1,
    })
    expect(json.deadLetterTotal).toBe(1)
    expect(json.attemptsSum).toBe(9)
    // oldest waiting among pendente/falhou is the one 120s ago
    expect(json.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(119)
    expect(json.mode).toBe('shadow')
  })
})

describe('POST /api/whatsapp-oficial/outbox/reenqueue-simulados', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns 401 when the header is missing', async () => {
    vi.stubEnv('WHATSAPP_OUTBOX_CRON_SECRET', CRON_SECRET)
    mocks.supabaseAdmin.mockReset()

    const res = await reenqueueRoute.POST(makeRequest())

    expect(res.status).toBe(401)
  })

  it('passes p_outbox_ids through to the RPC and returns the count', async () => {
    vi.stubEnv('WHATSAPP_OUTBOX_CRON_SECRET', CRON_SECRET)
    const rpc = vi.fn().mockResolvedValue({
      data: { ok: true, reenfileirados: 2 },
      error: null,
    })
    mocks.supabaseAdmin.mockReturnValue({ rpc })

    const res = await reenqueueRoute.POST(
      makeRequest({
        headers: { 'x-cron-secret': CRON_SECRET },
        body: { outboxIds: ['id-1', 'id-2'], motivo: 'manual promotion' },
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('whatsapp_oficial_reenfileirar_simulados', {
      p_outbox_ids: ['id-1', 'id-2'],
      p_motivo: 'manual promotion',
    })
    expect(json).toEqual({ ok: true, reenfileirados: 2 })
  })

  it('passes null p_outbox_ids when no ids are given in the body', async () => {
    vi.stubEnv('WHATSAPP_OUTBOX_CRON_SECRET', CRON_SECRET)
    const rpc = vi.fn().mockResolvedValue({
      data: { ok: true, reenfileirados: 7 },
      error: null,
    })
    mocks.supabaseAdmin.mockReturnValue({ rpc })

    const res = await reenqueueRoute.POST(
      makeRequest({ headers: { 'x-cron-secret': CRON_SECRET } }),
    )
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('whatsapp_oficial_reenfileirar_simulados', {
      p_outbox_ids: null,
      p_motivo: null,
    })
    expect(json.reenfileirados).toBe(7)
  })
})
