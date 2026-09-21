import type { SupabaseClient } from '@supabase/supabase-js'
import { NotFoundError } from './api-auth'
import { loadChannelCredential } from './channel-credentials'
import { metaApiBase } from './meta-api'

interface ManagedChannel {
  id: string
  tenant_id: string
  provider: 'meta_cloud' | 'evolution'
  status: 'ativo' | 'inativo' | 'pausado'
  phone_number_id: string | null
  waba_id: string | null
  evolution_base_url: string | null
  evolution_instance: string | null
}

/** Only an owner/admin/gestor of THIS tenant may cause a secret to be decrypted. */
export async function loadManagedChannel(
  admin: SupabaseClient,
  actorUserId: string,
  canalId: string,
): Promise<ManagedChannel> {
  const { data, error } = await admin.from('whatsapp_channels')
    .select('id,tenant_id,provider,status,phone_number_id,waba_id,evolution_base_url,evolution_instance')
    .eq('id', canalId).maybeSingle()
  if (error) throw error
  const channel = data as ManagedChannel | null
  if (!channel) throw new NotFoundError('Canal não encontrado')
  const { data: allowed, error: permissionError } = await admin.rpc(
    'whatsapp_campanha_ator_autorizado',
    { p_actor_user_id: actorUserId, p_tenant_id: channel.tenant_id },
  )
  if (permissionError) throw permissionError
  if (allowed !== true) throw new NotFoundError('Canal não encontrado')
  return channel
}

export interface ChannelTestResult {
  ok: boolean
  reason?: string
  detalhe?: string
}

/** Read-only provider probes. The token never enters a response or log. */
export async function testChannelConnection(
  admin: SupabaseClient,
  channel: ManagedChannel,
): Promise<ChannelTestResult> {
  let credential: string
  try {
    credential = await loadChannelCredential(admin, channel.id, channel.provider)
  } catch {
    return { ok: false, reason: 'credencial_indisponivel' }
  }

  try {
    if (channel.provider === 'meta_cloud') {
      if (!channel.phone_number_id || !channel.waba_id ||
          !/^[0-9]{1,32}$/.test(channel.phone_number_id) || !/^[0-9]{1,32}$/.test(channel.waba_id)) {
        return { ok: false, reason: 'phone_number_id_invalido' }
      }
      const url = `${metaApiBase()}/${channel.phone_number_id}?fields=id,display_phone_number`
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${credential}` },
        signal: AbortSignal.timeout(12_000),
        redirect: 'manual',
        cache: 'no-store',
      })
      if (!response.ok) return { ok: false, reason: 'meta_nao_confirmou_numero' }
      const payload = await response.json() as { id?: unknown; display_phone_number?: unknown }
      if (payload.id !== channel.phone_number_id) {
        return { ok: false, reason: 'meta_numero_divergente' }
      }
      // A phone can be individually readable while the configured WABA ID is
      // wrong. A mismatch would break template sync and inbound routing.
      let after: string | null = null
      let belongsToWaba = false
      let complete = false
      for (let page = 0; page < 5; page++) {
        const suffix: string = after ? `&after=${encodeURIComponent(after)}` : ''
        const wabaUrl = `${metaApiBase()}/${channel.waba_id}/phone_numbers?fields=id&limit=100${suffix}`
        const wabaResponse = await fetch(wabaUrl, {
          headers: { Authorization: `Bearer ${credential}` },
          signal: AbortSignal.timeout(12_000), redirect: 'manual', cache: 'no-store',
        })
        if (!wabaResponse.ok) return { ok: false, reason: 'meta_nao_confirmou_waba' }
        const listing = await wabaResponse.json() as { data?: Array<{ id?: unknown }>; paging?: { cursors?: { after?: unknown }; next?: unknown } }
        if (!Array.isArray(listing.data)) return { ok: false, reason: 'meta_nao_confirmou_waba' }
        if (listing.data.some((item) => item.id === channel.phone_number_id)) {
          belongsToWaba = true
          break
        }
        const cursor = listing.paging?.cursors?.after
        if (!listing.paging?.next) { complete = true; break }
        if (typeof cursor !== 'string' || cursor.length > 2048 || !cursor) break
        after = cursor
      }
      if (!belongsToWaba) {
        return { ok: false, reason: complete ? 'meta_waba_divergente' : 'meta_waba_nao_confirmado' }
      }
      return {
        ok: true,
        detalhe: typeof payload.display_phone_number === 'string'
          ? payload.display_phone_number.slice(0, 40) : undefined,
      }
    }

    // The origin comes from the server environment, never from a browser or
    // an unchecked database URL. This prevents the connection test becoming SSRF.
    const configured = process.env.EVOLUTION_API_URL?.trim()
    if (!configured || !channel.evolution_base_url || !channel.evolution_instance) {
      return { ok: false, reason: 'evolution_nao_configurada_no_servidor' }
    }
    const base = new URL(configured)
    const stored = new URL(channel.evolution_base_url)
    if (base.protocol !== 'https:' || base.origin !== stored.origin || stored.pathname !== '/') {
      return { ok: false, reason: 'evolution_origem_nao_permitida' }
    }
    const url = `${base.origin}/instance/connectionState/${encodeURIComponent(channel.evolution_instance)}`
    const response = await fetch(url, {
      headers: { apikey: credential },
      signal: AbortSignal.timeout(12_000),
      redirect: 'manual',
      cache: 'no-store',
    })
    if (!response.ok) return { ok: false, reason: 'evolution_nao_confirmou_instancia' }
    const payload = await response.json() as { instance?: { instanceName?: unknown; state?: unknown } }
    if (payload.instance?.instanceName !== channel.evolution_instance) {
      return { ok: false, reason: 'evolution_instancia_divergente' }
    }
    return payload.instance.state === 'open'
      ? { ok: true, detalhe: 'Instância conectada' }
      : { ok: false, reason: 'evolution_instancia_desconectada' }
  } catch {
    return { ok: false, reason: 'provider_indisponivel' }
  }
}
