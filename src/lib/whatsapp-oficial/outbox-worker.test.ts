/**
 * Tests for `processOutboxBatch` — the shadow-honesty and barrier-order
 * contract documented at the top of `./outbox-worker.ts`.
 *
 * Everything is mocked: no real network call is ever reachable (`fetch` is
 * stubbed and asserted as never-called for every shadow/blocked path), and
 * `./channel-credentials` / `./adapters` / `./allowlist` / `./meta-window`
 * / `./env-flags` are all `vi.mock`ed so each test controls exactly one
 * variable at a time. `./outbox.ts` (classification + backoff) is used
 * for real — it already has its own dedicated test file, and exercising
 * the real thing here proves the two modules integrate correctly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import type { OutboxJob, OutboundAdapter } from './adapters/types'
import type { WhatsappFlags } from './env-flags'

vi.mock('./channel-credentials', () => ({
  loadChannelCredential: vi.fn(),
  // Same class object the worker imports, so `instanceof` behaves as in prod.
  ChannelCredentialMissingError: class ChannelCredentialMissingError extends Error {
    constructor(message = 'channel_credential_missing') {
      super(message)
      this.name = 'ChannelCredentialMissingError'
    }
  },
}))
vi.mock('./adapters', () => ({
  getAdapter: vi.fn(),
}))
vi.mock('./allowlist', () => ({
  isAllowlisted: vi.fn(() => true),
}))
vi.mock('./meta-window', () => ({
  isInsideFreeFormWindow: vi.fn(() => true),
  META_FREE_FORM_WINDOW_MS: 24 * 60 * 60 * 1000,
}))
vi.mock('./env-flags', () => ({
  isSendEnabledFor: vi.fn(() => true),
}))

import { processOutboxBatch } from './outbox-worker'
import { ChannelCredentialMissingError, loadChannelCredential } from './channel-credentials'
import { getAdapter } from './adapters'
import { isAllowlisted } from './allowlist'
import { isInsideFreeFormWindow } from './meta-window'
import { isSendEnabledFor } from './env-flags'

// ============================================================
// Test helpers
// ============================================================

interface MockCall {
  table: string
  op: 'update' | 'insert' | 'select'
  values?: Record<string, unknown>
  filters?: Record<string, unknown>
}

function makeAdmin(
  opts: {
    claimResult?: { ok: boolean; claimed?: OutboxJob[] }
    claimError?: unknown
    messages?: Record<string, { status: string }>
    failUpdateForIds?: Set<string>
  } = {},
) {
  const calls: MockCall[] = []
  const messages: Record<string, { status: string }> = { ...(opts.messages ?? {}) }

  const admin = {
    rpc: async () => {
      if (opts.claimError) return { data: null, error: opts.claimError }
      return { data: opts.claimResult ?? { ok: true, claimed: [] }, error: null }
    },
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => ({
        eq: async (column: string, id: string) => {
          calls.push({ table, op: 'update', values, filters: { [column]: id } })
          if (opts.failUpdateForIds?.has(id)) {
            throw new Error(`simulated update failure for ${id}`)
          }
          if (table === 'whatsapp_messages') {
            messages[id] = { ...(messages[id] ?? { status: 'pendente' }), ...values } as {
              status: string
            }
          }
          return { error: null }
        },
      }),
      insert: (values: Record<string, unknown>) => {
        calls.push({ table, op: 'insert', values })
        return Promise.resolve({ error: null })
      },
      select: () => ({
        eq: (column: string, id: string) => ({
          maybeSingle: async () => {
            calls.push({ table, op: 'select', filters: { [column]: id } })
            if (table === 'whatsapp_messages') {
              return { data: messages[id] ?? null, error: null }
            }
            return { data: null, error: null }
          },
        }),
      }),
    }),
  }

  return { admin: admin as unknown as SupabaseClient, calls, messages }
}

function makeJob(overrides: Partial<OutboxJob> = {}): OutboxJob {
  return {
    outbox_id: 'ob-1',
    tenant_id: 't-1',
    canal_id: 'canal-1',
    conversation_id: 'conv-1',
    message_id: 'msg-1',
    tipo: 'mensagem',
    payload: { content: 'oi', message_type: 'text' },
    attempts: 0,
    max_attempts: 5,
    provider: 'meta_cloud',
    canal_status: 'ativo',
    phone_number_id: 'pn-1',
    waba_id: 'waba-1',
    evolution_base_url: null,
    evolution_instance: null,
    lead_id: 'lead-1',
    lead_whatsapp: '+5511999999999',
    lead_status_saida: 'ativo',
    conversa_status: 'aberta',
    conversa_optout_em: null,
    ultimo_inbound_em: new Date().toISOString(),
    ...overrides,
  }
}

function makeFlags(overrides: Partial<WhatsappFlags> = {}): WhatsappFlags {
  return {
    mode: 'shadow',
    metaSendEnabled: false,
    evolutionSendEnabled: false,
    broadcastEnabled: true,
    pilotMode: false,
    allowlist: [],
    ...overrides,
  }
}

const adapterMock: OutboundAdapter = {
  provider: 'meta_cloud',
  isConfigured: vi.fn(() => true),
  send: vi.fn(),
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)

  vi.mocked(getAdapter).mockReturnValue(adapterMock)
  vi.mocked(adapterMock.isConfigured).mockReset().mockReturnValue(true)
  vi.mocked(adapterMock.send).mockReset()
  vi.mocked(isAllowlisted).mockReturnValue(true)
  vi.mocked(isInsideFreeFormWindow).mockReturnValue(true)
  vi.mocked(isSendEnabledFor).mockReturnValue(true)
  vi.mocked(loadChannelCredential).mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function outboxUpdates(calls: MockCall[]) {
  return calls.filter((c) => c.table === 'whatsapp_outbox' && c.op === 'update')
}

function messageUpdates(calls: MockCall[]) {
  return calls.filter((c) => c.table === 'whatsapp_messages' && c.op === 'update')
}

function auditInserts(calls: MockCall[]) {
  return calls.filter((c) => c.table === 'whatsapp_outbound_audit' && c.op === 'insert')
}

// ============================================================
// Tests
// ============================================================

describe('processOutboxBatch — shadow mode', () => {
  it('marks the outbox simulado, leaves whatsapp_messages untouched, invents no wamid, and never calls fetch', async () => {
    const job = makeJob()
    const { admin, calls } = makeAdmin({ claimResult: { ok: true, claimed: [job] } })
    const flags = makeFlags({ mode: 'shadow' })

    const result = await processOutboxBatch({ admin, flags, workerId: 'w1' })

    expect(result.claimed).toBe(1)
    expect(result.simulated).toBe(1)
    expect(result.sent).toBe(0)

    const outboxUpdate = outboxUpdates(calls)
    expect(outboxUpdate).toHaveLength(1)
    expect(outboxUpdate[0].values).toMatchObject({ status: 'simulado' })

    expect(messageUpdates(calls)).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(adapterMock.send).not.toHaveBeenCalled()
    expect(loadChannelCredential).not.toHaveBeenCalled()

    const audits = auditInserts(calls)
    expect(audits).toHaveLength(1)
    expect(audits[0].values).toMatchObject({ decisao: 'simulado', motivo: 'modo_shadow' })
  })

  it('also stays shadow (no network) when live mode but the provider send flag is off', async () => {
    const job = makeJob()
    const { admin, calls } = makeAdmin({ claimResult: { ok: true, claimed: [job] } })
    const flags = makeFlags({ mode: 'live' })
    vi.mocked(isSendEnabledFor).mockReturnValue(false)

    const result = await processOutboxBatch({ admin, flags, workerId: 'w1' })

    expect(result.simulated).toBe(1)
    expect(adapterMock.send).not.toHaveBeenCalled()
    expect(loadChannelCredential).not.toHaveBeenCalled()
    expect(auditInserts(calls)[0].values).toMatchObject({ motivo: 'provider_send_desabilitado' })
  })
})

describe('processOutboxBatch — live success', () => {
  it('marks outbox enviado, stamps whatsapp_messages with the real wamid from the adapter, and audits enviado', async () => {
    const job = makeJob()
    const { admin, calls, messages } = makeAdmin({ claimResult: { ok: true, claimed: [job] } })
    const flags = makeFlags({ mode: 'live' })
    vi.mocked(loadChannelCredential).mockResolvedValue('secret-token')
    vi.mocked(adapterMock.send).mockResolvedValue({ providerMessageId: 'wamid.REAL123' })

    const result = await processOutboxBatch({ admin, flags, workerId: 'w1' })

    expect(result.sent).toBe(1)
    expect(adapterMock.send).toHaveBeenCalledWith({ job, credential: 'secret-token' })

    const outboxUpdate = outboxUpdates(calls)
    expect(outboxUpdate.some((c) => c.values?.status === 'enviado')).toBe(true)

    expect(messages['msg-1']).toMatchObject({ status: 'enviada', wamid: 'wamid.REAL123' })

    const audits = auditInserts(calls)
    expect(audits[0].values).toMatchObject({ decisao: 'enviado' })
    expect(audits[0].values?.detalhe).toMatchObject({ provider_message_id: 'wamid.REAL123' })
  })
})

describe('processOutboxBatch — live failure', () => {
  it('retryable (http 500): outbox falhou with next_retry_at, message untouched, audit falha_retryable', async () => {
    const job = makeJob({ attempts: 0, max_attempts: 5 })
    const { admin, calls, messages } = makeAdmin({
      claimResult: { ok: true, claimed: [job] },
      messages: { 'msg-1': { status: 'pendente' } },
    })
    const flags = makeFlags({ mode: 'live' })
    vi.mocked(loadChannelCredential).mockResolvedValue('secret-token')
    vi.mocked(adapterMock.send).mockRejectedValue(
      Object.assign(new Error('server error'), { httpStatus: 500 }),
    )

    const result = await processOutboxBatch({ admin, flags, workerId: 'w1' })

    expect(result.retried).toBe(1)
    expect(result.deadLettered).toBe(0)

    const outboxUpdate = outboxUpdates(calls)
    expect(outboxUpdate[0].values).toMatchObject({ status: 'falhou' })
    expect(outboxUpdate[0].values?.next_retry_at).toBeDefined()
    expect(outboxUpdate[0].values?.dead_letter_at).toBeUndefined()

    expect(messages['msg-1'].status).toBe('pendente')
    expect(auditInserts(calls)[0].values).toMatchObject({ decisao: 'falha_retryable' })
  })

  it('permanent (meta code 131026): outbox morto + dead_letter_at, message falhou, audit falha_permanente', async () => {
    const job = makeJob({ attempts: 0, max_attempts: 5 })
    const { admin, calls, messages } = makeAdmin({
      claimResult: { ok: true, claimed: [job] },
      messages: { 'msg-1': { status: 'pendente' } },
    })
    const flags = makeFlags({ mode: 'live' })
    vi.mocked(loadChannelCredential).mockResolvedValue('secret-token')
    vi.mocked(adapterMock.send).mockRejectedValue(
      Object.assign(new Error('undeliverable'), { code: 131026 }),
    )

    const result = await processOutboxBatch({ admin, flags, workerId: 'w1' })

    expect(result.deadLettered).toBe(1)
    expect(result.retried).toBe(0)

    const outboxUpdate = outboxUpdates(calls)
    expect(outboxUpdate[0].values).toMatchObject({ status: 'morto' })
    expect(outboxUpdate[0].values?.dead_letter_at).toBeDefined()

    expect(messages['msg-1']).toMatchObject({ status: 'falhou', erro_code: '131026' })
    expect(auditInserts(calls)[0].values).toMatchObject({ decisao: 'falha_permanente' })
  })
})

describe('processOutboxBatch — permanent business blocks (dead-letter, no network)', () => {
  const permanentBlockCases: Array<[string, Partial<OutboxJob>, boolean]> = [
    ['conversa_optout', { conversa_optout_em: '2026-07-01T00:00:00Z' }, false],
    ['canal_inativo', { canal_status: 'inativo' }, false],
    ['lead_inativo', { lead_status_saida: 'inativo' }, false],
    ['fora_da_janela_24h', {}, true],
  ]

  it.each(permanentBlockCases)(
    'dead-letters with motivo=%s and never touches the network',
    async (motivo, overrides, needsWindowOverride) => {
      if (needsWindowOverride) {
        vi.mocked(isInsideFreeFormWindow).mockReturnValue(false)
      }
      const job = makeJob(overrides)
      const { admin, calls } = makeAdmin({ claimResult: { ok: true, claimed: [job] } })
      const flags = makeFlags({ mode: 'live' })

      const result = await processOutboxBatch({ admin, flags, workerId: 'w1' })

      expect(result.blocked).toBe(1)
      const outboxUpdate = outboxUpdates(calls)
      expect(outboxUpdate[0].values).toMatchObject({ status: 'morto', last_error_code: motivo })
      expect(auditInserts(calls)[0].values).toMatchObject({ decisao: 'bloqueado', motivo })

      expect(fetchMock).not.toHaveBeenCalled()
      expect(adapterMock.send).not.toHaveBeenCalled()
      expect(loadChannelCredential).not.toHaveBeenCalled()
    },
  )
})

describe('processOutboxBatch — temporary blocks (requeue, not dead-letter)', () => {
  it('broadcast with broadcastEnabled=false goes back to pendente, not morto', async () => {
    const job = makeJob({ tipo: 'broadcast' })
    const { admin, calls } = makeAdmin({ claimResult: { ok: true, claimed: [job] } })
    const flags = makeFlags({ mode: 'live', broadcastEnabled: false })

    const result = await processOutboxBatch({ admin, flags, workerId: 'w1' })

    expect(result.blocked).toBe(1)
    const outboxUpdate = outboxUpdates(calls)
    expect(outboxUpdate[0].values).toMatchObject({
      status: 'pendente',
      claimed_by: null,
      claimed_at: null,
    })
    expect(outboxUpdate[0].values?.dead_letter_at).toBeUndefined()
    expect(auditInserts(calls)[0].values).toMatchObject({ motivo: 'broadcast_desligado' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(adapterMock.send).not.toHaveBeenCalled()
  })

  it('a number outside the pilot allowlist goes back to pendente with motivo fora_da_allowlist_piloto', async () => {
    vi.mocked(isAllowlisted).mockReturnValue(false)
    const job = makeJob()
    const { admin, calls } = makeAdmin({ claimResult: { ok: true, claimed: [job] } })
    const flags = makeFlags({ mode: 'live', pilotMode: true })
    const now = new Date('2026-07-24T12:00:00Z')

    const result = await processOutboxBatch({ admin, flags, workerId: 'w1', now })

    expect(result.blocked).toBe(1)
    const outboxUpdate = outboxUpdates(calls)
    expect(outboxUpdate[0].values).toMatchObject({ status: 'pendente' })
    expect(auditInserts(calls)[0].values).toMatchObject({ motivo: 'fora_da_allowlist_piloto' })

    // Requeue MUST carry a backoff. With next_retry_at = now the next tick
    // re-claims the job, blocks again, and audits again — an unbounded spin.
    const nextRetry = new Date(String(outboxUpdate[0]?.values?.next_retry_at)).getTime()
    expect(nextRetry).toBeGreaterThan(now.getTime())

    expect(fetchMock).not.toHaveBeenCalled()
    expect(adapterMock.send).not.toHaveBeenCalled()
  })

  it('the allowlist does NOT block the shadow pipeline — it records the would-be verdict instead', async () => {
    // The allowlist protects a real RECIPIENT. In shadow nobody receives
    // anything, so gating the simulation on it would leave the pipeline
    // permanently unexercised while pilot mode is on with an empty allowlist
    // (the default, fail-closed state).
    vi.mocked(isAllowlisted).mockReturnValue(false)
    const job = makeJob()
    const { admin, calls } = makeAdmin({ claimResult: { ok: true, claimed: [job] } })
    const flags = makeFlags({ mode: 'shadow', pilotMode: true, allowlist: [] })

    const result = await processOutboxBatch({ admin, flags, workerId: 'w1' })

    expect(result.simulated).toBe(1)
    expect(result.blocked).toBe(0)
    expect(outboxUpdates(calls)[0].values).toMatchObject({ status: 'simulado' })
    // and the audit row lets an operator preview the live decision
    expect(auditInserts(calls)[0].values).toMatchObject({ decisao: 'simulado' })
    expect(auditInserts(calls)[0]?.values?.detalhe).toMatchObject({ allowlist_ok: false })

    // still no send, no message mutation, no invented wamid
    expect(fetchMock).not.toHaveBeenCalled()
    expect(adapterMock.send).not.toHaveBeenCalled()
    expect(messageUpdates(calls)).toHaveLength(0)
  })
})

describe('processOutboxBatch — missing credential in live mode', () => {
  it('dead-letters with motivo=credencial_ausente and never reaches the adapter', async () => {
    const job = makeJob()
    const { admin, calls } = makeAdmin({ claimResult: { ok: true, claimed: [job] } })
    const flags = makeFlags({ mode: 'live' })
    // Only a genuinely absent credential (typed error) is permanent.
    vi.mocked(loadChannelCredential).mockRejectedValue(new ChannelCredentialMissingError())

    const result = await processOutboxBatch({ admin, flags, workerId: 'w1' })

    expect(result.blocked).toBe(1)
    const outboxUpdate = outboxUpdates(calls)
    expect(outboxUpdate[0].values).toMatchObject({ status: 'morto', last_error_code: 'credencial_ausente' })
    expect(auditInserts(calls)[0].values).toMatchObject({ motivo: 'credencial_ausente' })

    expect(adapterMock.send).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does NOT dead-letter when reading the credential fails transiently', async () => {
    // A database blip must not permanently kill a perfectly valid message:
    // the row stays 'processando' and lease recovery retries it later.
    const job = makeJob()
    const { admin, calls } = makeAdmin({ claimResult: { ok: true, claimed: [job] } })
    const flags = makeFlags({ mode: 'live' })
    vi.mocked(loadChannelCredential).mockRejectedValue(
      new Error('failed to read channel credential: connection reset'),
    )

    const result = await processOutboxBatch({ admin, flags, workerId: 'w1' })

    expect(result.blocked).toBe(0)
    expect(result.deadLettered).toBe(0)
    expect(result.outcomes[0]).toMatchObject({ decision: 'erro_inesperado' })
    // nothing was written to the queue: no 'morto', no dead_letter_at
    expect(outboxUpdates(calls)).toHaveLength(0)
    expect(adapterMock.send).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('processOutboxBatch — resilience', () => {
  it('one job throwing an unexpected error does not prevent the next job from being processed', async () => {
    const failingJob = makeJob({ outbox_id: 'ob-fail', message_id: 'msg-fail' })
    const okJob = makeJob({ outbox_id: 'ob-ok', message_id: 'msg-ok' })
    const { admin, calls } = makeAdmin({
      claimResult: { ok: true, claimed: [failingJob, okJob] },
      failUpdateForIds: new Set(['ob-fail']),
    })
    const flags = makeFlags({ mode: 'shadow' })

    const result = await processOutboxBatch({ admin, flags, workerId: 'w1' })

    expect(result.claimed).toBe(2)
    expect(result.outcomes).toHaveLength(2)
    expect(result.outcomes[0]).toMatchObject({ outboxId: 'ob-fail', decision: 'erro_inesperado' })
    expect(result.outcomes[1]).toMatchObject({ outboxId: 'ob-ok', decision: 'simulado' })
    expect(result.simulated).toBe(1)

    const okOutboxUpdate = outboxUpdates(calls).find((c) => c.filters?.id === 'ob-ok')
    expect(okOutboxUpdate?.values).toMatchObject({ status: 'simulado' })
  })
})

describe('processOutboxBatch — claim RPC edge cases', () => {
  it('returns a zeroed result when the claim RPC reports ok=false', async () => {
    const { admin } = makeAdmin({ claimResult: { ok: false } })
    const flags = makeFlags()
    const result = await processOutboxBatch({ admin, flags, workerId: 'w1' })
    expect(result).toEqual({
      claimed: 0,
      simulated: 0,
      sent: 0,
      retried: 0,
      deadLettered: 0,
      blocked: 0,
      outcomes: [],
    })
  })

  it('throws when the claim RPC itself errors', async () => {
    const { admin } = makeAdmin({ claimError: new Error('rpc down') })
    const flags = makeFlags()
    await expect(processOutboxBatch({ admin, flags, workerId: 'w1' })).rejects.toThrow('rpc down')
  })
})
