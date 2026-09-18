import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(), supabaseAdmin: vi.fn(), decryptToken: vi.fn(),
  getMediaUrl: vi.fn(), downloadMedia: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }))
vi.mock('@/lib/whatsapp-oficial/supabase-admin', () => ({ supabaseAdmin: mocks.supabaseAdmin }))
vi.mock('@/lib/whatsapp-oficial/crypto', () => ({ decryptToken: mocks.decryptToken }))
vi.mock('@/lib/whatsapp-oficial/meta-api', () => ({
  getMediaUrl: mocks.getMediaUrl, downloadMedia: mocks.downloadMedia,
}))

import { GET } from './route'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

function query(data: unknown) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => ({ data, error: null })),
  }
  return builder
}

describe('official media relay for inbound and outbound messages', () => {
  beforeEach(() => {
    __resetRateLimitForTests()
    vi.clearAllMocks()
    const message = query({ id: 'm1', tenant_id: 'sunt', conversation_id: 'c1' })
    mocks.createClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'u1' } }, error: null }) },
      from: vi.fn(() => message),
    })
    const conversation = query({ canal_id: 'ch1' })
    const channel = query({ access_token_cifrado: 'encrypted' })
    mocks.supabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => table === 'whatsapp_conversations' ? conversation : channel),
    })
    mocks.decryptToken.mockReturnValue('test-token')
    mocks.getMediaUrl.mockResolvedValue({ url: 'https://graph.facebook.com/media', mimeType: 'image/jpeg' })
    mocks.downloadMedia.mockResolvedValue({ buffer: new Uint8Array([0xff, 0xd8]).buffer, contentType: 'image/jpeg' })
  })

  it('relays an RLS-visible outbound media ID using a tenant-matched channel', async () => {
    const res = await GET(new Request('http://localhost/media/1234567890'),
      { params: Promise.resolve({ mediaId: '1234567890' }) })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/jpeg')
    expect(mocks.getMediaUrl).toHaveBeenCalledWith({ mediaId: '1234567890', accessToken: 'test-token' })
    const admin = mocks.supabaseAdmin.mock.results[0].value
    const conversation = admin.from.mock.results[0].value
    const channel = admin.from.mock.results[1].value
    expect(conversation.eq).toHaveBeenCalledWith('tenant_id', 'sunt')
    expect(channel.eq).toHaveBeenCalledWith('tenant_id', 'sunt')
  })

  it('rejects a non-numeric media ID before looking up any message', async () => {
    const res = await GET(new Request('http://localhost/media/not-an-id'),
      { params: Promise.resolve({ mediaId: 'not-an-id' }) })
    expect(res.status).toBe(400)
    expect(mocks.createClient).not.toHaveBeenCalled()
  })
})
