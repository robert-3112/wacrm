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
 *   d) campaign status             -> requeue paused/unknown, cancel cancelled
 *   e) shadow mode / provider off -> 'simulado', no network, no credential
 *   f) pilot allowlist (LIVE ONLY) -> requeue (a temporary condition, not a
 *      permanent one — the number may be allowlisted later). It sits after
 *      the shadow branch because it protects a real RECIPIENT, and in shadow
 *      there is no recipient; the shadow audit row records what the live
 *      allowlist decision would have been.
 *   g) live                       -> load the credential now (ONLY here),
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

import { applyOutboxFailure, applyOutboxSuccess, updateClaimedOutbox, type MetaApiErrorInfo } from './outbox'
import { isSendEnabledFor, type WhatsappFlags } from './env-flags'
import { isAllowlisted } from './allowlist'
import { isInsideFreeFormWindow } from './meta-window'
import { getAdapter } from './adapters'
import { isTemplateJob } from './adapters/meta-cloud'
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
  workerId: string,
  values: Record<string, unknown>,
): Promise<void> {
  await updateClaimedOutbox(admin, outboxId, workerId, values)
}

async function updateMessage(
  admin: SupabaseClient,
  job: OutboxJob,
  values: Record<string, unknown>,
): Promise<void> {
  if (!job.message_id || !job.conversation_id) throw new Error('invalid_linked_message')
  // A receipt may arrive before this write. Never move entregue/lida back to
  // enviada (or falhou) because the provider response finished later.
  const { error, count } = await admin
    .from('whatsapp_messages')
    .update(values, { count: 'exact' })
    .eq('id', job.message_id)
    .eq('tenant_id', job.tenant_id)
    .eq('conversation_id', job.conversation_id)
    .in('status', ['pendente', 'falhou'])
  if (error) throw error
  if (count === 1) return
  // Count=0 is acceptable only if a receipt already made this SAME linked
  // message terminal. Any other case remains claimed for reconciliation.
  if (count === 0 && (await readLinkedMessageState(admin, job)) === 'terminal') return
  throw new Error('linked_message_update_not_applied')
}

const TERMINAL_MESSAGE_STATUSES = new Set(['entregue', 'lida', 'enviada'])

/**
 * Read-only check used by barrier (b) — never touched for jobs with no `message_id`.
 *
 * Throws on a read error instead of assuming "not terminal". The row stays
 * out of the provider path; the outer worker safely requeues it before any
 * provider contact. A transient database hiccup must never authorize a send.
 */
async function readLinkedMessageState(
  admin: SupabaseClient,
  job: OutboxJob,
): Promise<'pending' | 'terminal' | 'invalid'> {
  if (!job.message_id || !job.conversation_id) return 'invalid'
  const { data, error } = await admin
    .from('whatsapp_messages')
    .select('status,tenant_id,conversation_id,direction')
    .eq('id', job.message_id)
    .maybeSingle()
  if (error) {
    throw new Error(`failed to read linked message status: ${error.message ?? 'unknown error'}`)
  }
  const message = data as {
    status?: string; tenant_id?: string; conversation_id?: string; direction?: string
  } | null
  if (
    !message || message.tenant_id !== job.tenant_id ||
    message.conversation_id !== job.conversation_id || message.direction !== 'outbound'
  ) return 'invalid'
  return message.status != null && TERMINAL_MESSAGE_STATUSES.has(message.status)
    ? 'terminal' : 'pending'
}

/**
 * Barrier (a): a permanent business reason to never attempt this job
 * again. Order matches the spec — the first matching reason wins.
 */
function detectPermanentBlock(job: OutboxJob, adapter: OutboundAdapter, now: Date): string | null {
  if (job.conversa_optout_em != null) return 'conversa_optout'
  if (job.lead_status_saida !== 'ativo') return 'lead_inativo'
  if (job.conversa_status === 'encerrada') return 'conversa_encerrada'
  if (!job.lead_whatsapp) return 'destinatario_ausente'
  if (!adapter.isConfigured(job)) return 'canal_nao_configurado'
  // Fora da janela de 24h a Meta só aceita template. `isTemplateJob` é o MESMO predicado que o
  // adapter meta_cloud usa para decidir se envia como template — antes esta barreira testava
  // `job.tipo !== 'template'` por conta própria, e um job de campanha (tipo='broadcast') com
  // template_name no payload morria aqui, em dead-letter, sem nunca chegar ao adapter.
  if (
    job.provider === 'meta_cloud' &&
    !isTemplateJob(job) &&
    !isInsideFreeFormWindow(job.ultimo_inbound_em, now)
  ) {
    return 'fora_da_janela_24h'
  }
  return null
}

async function deadLetterBlock(
  admin: SupabaseClient,
  job: OutboxJob,
  workerId: string,
  motivo: string,
  now: Date,
): Promise<void> {
  await updateOutbox(admin, job.outbox_id, workerId, {
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
  workerId: string,
  now: Date,
  delaySeconds: number,
): Promise<void> {
  await updateOutbox(admin, job.outbox_id, workerId, {
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
const CAMPAIGN_REQUEUE_DELAY_S = 300
const CAMPAIGN_INVALID_REQUEUE_DELAY_S = 3600
const PREFLIGHT_REQUEUE_DELAY_S = 300
const CHANNEL_REQUEUE_DELAY_S = 300

/** Recheck the channel after a claim and just before provider I/O. A pause
 * racing with claim must preserve the queued message, not dead-letter it. */
async function channelIsActive(admin: SupabaseClient, job: OutboxJob): Promise<boolean> {
  const { data, error } = await admin.from('whatsapp_channels')
    .select('status,tenant_id')
    .eq('id', job.canal_id)
    .maybeSingle()
  if (error) throw new Error(`failed to read channel status: ${error.message}`)
  if (!data || data.tenant_id !== job.tenant_id) throw new Error('channel_link_invalid')
  return data.status === 'ativo'
}

type CampaignState = 'active' | 'paused' | 'cancelled' | 'invalid'

/** The recipient relation is authoritative: an outbox payload alone cannot identify its campaign. */
async function readCampaignState(admin: SupabaseClient, job: OutboxJob): Promise<CampaignState> {
  const { data: recipients, error: recipientError } = await admin
    .from('whatsapp_broadcast_recipients')
    .select('tenant_id,broadcast_id')
    .eq('outbox_id', job.outbox_id)
    .limit(2)
  if (recipientError) throw new Error(`failed to read broadcast recipient: ${recipientError.message}`)
  if (!recipients || recipients.length !== 1 || recipients[0].tenant_id !== job.tenant_id) {
    return 'invalid'
  }

  const { data: campaign, error: campaignError } = await admin
    .from('whatsapp_broadcasts')
    .select('status,tenant_id,canal_id')
    .eq('id', recipients[0].broadcast_id)
    .maybeSingle()
  if (campaignError) throw new Error(`failed to read broadcast status: ${campaignError.message}`)
  if (!campaign || campaign.tenant_id !== job.tenant_id || campaign.canal_id !== job.canal_id) {
    return 'invalid'
  }
  if (campaign.status === 'cancelado') return 'cancelled'
  if (campaign.status === 'pausado') return 'paused'
  return campaign.status === 'aprovado' || campaign.status === 'enviando' ? 'active' : 'invalid'
}

async function guardCampaign(
  admin: SupabaseClient,
  flags: WhatsappFlags,
  workerId: string,
  job: OutboxJob,
  now: Date,
): Promise<{ outcome: JobOutcome; bucket: Bucket } | null> {
  if (job.tipo !== 'broadcast') return null
  const state = await readCampaignState(admin, job)
  if (state === 'active') return null
  if (state === 'cancelled') {
    await updateOutbox(admin, job.outbox_id, workerId, { status: 'cancelado', updated_at: now.toISOString() })
    await registrarAuditoria(admin, { job, flags, workerId, decisao: 'bloqueado', motivo: 'campanha_cancelada' })
    return {
      outcome: { outboxId: job.outbox_id, decision: 'bloqueado', reason: 'campanha_cancelada' },
      bucket: 'blocked',
    }
  }
  const reason = state === 'paused' ? 'campanha_pausada' : 'campanha_vinculo_invalido'
  await requeue(admin, job, workerId, now, state === 'paused' ? CAMPAIGN_REQUEUE_DELAY_S : CAMPAIGN_INVALID_REQUEUE_DELAY_S)
  await registrarAuditoria(admin, { job, flags, workerId, decisao: 'bloqueado', motivo: reason })
  return { outcome: { outboxId: job.outbox_id, decision: 'bloqueado', reason }, bucket: 'blocked' }
}

async function markSimulated(admin: SupabaseClient, job: OutboxJob, workerId: string, now: Date): Promise<void> {
  await updateOutbox(admin, job.outbox_id, workerId, { status: 'simulado', updated_at: now.toISOString() })
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
  clock: () => Date,
  onProviderAttempt: () => void,
): Promise<{ outcome: JobOutcome; bucket: Bucket }> {
  const now = clock()
  const adapter = getAdapter(job.provider)

  // Older claims can carry a paused snapshot. Do not make that a permanent
  // business failure: resume should send the same job once it is eligible.
  if (job.canal_status !== 'ativo') {
    await requeue(admin, job, workerId, now, CHANNEL_REQUEUE_DELAY_S)
    await registrarAuditoria(admin, { job, flags, workerId, decisao: 'bloqueado', motivo: 'canal_pausado' })
    return { outcome: { outboxId: job.outbox_id, decision: 'bloqueado', reason: 'canal_pausado' }, bucket: 'blocked' }
  }

  // a) permanent business block.
  const blockReason = detectPermanentBlock(job, adapter, now)
  if (blockReason) {
    await deadLetterBlock(admin, job, workerId, blockReason, now)
    await registrarAuditoria(admin, { job, flags, workerId, decisao: 'bloqueado', motivo: blockReason })
    return {
      outcome: { outboxId: job.outbox_id, decision: 'bloqueado', reason: blockReason },
      bucket: 'blocked',
    }
  }

  // b) a linked message must belong to this tenant/conversation and be outbound.
  if (job.message_id) {
    const messageState = await readLinkedMessageState(admin, job)
    if (messageState === 'invalid') {
      await deadLetterBlock(admin, job, workerId, 'mensagem_vinculo_invalido', now)
      await registrarAuditoria(admin, {
        job, flags, workerId, decisao: 'bloqueado', motivo: 'mensagem_vinculo_invalido',
      })
      return {
        outcome: { outboxId: job.outbox_id, decision: 'bloqueado', reason: 'mensagem_vinculo_invalido' },
        bucket: 'blocked',
      }
    }
    if (messageState === 'terminal') {
      await updateOutbox(admin, job.outbox_id, workerId, { status: 'enviado', updated_at: now.toISOString() })
      await registrarAuditoria(admin, {
        job, flags, workerId, decisao: 'bloqueado', motivo: 'mensagem_ja_terminal',
      })
      return {
        outcome: { outboxId: job.outbox_id, decision: 'bloqueado', reason: 'mensagem_ja_terminal' },
        bucket: 'blocked',
      }
    }
  }

  // c) broadcast kill switch — second barrier behind the claim RPC's own filter.
  if (job.tipo === 'broadcast' && flags.broadcastEnabled !== true) {
    await requeue(admin, job, workerId, now, BROADCAST_REQUEUE_DELAY_S)
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

  // A claim may predate a pause/cancellation. Do not let already queued jobs bypass it.
  const campaignBlock = await guardCampaign(admin, flags, workerId, job, now)
  if (campaignBlock) return campaignBlock

  // A pause can land after the database selected candidates. Check again
  // before even simulating, so shadow runs preserve the pending job too.
  if (!await channelIsActive(admin, job)) {
    await requeue(admin, job, workerId, now, CHANNEL_REQUEUE_DELAY_S)
    await registrarAuditoria(admin, { job, flags, workerId, decisao: 'bloqueado', motivo: 'canal_pausado' })
    return { outcome: { outboxId: job.outbox_id, decision: 'bloqueado', reason: 'canal_pausado' }, bucket: 'blocked' }
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
    await markSimulated(admin, job, workerId, now)
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
    await requeue(admin, job, workerId, now, ALLOWLIST_REQUEUE_DELAY_S)
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
    // transient: rethrow so the outer handler can requeue before provider contact.
    if (!(err instanceof ChannelCredentialMissingError)) throw err
    console.error('[whatsapp-outbox-worker] channel has no stored credential', job.canal_id)
    await deadLetterBlock(admin, job, workerId, 'credencial_ausente', now)
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

  // A pause can be committed while the credential is loading. Narrow that race
  // by reading the campaign again immediately before the provider call.
  const lastCampaignBlock = await guardCampaign(admin, flags, workerId, job, now)
  if (lastCampaignBlock) return lastCampaignBlock

  if (!await channelIsActive(admin, job)) {
    await requeue(admin, job, workerId, now, CHANNEL_REQUEUE_DELAY_S)
    await registrarAuditoria(admin, { job, flags, workerId, decisao: 'bloqueado', motivo: 'canal_pausado' })
    return { outcome: { outboxId: job.outbox_id, decision: 'bloqueado', reason: 'canal_pausado' }, bucket: 'blocked' }
  }

  let providerMessageId: string
  try {
    // From this point onward an exception may hide an accepted provider send.
    // Never automatically requeue this job based on the exception alone.
    onProviderAttempt()
    const result = await adapter.send({ job, credential })
    providerMessageId = result.providerMessageId
  } catch (err) {
    const errInfo = extractErrorInfo(err)
    const failedAt = clock()
    const failureOutcome = await applyOutboxFailure(
      admin,
      { id: job.outbox_id, attempts: job.attempts, max_attempts: job.max_attempts },
      errInfo,
      failedAt,
      workerId,
    )
    // An uncertain result might actually have been accepted. Do not label the
    // linked message "failed" or offer a blind resend before reconciliation.
    if (failureOutcome.deadLettered && failureOutcome.errorClass !== 'uncertain' && job.message_id) {
      await updateMessage(admin, job, {
        status: 'falhou',
        erro_code: errInfo.code !== undefined ? String(errInfo.code) : 'erro_desconhecido',
        erro_detalhe: errInfo.message ?? null,
      })
    }
    const decisao: Decisao = failureOutcome.deadLettered ? 'falha_permanente' : 'falha_retryable'
    const motivo = failureOutcome.errorClass === 'uncertain' ? 'resultado_incerto' : errInfo.message
    await registrarAuditoria(admin, {
      job,
      flags,
      workerId,
      decisao,
      motivo,
      detalhe: { tipo: job.tipo },
    })
    return {
      outcome: { outboxId: job.outbox_id, decision: decisao, reason: motivo },
      bucket: failureOutcome.deadLettered ? 'deadLettered' : 'retried',
    }
  }

  // Persistence is deliberately outside the provider catch. A database
  // failure after a 2xx must leave this claimed job for manual reconciliation,
  // never turn it into a retryable provider failure.
  const completedAt = clock()
  // Store provider evidence in the linked message before closing the queue.
  // If the process crashes between writes, the queue remains `processando`
  // and requires reconciliation; it must not be reclaimed blindly.
  if (job.message_id) {
    await updateMessage(admin, job, {
      status: 'enviada',
      wamid: providerMessageId,
    })
  }
  await applyOutboxSuccess(admin, { id: job.outbox_id }, completedAt, workerId)
  await registrarAuditoria(admin, {
    job,
    flags,
    workerId,
    decisao: 'enviado',
    detalhe: { tipo: job.tipo, provider_message_id: providerMessageId },
  })
  return { outcome: { outboxId: job.outbox_id, decision: 'enviado' }, bucket: 'sent' }
}

/**
 * Claim up to `limit` `whatsapp_outbox` rows and process each one through
 * the barrier chain documented at the top of this file. Never throws for
 * an individual job failure — only for the claim RPC itself erroring, or
 * for a bug in a queue update that should surface loudly.
 */
export async function processOutboxBatch(opts: ProcessOutboxBatchOpts): Promise<ProcessOutboxResult> {
  const { admin, flags, workerId, limit = 10, leaseSeconds = 120 } = opts
  const clock = opts.now ? () => opts.now! : () => new Date()
  // Until the claim/finalization contract is fully fenced in the database,
  // send one live job per invocation. A longer lease covers provider timeout
  // and database bookkeeping; it is not an exactly-once guarantee.
  const claimLimit = flags.mode === 'live' ? 1 : limit
  const effectiveLeaseSeconds = flags.mode === 'live' ? Math.max(leaseSeconds, 120) : leaseSeconds

  const { data, error } = await admin.rpc('whatsapp_oficial_outbox_claim', {
    p_worker_id: workerId,
    p_limit: claimLimit,
    p_lease_seconds: effectiveLeaseSeconds,
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
    let providerAttemptStarted = false
    try {
      const { outcome, bucket } = await handleJob(admin, flags, workerId, job, clock, () => {
        providerAttemptStarted = true
      })
      result[bucket] += 1
      result.outcomes.push(outcome)
    } catch (err) {
      // A single job's unexpected exception must never derail the batch.
      console.error('[whatsapp-outbox-worker] unexpected error processing job', job.outbox_id, err)
      if (!providerAttemptStarted) {
        try {
          await requeue(admin, job, workerId, clock(), PREFLIGHT_REQUEUE_DELAY_S)
          await registrarAuditoria(admin, {
            job, flags, workerId, decisao: 'reenfileirado', motivo: 'falha_pre_envio',
          })
          result.retried += 1
          result.outcomes.push({ outboxId: job.outbox_id, decision: 'reenfileirado', reason: 'falha_pre_envio' })
          continue
        } catch (requeueError) {
          // A failed fenced update cannot prove who owns this row now. Leave
          // it claimed for explicit reconciliation; never send it again here.
          console.error('[whatsapp-outbox-worker] failed to requeue pre-send job', job.outbox_id, requeueError)
        }
      }
      result.outcomes.push({
        outboxId: job.outbox_id,
        decision: 'erro_inesperado',
        reason: 'reconciliacao_necessaria',
      })
    }
  }

  return result
}
