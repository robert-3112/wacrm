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
    messages?: Record<string, { status: string; tenant_id?: string; conversation_id?: string; direction?: string }>
    missingMessageIds?: Set<string>
    recipients?: Record<string, Array<{ tenant_id: string; broadcast_id: string }>>
    broadcasts?: Record<string, { status: string; tenant_id: string; canal_id: string }>
    failSelectForTables?: Set<string>
    failUpdateForIds?: Set<string>
    lostClaimForIds?: Set<string>
  } = {},
) {
  const calls: MockCall[] = []
  const rpcCalls: Array<Record<string, unknown>> = []
  const messages: Record<string, { status: string; tenant_id?: string; conversation_id?: string; direction?: string }> = { ...(opts.messages ?? {}) }

  const admin = {
    rpc: async (_name: string, args: Record<string, unknown>) => {
      rpcCalls.push(args)
      if (opts.claimError) return { data: null, error: opts.claimError }
      return { data: opts.claimResult ?? { ok: true, claimed: [] }, error: null }
    },
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => {
        const filters: Record<string, unknown> = {}
        const query = {
          eq(column: string, id: string) {
            filters[column] = id
            return query
          },
          in(column: string, values: string[]) {
            filters[column] = values
            return query
          },
          then<TResult1 = { error: null; count: number }, TResult2 = never>(
            onfulfilled?: ((value: { error: null; count: number }) => TResult1 | PromiseLike<TResult1>) | null,
            onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
          ) {
            calls.push({ table, op: 'update', values, filters: { ...filters } })
            const id = filters.id as string
            if (opts.failUpdateForIds?.has(id)) {
              return Promise.reject(new Error(`simulated update failure for ${id}`)).then(onfulfilled, onrejected)
            }
            const allowedStatuses = filters.status as string[] | undefined
            const currentStatus = messages[id]?.status ?? 'pendente'
            const currentTenant = messages[id]?.tenant_id ?? 't-1'
            const currentConversation = messages[id]?.conversation_id ?? 'conv-1'
            const count = opts.lostClaimForIds?.has(id) ||
              (table === 'whatsapp_messages' && (
                (allowedStatuses && !allowedStatuses.includes(currentStatus)) ||
                (filters.tenant_id && filters.tenant_id !== currentTenant) ||
                (filters.conversation_id && filters.conversation_id !== currentConversation)
              ))
              ? 0 : 1
            if (count && table === 'whatsapp_messages') {
              messages[id] = { ...(messages[id] ?? { status: 'pendente' }), ...values } as { status: string }
            }
            return Promise.resolve({ error: null, count }).then(onfulfilled, onrejected)
          },
        }
        return query
      },
      insert: (values: Record<string, unknown>) => {
        calls.push({ table, op: 'insert', values })
        return Promise.resolve({ error: null })
      },
      select: () => ({
        eq: (column: string, id: string) => ({
          limit: async (count: number) => {
            calls.push({ table, op: 'select', filters: { [column]: id } })
            if (opts.failSelectForTables?.has(table)) {
              return { data: null, error: { message: 'simulated read failure' } }
            }
            return {
              data: table === 'whatsapp_broadcast_recipients'
                ? (opts.recipients?.[id] ?? []).slice(0, count)
                : [],
              error: null,
            }
          },
          maybeSingle: async () => {
            calls.push({ table, op: 'select', filters: { [column]: id } })
            if (opts.failSelectForTables?.has(table)) {
              return { data: null, error: { message: 'simulated read failure' } }
            }
            if (table === 'whatsapp_messages') {
              if (opts.missingMessageIds?.has(id)) return { data: null, error: null }
              return { data: {
                tenant_id: messages[id]?.tenant_id ?? 't-1',
                conversation_id: messages[id]?.conversation_id ?? 'conv-1',
                direction: messages[id]?.direction ?? 'outbound',
                status: messages[id]?.status ?? 'pendente',
              }, error: null }
            }
            if (table === 'whatsapp_broadcasts') {
              return { data: opts.broadcasts?.[id] ?? null, error: null }
            }
            return { data: null, error: null }
          },
        }),
      }),
    }),
  }

  return { admin: admin as unknown as SupabaseClient, calls, messages, rpcCalls }
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
    expect(outboxUpdate.find((c) => c.values?.status === 'enviado')?.filters).toMatchObject({
      id: 'ob-1', claimed_by: 'w1', status: 'processando',
    })

    expect(messages['msg-1']).toMatchObject({ status: 'enviada', wamid: 'wamid.REAL123' })
    expect(messageUpdates(calls)[0].filters).toMatchObject({
      id: 'msg-1', tenant_id: 't-1', conversation_id: 'conv-1',
    })

    // A ORDEM é contrato: a mensagem grava antes da fila. Um crash entre as
    // duas escritas deixa a fila em processando para reconciliação; o wamid
    // persistido permite fechar a fila sem novo envio. Na ordem inversa o
    // crash deixaria outbox=enviado com a mensagem pendente.
    const idxMensagem = calls.findIndex(
      (c) => c.table === 'whatsapp_messages' && c.op === 'update',
    )
    const idxFila = calls.findIndex(
      (c) => c.table === 'whatsapp_outbox' && c.op === 'update' && c.values?.status === 'enviado',
    )
    expect(idxMensagem).toBeGreaterThanOrEqual(0)
    expect(idxFila).toBeGreaterThan(idxMensagem)

    const audits = auditInserts(calls)
    expect(audits[0].values).toMatchObject({ decisao: 'enviado' })
    expect(audits[0].values?.detalhe).toMatchObject({ provider_message_id: 'wamid.REAL123' })
  })

  it('preserves an entregue receipt that arrives before the provider response is recorded', async () => {
    const job = makeJob()
    const { admin, calls, messages } = makeAdmin({ claimResult: { ok: true, claimed: [job] } })
    vi.mocked(loadChannelCredential).mockResolvedValue('secret-token')
    vi.mocked(adapterMock.send).mockImplementation(async () => {
      messages['msg-1'] = { status: 'entregue' }
      return { providerMessageId: 'wamid.REAL123' }
    })

    const result = await processOutboxBatch({ admin, flags: makeFlags({ mode: 'live' }), workerId: 'w1' })

    expect(result.sent).toBe(1)
    expect(messages['msg-1'].status).toBe('entregue')
    expect(messageUpdates(calls)[0].filters?.status).toEqual(['pendente', 'falhou'])
    expect(outboxUpdates(calls).some((call) => call.values?.status === 'enviado')).toBe(true)
  })

  it('stamps send completion using the time after the provider responds', async () => {
    const startedAt = new Date('2026-09-16T12:00:00Z')
    const completedAt = new Date('2026-09-16T12:00:15Z')
    vi.useFakeTimers()
    try {
      vi.setSystemTime(startedAt)
      const { admin, calls } = makeAdmin({ claimResult: { ok: true, claimed: [makeJob()] } })
      vi.mocked(loadChannelCredential).mockResolvedValue('secret-token')
      vi.mocked(adapterMock.send).mockImplementation(async () => {
        vi.setSystemTime(completedAt)
        return { providerMessageId: 'wamid.LATER' }
      })

      const result = await processOutboxBatch({ admin, flags: makeFlags({ mode: 'live' }), workerId: 'w1' })
      expect(result.sent).toBe(1)
      expect(outboxUpdates(calls).find((c) => c.values?.status === 'enviado')?.values?.updated_at)
        .toBe(completedAt.toISOString())
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('processOutboxBatch — linked message isolation', () => {
  it.each([
    ['outro tenant', { status: 'pendente', tenant_id: 't-2' }],
    ['outra conversa', { status: 'pendente', conversation_id: 'conv-2' }],
    ['mensagem inbound', { status: 'recebida', direction: 'inbound' }],
  ])('blocks %s before provider contact', async (_label, linkedMessage) => {
    const { admin, calls } = makeAdmin({
      claimResult: { ok: true, claimed: [makeJob()] },
      messages: { 'msg-1': linkedMessage },
    })
    const result = await processOutboxBatch({ admin, flags: makeFlags({ mode: 'live' }), workerId: 'w1' })

    expect(result.blocked).toBe(1)
    expect(result.outcomes[0]).toMatchObject({ decision: 'bloqueado', reason: 'mensagem_vinculo_invalido' })
    expect(outboxUpdates(calls)[0].values).toMatchObject({ status: 'morto' })
    expect(messageUpdates(calls)).toHaveLength(0)
    expect(adapterMock.send).not.toHaveBeenCalled()
    expect(loadChannelCredential).not.toHaveBeenCalled()
  })

  it('blocks a missing linked message before provider contact', async () => {
    const { admin, calls } = makeAdmin({
      claimResult: { ok: true, claimed: [makeJob()] },
      missingMessageIds: new Set(['msg-1']),
    })
    const result = await processOutboxBatch({ admin, flags: makeFlags({ mode: 'live' }), workerId: 'w1' })

    expect(result.outcomes[0]).toMatchObject({ decision: 'bloqueado', reason: 'mensagem_vinculo_invalido' })
    expect(outboxUpdates(calls)[0].values).toMatchObject({ status: 'morto' })
    expect(adapterMock.send).not.toHaveBeenCalled()
  })
})

describe('processOutboxBatch — live failure', () => {
  it('retryable (http 429): outbox falhou with next_retry_at, message untouched, audit falha_retryable', async () => {
    const job = makeJob({ attempts: 0, max_attempts: 5 })
    const { admin, calls, messages } = makeAdmin({
      claimResult: { ok: true, claimed: [job] },
      messages: { 'msg-1': { status: 'pendente' } },
    })
    const flags = makeFlags({ mode: 'live' })
    const now = new Date('2026-07-24T12:00:00Z')
    vi.mocked(loadChannelCredential).mockResolvedValue('secret-token')
    vi.mocked(adapterMock.send).mockRejectedValue(
      Object.assign(new Error('rate limited'), { httpStatus: 429 }),
    )

    const result = await processOutboxBatch({ admin, flags, workerId: 'w1', now })

    expect(result.retried).toBe(1)
    expect(result.deadLettered).toBe(0)

    const outboxUpdate = outboxUpdates(calls)
    expect(outboxUpdate[0].values).toMatchObject({ status: 'falhou' })
    // Primeira falha (attempts 0): backoff de 30s com full jitter [0.5, 1] —
    // o retry cai entre now+15s e now+30s. `toBeDefined()` deixava passar um
    // next_retry_at = now (spin) ou = now+6h (mensagem esquecida).
    const nextRetryMs = new Date(String(outboxUpdate[0].values?.next_retry_at)).getTime()
    expect(nextRetryMs).toBeGreaterThanOrEqual(now.getTime() + 15_000)
    expect(nextRetryMs).toBeLessThanOrEqual(now.getTime() + 30_000)
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
    const now = new Date('2026-07-24T12:00:00Z')
    vi.mocked(loadChannelCredential).mockResolvedValue('secret-token')
    vi.mocked(adapterMock.send).mockRejectedValue(
      Object.assign(new Error('undeliverable'), { code: 131026 }),
    )

    const result = await processOutboxBatch({ admin, flags, workerId: 'w1', now })

    expect(result.deadLettered).toBe(1)
    expect(result.retried).toBe(0)

    const outboxUpdate = outboxUpdates(calls)
    expect(outboxUpdate[0].values).toMatchObject({
      status: 'morto',
      // dead-letter carimba o instante da decisão, não um valor qualquer
      dead_letter_at: now.toISOString(),
    })

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

describe('processOutboxBatch — janela de 24h da Meta usa isTemplateJob, não job.tipo', () => {
  // Regressão: a barreira testava `job.tipo !== 'template'` por conta própria, divergindo do
  // predicado que o adapter meta_cloud usa para decidir se envia como template. Um job de
  // campanha (`tipo = 'broadcast'`) com `template_name` no payload morria em dead-letter como
  // 'fora_da_janela_24h' sem nunca chegar ao adapter — sendo que template é exatamente o que a
  // Meta permite fora da janela. `isTemplateJob` (real, não mockado) é a única fonte de verdade.
  //
  // Campanhas TÊM de continuar com `tipo = 'broadcast'` para que a RPC de claim as mantenha
  // atrás do kill switch, então quem tinha de mudar era a barreira.
  beforeEach(() => {
    vi.mocked(isInsideFreeFormWindow).mockReturnValue(false)
  })

  it('broadcast COM template_name fora da janela não morre — chega em simulado no shadow', async () => {
    const job = makeJob({ tipo: 'broadcast', payload: { template_name: 'oferta_lancamento' } })
    const { admin, calls } = makeAdmin({
      claimResult: { ok: true, claimed: [job] },
      recipients: { 'ob-1': [{ tenant_id: 't-1', broadcast_id: 'campaign-1' }] },
      broadcasts: { 'campaign-1': { tenant_id: 't-1', canal_id: 'canal-1', status: 'enviando' } },
    })
    // Kill switch de broadcast LIGADO: a barreira (c) não é o que está sendo testado aqui.
    const flags = makeFlags({ mode: 'shadow', broadcastEnabled: true })

    const result = await processOutboxBatch({ admin, flags, workerId: 'w1' })

    expect(result.simulated).toBe(1)
    expect(result.blocked).toBe(0)
    expect(result.deadLettered).toBe(0)

    const outboxUpdate = outboxUpdates(calls)
    expect(outboxUpdate).toHaveLength(1)
    expect(outboxUpdate[0].values).toMatchObject({ status: 'simulado' })
    expect(outboxUpdate[0].values?.dead_letter_at).toBeUndefined()
    expect(auditInserts(calls)[0].values).toMatchObject({
      decisao: 'simulado',
      motivo: 'modo_shadow',
    })

    // shadow honesto: nada de rede, nada de credencial, whatsapp_messages intacta
    expect(fetchMock).not.toHaveBeenCalled()
    expect(adapterMock.send).not.toHaveBeenCalled()
    expect(loadChannelCredential).not.toHaveBeenCalled()
    expect(messageUpdates(calls)).toHaveLength(0)
  })

  it('broadcast SEM template_name fora da janela CONTINUA morrendo com fora_da_janela_24h', async () => {
    // A proteção da Meta não pode ter sido afrouxada: texto livre fora da janela é rejeitado
    // pela API e queima reputação do número.
    const job = makeJob({ tipo: 'broadcast', payload: { content: 'promoção!', message_type: 'text' } })
    const { admin, calls } = makeAdmin({ claimResult: { ok: true, claimed: [job] } })
    const flags = makeFlags({ mode: 'live', broadcastEnabled: true })

    const result = await processOutboxBatch({ admin, flags, workerId: 'w1' })

    expect(result.blocked).toBe(1)
    expect(result.simulated).toBe(0)
    expect(outboxUpdates(calls)[0].values).toMatchObject({
      status: 'morto',
      last_error_code: 'fora_da_janela_24h',
    })
    expect(auditInserts(calls)[0].values).toMatchObject({
      decisao: 'bloqueado',
      motivo: 'fora_da_janela_24h',
    })
    expect(adapterMock.send).not.toHaveBeenCalled()
    expect(loadChannelCredential).not.toHaveBeenCalled()
  })

  it('mensagem avulsa fora da janela continua morrendo (nada regrediu)', async () => {
    const job = makeJob({ tipo: 'mensagem' })
    const { admin, calls } = makeAdmin({ claimResult: { ok: true, claimed: [job] } })
    const flags = makeFlags({ mode: 'live' })

    const result = await processOutboxBatch({ admin, flags, workerId: 'w1' })

    expect(result.blocked).toBe(1)
    expect(outboxUpdates(calls)[0].values).toMatchObject({
      status: 'morto',
      last_error_code: 'fora_da_janela_24h',
    })
    expect(adapterMock.send).not.toHaveBeenCalled()
  })

  it('tipo=template fora da janela também passa (o outro braço do predicado)', async () => {
    const job = makeJob({ tipo: 'template', payload: { template_name: 'boas_vindas' } })
    const { admin, calls } = makeAdmin({ claimResult: { ok: true, claimed: [job] } })
    const flags = makeFlags({ mode: 'shadow' })

    const result = await processOutboxBatch({ admin, flags, workerId: 'w1' })

    expect(result.simulated).toBe(1)
    expect(result.blocked).toBe(0)
    expect(outboxUpdates(calls)[0].values).toMatchObject({ status: 'simulado' })
  })

  it('provider evolution fora da janela NÃO é bloqueado — a regra é só da Meta', async () => {
    const job = makeJob({
      provider: 'evolution',
      phone_number_id: null,
      waba_id: null,
      evolution_base_url: 'https://evo.local',
      evolution_instance: 'sunt',
    })
    const { admin, calls } = makeAdmin({ claimResult: { ok: true, claimed: [job] } })
    const flags = makeFlags({ mode: 'shadow' })

    const result = await processOutboxBatch({ admin, flags, workerId: 'w1' })

    expect(result.blocked).toBe(0)
    expect(result.simulated).toBe(1)
    expect(outboxUpdates(calls)[0].values).toMatchObject({ status: 'simulado' })
  })
})

describe('processOutboxBatch — temporary blocks (requeue, not dead-letter)', () => {
  it('does not send a claimed broadcast when its campaign was paused', async () => {
    const job = makeJob({ tipo: 'broadcast', payload: { template_name: 'oferta', broadcast_id: 'campaign-1' } })
    const { admin, calls } = makeAdmin({
      claimResult: { ok: true, claimed: [job] },
      recipients: { 'ob-1': [{ tenant_id: 't-1', broadcast_id: 'campaign-1' }] },
      broadcasts: { 'campaign-1': { tenant_id: 't-1', canal_id: 'canal-1', status: 'pausado' } },
    })
    const flags = makeFlags({ mode: 'live', broadcastEnabled: true })
    const now = new Date('2026-09-16T12:00:00Z')

    const result = await processOutboxBatch({ admin, flags, workerId: 'w1', now })

    expect(result.blocked).toBe(1)
    expect(result.outcomes[0]).toMatchObject({ decision: 'bloqueado', reason: 'campanha_pausada' })
    expect(outboxUpdates(calls)[0].values).toMatchObject({ status: 'pendente' })
    expect(new Date(String(outboxUpdates(calls)[0].values?.next_retry_at)).getTime())
      .toBeGreaterThan(now.getTime())
    expect(auditInserts(calls)[0].values).toMatchObject({ motivo: 'campanha_pausada' })
    expect(adapterMock.send).not.toHaveBeenCalled()
    expect(loadChannelCredential).not.toHaveBeenCalled()
  })

  it('does not turn a database failure after provider 2xx into a retryable provider failure', async () => {
    const job = makeJob()
    const { admin, calls } = makeAdmin({
      claimResult: { ok: true, claimed: [job] },
      failUpdateForIds: new Set(['msg-1']),
    })
    vi.mocked(loadChannelCredential).mockResolvedValue('secret-token')
    vi.mocked(adapterMock.send).mockResolvedValue({ providerMessageId: 'wamid.ACCEPTED' })

    const result = await processOutboxBatch({ admin, flags: makeFlags({ mode: 'live' }), workerId: 'w1' })

    expect(result.outcomes[0].decision).toBe('erro_inesperado')
    expect(outboxUpdates(calls)).toHaveLength(0)
    expect(auditInserts(calls)).toHaveLength(0)
    expect(adapterMock.send).toHaveBeenCalledTimes(1)
  })

  it('quarantines ambiguous timeout/5xx without retry and leaves linked message for reconciliation', async () => {
    const job = makeJob({ attempts: 0, max_attempts: 5 })
    const { admin, calls, messages } = makeAdmin({
      claimResult: { ok: true, claimed: [job] },
      messages: { 'msg-1': { status: 'pendente' } },
    })
    vi.mocked(loadChannelCredential).mockResolvedValue('secret-token')
    vi.mocked(adapterMock.send).mockRejectedValue(
      Object.assign(new Error('upstream timeout'), { httpStatus: 503 }),
    )

    const result = await processOutboxBatch({ admin, flags: makeFlags({ mode: 'live' }), workerId: 'w1' })

    expect(result.retried).toBe(0)
    expect(result.deadLettered).toBe(1)
    expect(outboxUpdates(calls)[0].values).toMatchObject({
      status: 'morto', last_error_code: 'resultado_incerto',
    })
    expect(outboxUpdates(calls)[0].values).not.toHaveProperty('next_retry_at')
    expect(messages['msg-1'].status).toBe('pendente')
    expect(auditInserts(calls)[0].values).toMatchObject({
      decisao: 'falha_permanente', motivo: 'resultado_incerto',
    })
  })

  it('cancels an already claimed outbox job when its campaign was cancelled', async () => {
    const job = makeJob({ tipo: 'broadcast', payload: { template_name: 'oferta' } })
    const { admin, calls } = makeAdmin({
      claimResult: { ok: true, claimed: [job] },
      recipients: { 'ob-1': [{ tenant_id: 't-1', broadcast_id: 'campaign-1' }] },
      broadcasts: { 'campaign-1': { tenant_id: 't-1', canal_id: 'canal-1', status: 'cancelado' } },
    })
    const result = await processOutboxBatch({ admin, flags: makeFlags({ mode: 'live' }), workerId: 'w1' })

    expect(result.outcomes[0]).toMatchObject({ decision: 'bloqueado', reason: 'campanha_cancelada' })
    expect(outboxUpdates(calls)[0].values).toMatchObject({ status: 'cancelado' })
    expect(adapterMock.send).not.toHaveBeenCalled()
    expect(loadChannelCredential).not.toHaveBeenCalled()
  })

  it.each(['aprovado', 'enviando'])('permits broadcast when campaign is %s', async (status) => {
    const job = makeJob({ tipo: 'broadcast', payload: { template_name: 'oferta' } })
    const { admin } = makeAdmin({
      claimResult: { ok: true, claimed: [job] },
      recipients: { 'ob-1': [{ tenant_id: 't-1', broadcast_id: 'campaign-1' }] },
      broadcasts: { 'campaign-1': { tenant_id: 't-1', canal_id: 'canal-1', status } },
    })
    vi.mocked(loadChannelCredential).mockResolvedValue('secret-token')
    vi.mocked(adapterMock.send).mockResolvedValue({ providerMessageId: 'wamid.REAL123' })

    const result = await processOutboxBatch({ admin, flags: makeFlags({ mode: 'live' }), workerId: 'w1' })

    expect(result.sent).toBe(1)
    expect(adapterMock.send).toHaveBeenCalledOnce()
  })

  it.each(['whatsapp_broadcast_recipients', 'whatsapp_broadcasts'])(
    'never sends when reading %s fails',
    async (table) => {
      const job = makeJob({ tipo: 'broadcast', payload: { template_name: 'oferta' } })
      const { admin, calls } = makeAdmin({
        claimResult: { ok: true, claimed: [job] },
        recipients: { 'ob-1': [{ tenant_id: 't-1', broadcast_id: 'campaign-1' }] },
        broadcasts: { 'campaign-1': { tenant_id: 't-1', canal_id: 'canal-1', status: 'enviando' } },
        failSelectForTables: new Set([table]),
      })

      const result = await processOutboxBatch({ admin, flags: makeFlags({ mode: 'live' }), workerId: 'w1' })

      expect(result.retried).toBe(1)
      expect(result.outcomes[0]).toMatchObject({ decision: 'reenfileirado', reason: 'falha_pre_envio' })
      expect(outboxUpdates(calls)[0].values).toMatchObject({ status: 'pendente', claimed_by: null })
      expect(auditInserts(calls)[0].values).toMatchObject({ decisao: 'reenfileirado', motivo: 'falha_pre_envio' })
      expect(adapterMock.send).not.toHaveBeenCalled()
      expect(loadChannelCredential).not.toHaveBeenCalled()
    },
  )

  it('keeps an unlinked campaign job for investigation without sending or spinning', async () => {
    const job = makeJob({ tipo: 'broadcast', payload: { template_name: 'oferta' } })
    const { admin, calls } = makeAdmin({ claimResult: { ok: true, claimed: [job] } })
    const now = new Date('2026-09-16T12:00:00Z')
    const result = await processOutboxBatch({ admin, flags: makeFlags({ mode: 'live' }), workerId: 'w1', now })

    expect(result.outcomes[0]).toMatchObject({ decision: 'bloqueado', reason: 'campanha_vinculo_invalido' })
    expect(outboxUpdates(calls)[0].values).toMatchObject({ status: 'pendente' })
    expect(new Date(String(outboxUpdates(calls)[0].values?.next_retry_at)).getTime())
      .toBeGreaterThanOrEqual(now.getTime() + 3600_000)
    expect(adapterMock.send).not.toHaveBeenCalled()
  })

  it('rechecks campaign after loading credentials to catch a pause during processing', async () => {
    const job = makeJob({ tipo: 'broadcast', payload: { template_name: 'oferta' } })
    const campaign = { tenant_id: 't-1', canal_id: 'canal-1', status: 'enviando' }
    const { admin, calls } = makeAdmin({
      claimResult: { ok: true, claimed: [job] },
      recipients: { 'ob-1': [{ tenant_id: 't-1', broadcast_id: 'campaign-1' }] },
      broadcasts: { 'campaign-1': campaign },
    })
    vi.mocked(loadChannelCredential).mockImplementation(async () => {
      campaign.status = 'pausado'
      return 'secret-token'
    })

    const result = await processOutboxBatch({ admin, flags: makeFlags({ mode: 'live' }), workerId: 'w1' })

    expect(result.outcomes[0]).toMatchObject({ decision: 'bloqueado', reason: 'campanha_pausada' })
    expect(outboxUpdates(calls)[0].values).toMatchObject({ status: 'pendente' })
    expect(adapterMock.send).not.toHaveBeenCalled()
  })

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

  it('requeues when reading the credential fails transiently before provider contact', async () => {
    // A database blip must not permanently kill a perfectly valid message:
    // provider contact has not started, so a fenced update can safely retry it later.
    const job = makeJob()
    const { admin, calls } = makeAdmin({ claimResult: { ok: true, claimed: [job] } })
    const flags = makeFlags({ mode: 'live' })
    vi.mocked(loadChannelCredential).mockRejectedValue(
      new Error('failed to read channel credential: connection reset'),
    )

    const result = await processOutboxBatch({ admin, flags, workerId: 'w1' })

    expect(result.blocked).toBe(0)
    expect(result.deadLettered).toBe(0)
    expect(result.retried).toBe(1)
    expect(result.outcomes[0]).toMatchObject({ decision: 'reenfileirado', reason: 'falha_pre_envio' })
    expect(outboxUpdates(calls)[0].values).toMatchObject({ status: 'pendente', claimed_by: null })
    expect(outboxUpdates(calls)[0].values?.dead_letter_at).toBeUndefined()
    expect(auditInserts(calls)[0].values).toMatchObject({ decisao: 'reenfileirado', motivo: 'falha_pre_envio' })
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
  it('limits a live claim to one job and at least a 120s lease', async () => {
    const { admin, rpcCalls } = makeAdmin()
    await processOutboxBatch({ admin, flags: makeFlags({ mode: 'live' }), workerId: 'w1', limit: 50, leaseSeconds: 30 })
    expect(rpcCalls[0]).toMatchObject({ p_limit: 1, p_lease_seconds: 120 })
  })

  it('does not count a closure if the claimed worker/status no longer matches', async () => {
    const job = makeJob()
    const { admin, calls } = makeAdmin({
      claimResult: { ok: true, claimed: [job] },
      lostClaimForIds: new Set(['ob-1']),
    })
    const result = await processOutboxBatch({ admin, flags: makeFlags(), workerId: 'w1' })
    expect(result.simulated).toBe(0)
    expect(result.outcomes[0].decision).toBe('erro_inesperado')
    expect(outboxUpdates(calls)[0].filters).toMatchObject({ claimed_by: 'w1', status: 'processando' })
    expect(auditInserts(calls)).toHaveLength(0)
  })
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
