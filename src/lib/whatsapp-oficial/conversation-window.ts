import type { SupabaseClient } from '@supabase/supabase-js'
import { isInsideFreeFormWindow, META_FREE_FORM_WINDOW_MS } from './meta-window'

export interface ConversationWindow {
  applies: boolean
  open: boolean
  expiresAt: string | null
  serverTime: string
}

/** Call only after proving conversation access. Never infer from the paginated UI history. */
export async function readConversationWindow(
  admin: SupabaseClient,
  conversation: { id: string; tenant_id: string; canal_id: string },
  now = new Date(),
): Promise<ConversationWindow> {
  const { data: channel, error: channelError } = await admin.from('whatsapp_channels')
    .select('provider').eq('id', conversation.canal_id).eq('tenant_id', conversation.tenant_id).maybeSingle()
  if (channelError) throw channelError
  if (!channel || !['meta_cloud', 'evolution'].includes(channel.provider)) throw new Error('Canal indisponível')
  if (channel.provider === 'evolution') {
    return { applies: false, open: true, expiresAt: null, serverTime: now.toISOString() }
  }
  const { data: inbound, error } = await admin.from('whatsapp_messages')
    .select('wpp_timestamp').eq('tenant_id', conversation.tenant_id)
    .eq('conversation_id', conversation.id).eq('direction', 'inbound')
    .not('wpp_timestamp', 'is', null).order('wpp_timestamp', { ascending: false }).limit(1).maybeSingle()
  if (error) throw error
  const timestamp = inbound?.wpp_timestamp
  const open = isInsideFreeFormWindow(timestamp, now)
  return {
    applies: true, open,
    expiresAt: open && timestamp ? new Date(Date.parse(timestamp) + META_FREE_FORM_WINDOW_MS).toISOString() : null,
    serverTime: now.toISOString(),
  }
}
