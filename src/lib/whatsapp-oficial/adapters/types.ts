/**
 * Shared types for the outbound provider adapters (`meta_cloud` and
 * `evolution`).
 *
 * WRITTEN FROM SCRATCH for the outbox worker (Fase 7). `OutboxJob` mirrors
 * the shape returned by the RPC `whatsapp_oficial_outbox_claim` field for
 * field — it never carries a credential, only the metadata a provider
 * adapter needs to build a request. `Provider` is re-exported from
 * `../env-flags` rather than redefined here so the two modules can never
 * drift apart on the set of supported providers.
 */

export type { Provider } from '../env-flags'

import type { Provider } from '../env-flags'

/** One claimed row from `whatsapp_oficial_outbox_claim`. No credential fields. */
export interface OutboxJob {
  outbox_id: string
  tenant_id: string
  canal_id: string
  conversation_id: string | null
  message_id: string | null
  tipo: 'mensagem' | 'template' | 'broadcast'
  payload: Record<string, unknown>
  attempts: number
  max_attempts: number
  provider: Provider
  canal_status: 'ativo' | 'inativo' | 'pausado'
  phone_number_id: string | null
  waba_id: string | null
  evolution_base_url: string | null
  evolution_instance: string | null
  lead_id: string | null
  lead_whatsapp: string | null
  lead_status_saida: string | null
  conversa_status: 'aberta' | 'pendente' | 'encerrada' | null
  conversa_optout_em: string | null
  ultimo_inbound_em: string | null
}

/** Result of a successful send — the provider's own message id. */
export interface AdapterSendResult {
  providerMessageId: string
}

/**
 * A provider-specific outbound adapter. `send` receives the already
 * decrypted credential (access token or API key) as a plain string in
 * memory — the adapter must never log it, persist it, or include it in
 * any thrown error message.
 */
export interface OutboundAdapter {
  provider: Provider
  isConfigured(job: OutboxJob): boolean
  send(args: { job: OutboxJob; credential: string }): Promise<AdapterSendResult>
}
