/**
 * Outbox worker (Fase 7, Sessão 1) — `processOutboxBatch` claims a batch of
 * `whatsapp_outbox` rows via the `whatsapp_oficial_outbox_claim` RPC and
 * decides, per job, whether a real provider call is allowed.
 *
 * SHADOW HONESTO is the one rule this file exists to enforce: while the
 * deployment is in shadow mode (or the specific provider's send flag is
 * off), this worker NEVER calls `getAdapter(...).send(...)` and NEVER
 * reads a channel credential. A shadow job only gets
 * `whatsapp_outbox.status = 'simulado'` plus an audit row —
 * `whatsapp_messages` is left untouched (still 'pendente') and no wamid is
 * ever invented. Only a real 2xx response from a provider adapter, reached
 * exclusively through the LIVE branch below, is allowed to write a wamid
 * or flip a message to 'enviada'.
 *
 * Barriers are checked in this order, for every job, before any network
 * call is even considered:
 *   a) permanent business block   -> dead-letter (status='morto'), no retry
 *      (canal inativo, opt-out, lead inativo, conversa encerrada, sem
 *      destinatário, adapter não configurado, fora da janela 24h da Meta)
 *   b) linked message already terminal -> outbox 'enviado', don't resend
 *   c) broadcast kill switch      -> requeue (defense in depth: the claim
 *      RPC already filters this, this is the second barrier)
 *   d) shadow mode / provider off -> 'simulado', no network, no credential
 *   e) pilot allowlist (LIVE ONLY) -> requeue (a temporary condition, not a
 *      permanent one — the number may be allowlisted later). It sits after
 *      the shadow branch because it protects a real RECIPIENT, and in shadow
 *      there is no recipient; the shadow audit row records what the live
 *      allowlist decision would have been.
 *   f) live                       -> load the credential now (ONLY here),
 *      call the adapter, then apply success/failure through the shared
 *      classification + backoff helpers in `./outbox.ts`
 *
 * Credentials only ever exist inside branch (f): `loadChannelCredential`
 * is awaited into a local `const`, handed straight to `adapter.send`, and
 * falls out of scope when the job finishes. It is never logged, never put
 * in an audit `detalhe`, and never returned from this module.
 *
 * Every job runs inside its own try/catch — one job throwing an
 * unexpected error never aborts the rest of the batch.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

import { applyOutboxFailure, applyOutboxSuccess, type MetaApiErrorInfo } from './outbox'
import { isSendEnabledFor, type WhatsappFlags } from './env-flags'
import { isAllowlisted } from './allowlist'
import { isInsideFreeFormWindow } from './meta-window'
import { getAdapter } from './adapters'
import type { OutboundAdapter, OutboxJob } from './adapters/types'
import { ChannelCredentialMissingError, loadChannelCredential } from './channel-credentials'

export interface ProcessOutboxResult {
  claimed: number
  simulated: number
  sent: number
  retried: number
  deadLettered: number
  blocked: number
  outcomes: Array<{ outboxId: string; decision: string; reason?: string }>
}

export interface ProcessOutboxBatchOpts {
  admin: SupabaseClient
  flags: WhatsappFlags
  workerId: string
  limit?: number
  leaseSeconds?: number
  now?: Date
}

type Bucket = 'simulated' | 'sent' | 'retried' | 'deadLettered' | 'blocked'

interface JobOutcome {
  outboxId: string
  decision: string
  reason?: string
}

type Decisao =
  | 'simulado'
  | 'enviado'
  | 'bloqueado'
  | 'falha_retryable'
  | 'falha_permanente'
  | 'reenfileirado'

function emptyResult(): ProcessOutboxResult {
  return { claimed: 0, simulated: 0, sent: 0, retried: 0, deadLettered: 0, blocked: 0, outcomes: [] }
}

interface AuditInput {
  job: OutboxJob
  flags: WhatsappFlags
  workerId: string
  decisao: Decisao
  motivo?: string
  detalhe?: Record<string, unknown>
}

/**
 * Append-only audit row in `whatsapp_outbound_audit`. `detalhe` never
 * carries a credential or the full message payload — at most a tag like
 * `{ tipo, provider_message_id }`. A failure to write the audit row is
 * logged and swallowed: it must never block the outbox/message update
 * that already happened, but the reverse (updating the queue without
 * auditing) is never acceptable to skip on purpose.
 */
async function registrarAuditoria(admin: SupabaseClient, input: AuditInput): Promise<void> {
  const { job, flags, workerId, decisao, motivo, detalhe } = input
  try {
    const { error } = await admin.from('whatsapp_outbound_audit').insert({
      tenant_id: job.tenant_id,
      outbox_id: job.outbox_id,
      message_id: job.message_id,
      canal_id: job.canal_id,
      provider: job.provider,
      modo: flags.mode,
      decisao,
      motivo: motivo ?? null,
      tentativa: job.attempts,
      worker_id: workerId,
      detalhe: detalhe ?? { tipo: job.tipo },
    })
    if (error) {
      console.error('[whatsapp-outbox-worker] failed to write audit row', error)
    }
  } catch (err) {
    console.error('[whatsapp-outbox-worker] unexpected audit error', err)
  }
}

async function updateOutbox(
  admin: SupabaseClient,
  outboxId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin.from('whatsapp_outbox').update(values).eq('id', outboxId)
  if (error) throw error
}

async function updateMessage(
  admin: SupabaseClient,
  messageId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin.from('whatsapp_messages').update(values).eq('id', messageId)
  if (error) throw error
}

const TERMINAL_MESSAGE_STATUSES = new Set(['entregue', 'lida', 'enviada'])

/**
 * Read-only check used by barrier (b) — never touched for jobs with no `message_id`.
 *
 * Throws on a read error instead of assuming "not terminal". Assuming
 * not-terminal would let a transient database hiccup turn into a DUPLICATE
 * SEND to a real customer, which is strictly worse than a delayed one: the
 * throw is caught by the per-job handler in `processOutboxBatch`, the row
 * stays `processando`, and the lease expiry hands it back to a later run.
 */
async function isMessageTerminal(admin: SupabaseClient, messageId: string): Promise<boolean> {
  const { data, error } = await admin
    .from('whatsapp_messages')
    .select('status')
    .eq('id', messageId)
    .maybeSingle()
  if (error) {
    throw new Error(`failed to read linked message status: ${error.message ?? 'unknown error'}`)
  }
  const status = (data as { status?: string } | null)?.status
  return status != null && TERMINAL_MESSAGE_STATUSES.has(status)
}

/**
 * Barrier (a): a permanent business reason to never attempt this job
 * again. Order matches the spec — the first matching reason wins.
 */
function detectPermanentBlock(job: OutboxJob, adapter: OutboundAdapter, now: Date): string | null {
  if (job.canal_status !== 'ativo') return 'canal_inativo'
  if (job.conversa_optout_em != null) return 'conversa_optout'
  if (job.lead_status_saida !== 'ativo') return 'lead_inativo'
  if (job.conversa_status === 'encerrada') return 'conversa_encerrada'
  if (!job.lead_whatsapp) return 'destinatario_ausente'
  if (!adapter.isConfigured(job)) return 'canal_nao_configurado'
  if (
    job.provider === 'meta_cloud' &&
    job.tipo !== 'template' &&
    !isInsideFreeFormWindow(job.ultimo_inbound_em, now)
  ) {
    return 'fora_da_janela_24h'
  }
  return null
}

async function deadLetterBlock(
  admin: SupabaseClient,
  job: OutboxJob,
  motivo: string,
  now: Date,
): Promise<void> {
  await updateOutbox(admin, job.outbox_id, {
    status: 'morto',
    dead_letter_at: now.toISOString(),
    last_error_code: motivo,
    last_error_message: motivo,
    updated_at: now.toISOString(),
  })
}

/**
 * Barriers (c) and (d): temporary conditions — put the job back in the
 * queue, don't kill it.
 *
 * `delaySeconds` is NOT optional cosmetics. Requeuing with
 * `next_retry_at = now` means the very next worker tick re-claims the job,
 * hits the same barrier, and requeues again — an unbounded spin that burns
 * a claim slot and writes an audit row every tick. Each caller passes a
 * delay long enough that the blocking condition has a realistic chance to
 * change (see BROADCAST_REQUEUE_DELAY_S / ALLOWLIST_REQUEUE_DELAY_S).
 */
async function requeue(
  admin: SupabaseClient,
  job: OutboxJob,
  now: Date,
  delaySeconds: number,
): Promise<void> {
  await updateOutbox(admin, job.outbox_id, {
    status: 'pendente',
    claimed_by: null,
    claimed_at: null,
    next_retry_at: new Date(now.getTime() + delaySeconds * 1000).toISOString(),
    updated_at: now.toISOString(),
  })
}

/**
 * Kill switch flips are a deliberate human action; the claim RPC already
 * refuses to hand out broadcast jobs while it is off, so this path is only
 * reached in a race. A short delay is enough.
 */
const BROADCAST_REQUEUE_DELAY_S = 300

/**
 * The pilot allowlist typically stays fixed for the whole pilot, so a
 * non-allowlisted recipient is blocked for a long time. The job is kept
 * alive (the message is legitimate — only the pilot restriction stops it)
 * but checked rarely, so it neither spins nor floods the audit trail.
 */
const ALLOWLIST_REQUEUE_DELAY_S = 3600

async function markSimulated(admin: SupabaseClient, job: OutboxJob, now: Date): Promise<void> {
  await updateOutbox(admin, job.outbox_id, { status: 'simulado', updated_at: now.toISOString() })
}

/** Normalizes a thrown adapter error (MetaApiError, EvolutionApiError, or a plain Error) into the shape `./outbox.ts` classifies. */
function extractErrorInfo(err: unknown): MetaApiErrorInfo {
  if (err && typeof err === 'object') {
    const e = err as { httpStatus?: unknown; code?: unknown; errorSubcode?: unknown; message?: unknown }
    return {
      httpStatus: typeof e.httpStatus === 'number' ? e.httpStatus : undefined,
      code: typeof e.code === 'number' ? e.code : undefined,
      errorSubcode: typeof e.errorSubcode === 'number' ? e.errorSubcode : undefined,
      message: typeof e.message === 'string' ? e.message : String(err),
    }
  }
  return { message: String(err) }
}

async function handleJob(
  admin: SupabaseClient,
  flags: WhatsappFlags,
  workerId: string,
  job: OutboxJob,
  now: Date,
): Promise<{ outcome: JobOutcome; bucket: Bucket }> {
  const adapter = getAdapter(job.provider)

  // a) permanent business block.
  const blockReason = detectPermanentBlock(job, adapter, now)
  if (blockReason) {
    await deadLetterBlock(admin, job, blockReason, now)
    await registrarAuditoria(admin, { job, flags, workerId, decisao: 'bloqueado', motivo: blockReason })
    return {
      outcome: { outboxId: job.outbox_id, decision: 'bloqueado', reason: blockReason },
      bucket: 'blocked',
    }
  }

  // b) the linked message already reached a terminal status — don't resend.
  if (job.message_id && (await isMessageTerminal(admin, job.message_id))) {
    await updateOutbox(admin, job.outbox_id, { status: 'enviado', updated_at: now.toISOString() })
    await registrarAuditoria(admin, {
      job,
      flags,
      workerId,
      decisao: 'bloqueado',
      motivo: 'mensagem_ja_terminal',
    })
    return {
      outcome: { outboxId: job.outbox_id, decision: 'bloqueado', reason: 'mensagem_ja_terminal' },
      bucket: 'blocked',
    }
  }

  // c) broadcast kill switch — second barrier behind the claim RPC's own filter.
  if (job.tipo === 'broadcast' && flags.broadcastEnabled !== true) {
    await requeue(admin, job, now, BROADCAST_REQUEUE_DELAY_S)
    await registrarAuditoria(admin, {
      job,
      flags,
      workerId,
      decisao: 'bloqueado',
      motivo: 'broadcast_desligado',
    })
    return {
      outcome: { outboxId: job.outbox_id, decision: 'bloqueado', reason: 'broadcast_desligado' },
      bucket: 'blocked',
    }
  }

  // d) shadow — no provider call, no credential read, whatsapp_messages untouched.
  //
  // Checked BEFORE the pilot allowlist on purpose. The allowlist exists to
  // stop a real person from RECEIVING a message; in shadow nobody receives
  // anything, so gating the simulation on it would leave the pipeline
  // permanently unexercised while pilot mode is on with an empty allowlist
  // (which is the default, fail-closed state). Instead the audit row records
  // what the live outcome WOULD have been, so an operator can preview the
  // allowlist decision without a real send.
  if (flags.mode !== 'live' || !isSendEnabledFor(job.provider, flags)) {
    const motivo = flags.mode !== 'live' ? 'modo_shadow' : 'provider_send_desabilitado'
    await markSimulated(admin, job, now)
    await registrarAuditoria(admin, {
      job,
      flags,
      workerId,
      decisao: 'simulado',
      motivo,
      detalhe: { tipo: job.tipo, allowlist_ok: isAllowlisted(job.lead_whatsapp, flags) },
    })
    return { outcome: { outboxId: job.outbox_id, decision: 'simulado', reason: motivo }, bucket: 'simulated' }
  }

  // e) pilot allowlist — live only, and temporary, so requeue rather than
  //    dead-letter: the number may be allowlisted later, or the pilot ends.
  if (!isAllowlisted(job.lead_whatsapp, flags)) {
    await requeue(admin, job, now, ALLOWLIST_REQUEUE_DELAY_S)
    await registrarAuditoria(admin, {
      job,
      flags,
      workerId,
      decisao: 'bloqueado',
      motivo: 'fora_da_allowlist_piloto',
    })
    return {
      outcome: { outboxId: job.outbox_id, decision: 'bloqueado', reason: 'fora_da_allowlist_piloto' },
      bucket: 'blocked',
    }
  }

  // f) live — the ONLY branch that reads a credential or calls a provider.
  let credential: string
  try {
    credential = await loadChannelCredential(admin, job.canal_id, job.provider)
  } catch (err) {
    // Only a genuinely absent credential is permanent. A read failure is
    // transient: rethrow so the per-job handler leaves the row 'processando'
    // for lease recovery instead of dead-lettering a valid message.
    if (!(err instanceof ChannelCredentialMissingError)) throw err
    console.error('[whatsapp-outbox-worker] channel has no stored credential', job.canal_id)
    await deadLetterBlock(admin, job, 'credencial_ausente', now)
    await registrarAuditoria(admin, {
      job,
      flags,
      workerId,
      decisao: 'bloqueado',
      motivo: 'credencial_ausente',
    })
    return {
      outcome: { outboxId: job.outbox_id, decision: 'bloqueado', reason: 'credencial_ausente' },
      bucket: 'blocked',
    }
  }

  try {
    const result = await adapter.send({ job, credential })
    await applyOutboxSuccess(admin, { id: job.outbox_id }, now)
    if (job.message_id) {
      await updateMessage(admin, job.message_id, {
        status: 'enviada',
        wamid: result.providerMessageId,
      })
    }
    await registrarAuditoria(admin, {
      job,
      flags,
      workerId,
      decisao: 'enviado',
      detalhe: { tipo: job.tipo, provider_message_id: result.providerMessageId },
    })
    return { outcome: { outboxId: job.outbox_id, decision: 'enviado' }, bucket: 'sent' }
  } catch (err) {
    const errInfo = extractErrorInfo(err)
    const failureOutcome = await applyOutboxFailure(
      admin,
      { id: job.outbox_id, attempts: job.attempts, max_attempts: job.max_attempts },
      errInfo,
      now,
    )
    if (failureOutcome.deadLettered && job.message_id) {
      await updateMessage(admin, job.message_id, {
        status: 'falhou',
        erro_code: errInfo.code !== undefined ? String(errInfo.code) : 'erro_desconhecido',
        erro_detalhe: errInfo.message ?? null,
      })
    }
    const decisao: Decisao = failureOutcome.deadLettered ? 'falha_permanente' : 'falha_retryable'
    await registrarAuditoria(admin, {
      job,
      flags,
      workerId,
      decisao,
      motivo: errInfo.message,
      detalhe: { tipo: job.tipo },
    })
    return {
      outcome: { outboxId: job.outbox_id, decision: decisao, reason: errInfo.message },
      bucket: failureOutcome.deadLettered ? 'deadLettered' : 'retried',
    }
  }
}

/**
 * Claim up to `limit` `whatsapp_outbox` rows and process each one through
 * the barrier chain documented at the top of this file. Never throws for
 * an individual job failure — only for the claim RPC itself erroring, or
 * for a bug in a queue update that should surface loudly.
 */
export async function processOutboxBatch(opts: ProcessOutboxBatchOpts): Promise<ProcessOutboxResult> {
  const { admin, flags, workerId, limit = 10, leaseSeconds = 120, now = new Date() } = opts

  const { data, error } = await admin.rpc('whatsapp_oficial_outbox_claim', {
    p_worker_id: workerId,
    p_limit: limit,
    p_lease_seconds: leaseSeconds,
  })
  if (error) throw error

  const claimResult = data as { ok?: boolean; claimed?: OutboxJob[] } | null
  if (!claimResult || claimResult.ok !== true) {
    return emptyResult()
  }

  const jobs = claimResult.claimed ?? []
  const result = emptyResult()
  result.claimed = jobs.length

  for (const job of jobs) {
    try {
      const { outcome, bucket } = await handleJob(admin, flags, workerId, job, now)
      result[bucket] += 1
      result.outcomes.push(outcome)
    } catch (err) {
      // A single job's unexpected exception must never derail the batch.
      console.error('[whatsapp-outbox-worker] unexpected error processing job', job.outbox_id, err)
      result.outcomes.push({
        outboxId: job.outbox_id,
        decision: 'erro_inesperado',
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return result
}
