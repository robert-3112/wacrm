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

  it('returns 500 with the batch result when a job needs reconciliation', async () => {
    vi.stubEnv('WHATSAPP_OUTBOX_CRON_SECRET', CRON_SECRET)
    mocks.processOutboxBatch.mockResolvedValue({
      claimed: 1, simulated: 0, sent: 0, retried: 0, deadLettered: 0, blocked: 0,
      outcomes: [{ outboxId: 'ob-1', decision: 'erro_inesperado', reason: 'reconciliacao_necessaria' }],
    })

    const res = await runRoute.POST(makeRequest({ headers: { 'x-cron-secret': CRON_SECRET } }))

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({
      error: 'outbox_reconciliation_required',
      outcomes: [{ outboxId: 'ob-1', decision: 'erro_inesperado' }],
    })
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

  it('conta NO BANCO (head+count) — os totais vêm do `count`, nunca de linhas varridas em JS', async () => {
    // A versão antiga selecionava a tabela inteira e somava em memória; o
    // PostgREST corta em `db-max-rows` (1000), então acima disso contava
    // errado em silêncio. Os counts abaixo passam de 1000 de propósito: se a
    // rota voltar a contar linhas transferidas, este teste quebra.
    vi.stubEnv('WHATSAPP_OUTBOX_CRON_SECRET', CRON_SECRET)

    const now = Date.now()
    const countsPorStatus: Record<string, number> = {
      pendente: 1500,
      processando: 3,
      falhou: 7,
      simulado: 2400,
      morto: 11,
      enviado: 9000,
    }
    const deadLetterCount = 11
    const oldestRows = [{ created_at: new Date(now - 120_000).toISOString() }]

    mocks.supabaseAdmin.mockReturnValue({
      from: vi.fn(() => ({
        select: vi.fn((_cols: string, opts?: { count?: string; head?: boolean }) => {
          if (opts?.head === true && opts.count === 'exact') {
            return {
              // contagem por status
              eq: vi.fn((_col: string, status: string) =>
                Promise.resolve({ count: countsPorStatus[status] ?? 0, error: null }),
              ),
              // contagem de dead-letter (dead_letter_at not is null)
              not: vi.fn(() => Promise.resolve({ count: deadLetterCount, error: null })),
            }
          }
          // pendente/falhou mais antigo: .in().order().limit(1)
          const q = {
            in: vi.fn(() => q),
            order: vi.fn(() => q),
            limit: vi.fn(() => Promise.resolve({ data: oldestRows, error: null })),
          }
          return q
        }),
      })),
    })

    const res = await metricsRoute.GET(
      makeRequest({ headers: { 'x-cron-secret': CRON_SECRET } }),
    )
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.depthByStatus).toEqual({
      pendente: 1500,
      processando: 3,
      enviado: 9000,
      falhou: 7,
      morto: 11,
      simulado: 2400,
    })
    expect(json.deadLetterTotal).toBe(11)
    // o mais antigo entre pendente/falhou está 120s no passado
    expect(json.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(119)
    expect(json.mode).toBe('shadow')
  })

  it('fila vazia: oldestPendingAgeSeconds é null, não 0', async () => {
    vi.stubEnv('WHATSAPP_OUTBOX_CRON_SECRET', CRON_SECRET)

    mocks.supabaseAdmin.mockReturnValue({
      from: vi.fn(() => ({
        select: vi.fn((_cols: string, opts?: { count?: string; head?: boolean }) => {
          if (opts?.head === true) {
            return {
              eq: vi.fn(() => Promise.resolve({ count: 0, error: null })),
              not: vi.fn(() => Promise.resolve({ count: 0, error: null })),
            }
          }
          const q = {
            in: vi.fn(() => q),
            order: vi.fn(() => q),
            limit: vi.fn(() => Promise.resolve({ data: [], error: null })),
          }
          return q
        }),
      })),
    })

    const res = await metricsRoute.GET(
      makeRequest({ headers: { 'x-cron-secret': CRON_SECRET } }),
    )
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.oldestPendingAgeSeconds).toBeNull()
    expect(json.deadLetterTotal).toBe(0)
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
