/**
 * `evolution` outbound adapter — sends a claimed `whatsapp_outbox` job
 * through a self-hosted Evolution API instance (unofficial WhatsApp API).
 *
 * WRITTEN FROM SCRATCH — greenfield, nothing in the WACRM harvest matrix
 * covers Evolution. Only the `POST /message/sendText/{instance}` endpoint
 * (Evolution API v2 contract) is implemented, matching what the worker
 * currently needs for a plain text send. `EvolutionApiError` deliberately
 * mirrors the shape of `MetaApiErrorInfo` from `../outbox` (an `httpStatus`
 * field) so the same `classifyMetaError` retryable/permanent classifier
 * works for both providers without a second classification path.
 *
 * The API key (`credential`) is passed straight through to the `apikey`
 * header and is never logged, never included in a thrown error message,
 * and never persisted.
 */

import type { AdapterSendResult, OutboundAdapter, OutboxJob } from './types'

/** Thrown on any non-2xx response from the Evolution API. */
export class EvolutionApiError extends Error {
  readonly httpStatus: number
  readonly providerCode?: string

  constructor(message: string, opts: { httpStatus: number; providerCode?: string }) {
    super(message)
    this.name = 'EvolutionApiError'
    this.httpStatus = opts.httpStatus
    this.providerCode = opts.providerCode
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

interface EvolutionSendTextResponse {
  key?: { id?: string }
  id?: string
  message?: string
  error?: string
}

async function send(args: { job: OutboxJob; credential: string }): Promise<AdapterSendResult> {
  const { job, credential } = args

  const to = asString(job.lead_whatsapp)
  if (!to) throw new Error('evolution adapter: missing recipient phone number')

  const baseUrl = asString(job.evolution_base_url)
  const instance = asString(job.evolution_instance)
  if (!baseUrl || !instance) {
    throw new Error('evolution adapter: missing evolution_base_url or evolution_instance')
  }

  const content = asString(job.payload.content)
  if (!content) throw new Error('evolution adapter: missing content in payload')

  const url = `${stripTrailingSlash(baseUrl)}/message/sendText/${instance}`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: credential,
    },
    body: JSON.stringify({ number: to, text: content }),
  })

  let data: EvolutionSendTextResponse = {}
  try {
    data = (await response.json()) as EvolutionSendTextResponse
  } catch {
    // Non-JSON body — keep the generic fallback message below.
  }

  if (!response.ok) {
    throw new EvolutionApiError(data.message ?? data.error ?? `Evolution API error: ${response.status}`, {
      httpStatus: response.status,
    })
  }

  const providerMessageId = data.key?.id ?? data.id
  if (!providerMessageId) {
    throw new Error('evolution adapter: missing message id in response')
  }

  return { providerMessageId }
}

export const evolutionAdapter: OutboundAdapter = {
  provider: 'evolution',
  isConfigured(job: OutboxJob): boolean {
    return asString(job.evolution_base_url) !== undefined && asString(job.evolution_instance) !== undefined
  },
  send,
}
