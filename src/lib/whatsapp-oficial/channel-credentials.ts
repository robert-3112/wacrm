import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptToken } from './crypto'
import type { Provider } from './env-flags'

/**
 * Load and decrypt a `whatsapp_channels` credential (Meta access token or
 * Evolution API key) for a single channel.
 *
 * WRITTEN FROM SCRATCH for the outbox worker (Fase 7). Called ONLY in
 * live mode, right before a send attempt — the shadow path never needs a
 * real credential. The decrypted value is returned as a plain string and
 * is meant to live only in a local variable in the caller's stack frame:
 * it must never be logged, never included in an HTTP response, never
 * serialized to JSON, and never persisted anywhere. The `select` below
 * only ever requests the single cipher column relevant to `provider` —
 * the other provider's credential column is never read.
 */
/**
 * The channel genuinely has no usable credential stored. This is a
 * PERMANENT condition — a human has to connect the channel — so the worker
 * dead-letters the job instead of retrying forever.
 *
 * Deliberately distinct from a database read failure: conflating the two
 * would let a transient Supabase blip permanently kill outbound messages
 * that were perfectly fine. A read failure throws a plain `Error`, which
 * the worker treats as transient and leaves for lease recovery.
 */
export class ChannelCredentialMissingError extends Error {
  constructor(message = 'channel_credential_missing') {
    super(message)
    this.name = 'ChannelCredentialMissingError'
  }
}

export async function loadChannelCredential(
  admin: SupabaseClient,
  canalId: string,
  provider: Provider,
): Promise<string> {
  const column = provider === 'meta_cloud' ? 'access_token_cifrado' : 'evolution_api_key_cifrado'

  const { data, error } = await admin
    .from('whatsapp_channels')
    .select(column)
    .eq('id', canalId)
    .maybeSingle()

  // Transient: do NOT report as "missing" — the credential may be perfectly
  // fine and only the read failed.
  if (error) {
    throw new Error(`failed to read channel credential: ${error.message ?? 'unknown error'}`)
  }

  const cipherValue = (data as Record<string, unknown> | null)?.[column]
  if (typeof cipherValue !== 'string' || cipherValue.length === 0) {
    throw new ChannelCredentialMissingError()
  }

  return decryptToken(cipherValue)
}
