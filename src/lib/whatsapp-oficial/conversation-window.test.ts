import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readConversationWindow } from './conversation-window'

const conversation = { id: 'conversation', tenant_id: 'tenant', canal_id: 'channel' }
const now = new Date('2026-09-22T12:00:00Z')
function db(provider: string, inbound: string | null, error = false) {
  const channel = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() }
  channel.select.mockReturnValue(channel); channel.eq.mockReturnValue(channel)
  channel.maybeSingle.mockResolvedValue({ data: { provider }, error: null })
  const messages = { select: vi.fn(), eq: vi.fn(), not: vi.fn(), order: vi.fn(), limit: vi.fn(), maybeSingle: vi.fn() }
  for (const key of ['select', 'eq', 'not', 'order', 'limit'] as const) messages[key].mockReturnValue(messages)
  messages.maybeSingle.mockResolvedValue({ data: inbound ? { wpp_timestamp: inbound } : null, error: error ? new Error('db') : null })
  const from = vi.fn((table: string) => table === 'whatsapp_channels' ? channel : messages)
  return { client: { from } as unknown as SupabaseClient, channel, messages, from }
}
describe('readConversationWindow', () => {
  it('uses the latest provider inbound within the authorized tenant and conversation', async () => {
    const d = db('meta_cloud','2026-09-22T11:00:00Z')
    expect(await readConversationWindow(d.client, conversation, now)).toMatchObject({ applies: true, open: true, expiresAt: '2026-09-23T11:00:00.000Z' })
    expect(d.channel.eq).toHaveBeenCalledWith('tenant_id','tenant')
    expect(d.messages.eq).toHaveBeenCalledWith('tenant_id','tenant')
    expect(d.messages.eq).toHaveBeenCalledWith('conversation_id','conversation')
    expect(d.messages.eq).toHaveBeenCalledWith('direction','inbound')
    expect(d.messages.order).toHaveBeenCalledWith('wpp_timestamp',{ ascending: false })
    expect(d.messages.limit).toHaveBeenCalledWith(1)
  })
  it.each([null,'2026-09-21T12:00:00Z','2026-09-23T12:00:00Z'])('does not open a window for missing, expired or future inbound %s',async (inbound) => {
    expect((await readConversationWindow(db('meta_cloud',inbound).client, conversation, now)).open).toBe(false)
  })
  it('does not impose Meta window on Evolution', async () => {
    const d=db('evolution',null)
    expect(await readConversationWindow(d.client, conversation, now)).toMatchObject({ applies:false,open:true,expiresAt:null })
    expect(d.from).not.toHaveBeenCalledWith('whatsapp_messages')
  })
  it('fails closed on database error',async () => {
    await expect(readConversationWindow(db('meta_cloud',null,true).client,conversation,now)).rejects.toThrow('db')
  })
})
