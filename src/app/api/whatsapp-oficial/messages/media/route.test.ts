import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

const mocks = vi.hoisted(() => ({
  requireConversationAccess: vi.fn(),
  uploadMedia: vi.fn(),
  loadChannelCredential: vi.fn(),
}))

vi.mock('@/lib/whatsapp-oficial/api-auth', async () => ({
  ...await vi.importActual<typeof import('@/lib/whatsapp-oficial/api-auth')>('@/lib/whatsapp-oficial/api-auth'),
  requireConversationAccess: mocks.requireConversationAccess,
}))
vi.mock('@/lib/whatsapp-oficial/meta-api', async () => ({
  ...await vi.importActual<typeof import('@/lib/whatsapp-oficial/meta-api')>('@/lib/whatsapp-oficial/meta-api'),
  uploadMedia: mocks.uploadMedia,
}))
vi.mock('@/lib/whatsapp-oficial/channel-credentials', async () => ({
  ...await vi.importActual<typeof import('@/lib/whatsapp-oficial/channel-credentials')>('@/lib/whatsapp-oficial/channel-credentials'),
  loadChannelCredential: mocks.loadChannelCredential,
}))

import { UnauthorizedError } from '@/lib/whatsapp-oficial/api-auth'
import { GET, POST } from './route'

const REQUEST_ID = 'b5a9a4df-98d4-4290-9fc4-16fd1c6e03a1'
const NOW = new Date().toISOString()
const FILE_SHA256 = createHash('sha256').update(new Uint8Array([0xff, 0xd8, 0xff, 0x00])).digest('hex')
const stagedMessage = {
  id: 'msg-1', tenant_id: 'sunt', conversation_id: '11111111-1111-4111-8111-111111111111', direction: 'outbound',
  message_type: 'image', content: 'Fachada', media_url: '/api/whatsapp-oficial/media/1234567890',
  media_mime_type: 'image/jpeg', status: 'pendente', enviado_por: 'user-1',
  client_request_id: REQUEST_ID, media_filename: null, media_sha256: FILE_SHA256,
}

function makeAdmin(overrides: Record<string, unknown> = {}) {
  const rows: Record<string, unknown> = {
    whatsapp_messages: null,
    whatsapp_conversations: { id: '11111111-1111-4111-8111-111111111111', status: 'aberta', optout_em: null },
    whatsapp_channels: { id: 'channel-1', tenant_id: 'sunt', provider: 'meta_cloud', status: 'ativo', phone_number_id: 'PNID' },
    leads: { id: 'lead-1', tenant_id: 'sunt', status_saida: 'ativo', whatsapp: '5511999999999' },
    inbound: { wpp_timestamp: NOW, created_at: NOW },
    ...overrides,
  }
  const admin = {
    from: vi.fn((table: string) => {
      const filters: Record<string, unknown> = {}
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn((field: string, value: unknown) => { filters[field] = value; return query }),
        order: vi.fn(() => query),
        limit: vi.fn(() => query),
        maybeSingle: vi.fn(async () => ({
          data: table === 'whatsapp_messages' && filters.direction === 'inbound'
            ? rows.inbound : rows[table],
          error: null,
        })),
      }
      return query
    }),
    rpc: vi.fn().mockResolvedValue({ data: { ok: true, message: stagedMessage, replayed: false }, error: null }),
  }
  return admin
}

function authorize(admin: ReturnType<typeof makeAdmin>) {
  mocks.requireConversationAccess.mockResolvedValue({
    userId: 'user-1', conversation: {
      id: '11111111-1111-4111-8111-111111111111', tenant_id: 'sunt', canal_id: 'channel-1', lead_id: 'lead-1', status: 'aberta',
    }, admin,
  })
}

function request(file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0x00])], 'foto.jpg', { type: 'image/jpeg' })) {
  const form = new FormData()
  form.set('file', file)
  form.set('caption', 'Fachada')
  return new Request('http://localhost/api/whatsapp-oficial/messages/media', {
    method: 'POST', body: form,
    headers: { 'x-conversation-id': '11111111-1111-4111-8111-111111111111', 'x-client-request-id': REQUEST_ID },
  })
}

describe('POST /api/whatsapp-oficial/messages/media', () => {
  beforeEach(() => {
    vi.stubEnv('WHATSAPP_MEDIA_SEND_ENABLED', 'true')
    vi.stubEnv('WHATSAPP_OUTBOUND_MODE', 'live')
    vi.stubEnv('WHATSAPP_META_SEND_ENABLED', 'true')
    vi.stubEnv('WHATSAPP_PILOT_MODE', 'false')
    __resetRateLimitForTests()
    mocks.requireConversationAccess.mockReset()
    mocks.uploadMedia.mockReset().mockResolvedValue({ mediaId: '1234567890' })
    mocks.loadChannelCredential.mockReset().mockResolvedValue('test-token')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('does not parse/upload when no user is authorized for the conversation', async () => {
    mocks.requireConversationAccess.mockRejectedValue(new UnauthorizedError())
    const res = await POST(request())
    expect(res.status).toBe(401)
    expect(mocks.uploadMedia).not.toHaveBeenCalled()
  })

  it('does not upload when live media sending is disabled', async () => {
    const admin = makeAdmin(); authorize(admin)
    vi.stubEnv('WHATSAPP_MEDIA_SEND_ENABLED', 'false')
    const res = await POST(request())
    expect(res.status).toBe(409)
    expect(mocks.uploadMedia).not.toHaveBeenCalled()
  })

  it('replays the same actor request without uploading again', async () => {
    const admin = makeAdmin({ whatsapp_messages: stagedMessage }); authorize(admin)
    const res = await POST(request())
    expect(res.status).toBe(200)
    expect((await res.json()).replayed).toBe(true)
    expect(mocks.uploadMedia).not.toHaveBeenCalled()
  })

  it('refuses a request id that belongs to another actor', async () => {
    const admin = makeAdmin({ whatsapp_messages: { ...stagedMessage, enviado_por: 'user-2' } }); authorize(admin)
    const res = await POST(request())
    expect(res.status).toBe(409)
    expect(mocks.uploadMedia).not.toHaveBeenCalled()
  })

  it('does not upload when the 24-hour window is closed', async () => {
    const admin = makeAdmin({ inbound: { wpp_timestamp: '2020-01-01T00:00:00Z', created_at: '2020-01-01T00:00:00Z' } }); authorize(admin)
    const res = await POST(request())
    expect(res.status).toBe(409)
    expect(mocks.uploadMedia).not.toHaveBeenCalled()
  })

  it('rejects a fake PDF before upload', async () => {
    const admin = makeAdmin(); authorize(admin)
    const res = await POST(request(new File(['<script>'], 'planta.pdf', { type: 'application/pdf' })))
    expect(res.status).toBe(400)
    expect(mocks.uploadMedia).not.toHaveBeenCalled()
  })

  it('uploads to Meta and enqueues media with actor and request id atomically', async () => {
    const admin = makeAdmin(); authorize(admin)
    const res = await POST(request())
    expect(res.status).toBe(201)
    expect(mocks.uploadMedia).toHaveBeenCalledWith(expect.objectContaining({
      phoneNumberId: 'PNID', accessToken: 'test-token', filename: 'foto.jpg',
    }))
    expect(admin.rpc).toHaveBeenCalledWith('whatsapp_oficial_enfileirar_midia', {
      p_conversation_id: '11111111-1111-4111-8111-111111111111', p_actor_user_id: 'user-1', p_media_id: '1234567890',
      p_media_kind: 'image', p_media_mime_type: 'image/jpeg', p_media_filename: 'foto.jpg',
      p_caption: 'Fachada', p_client_request_id: REQUEST_ID, p_media_sha256: FILE_SHA256,
    })
  })

  it('never uploads a second time when the request body exceeds the size cap', async () => {
    const admin = makeAdmin(); authorize(admin)
    const req = request()
    const oversized = new Request(req, { headers: {
      'x-conversation-id': '11111111-1111-4111-8111-111111111111', 'x-client-request-id': REQUEST_ID,
      'content-type': req.headers.get('content-type')!, 'content-length': String(17 * 1024 * 1024),
    } })
    const res = await POST(oversized)
    expect(res.status).toBe(413)
    expect(mocks.uploadMedia).not.toHaveBeenCalled()
  })
})

describe('GET /api/whatsapp-oficial/messages/media', () => {
  it('is disabled by default', async () => {
    vi.stubEnv('WHATSAPP_MEDIA_SEND_ENABLED', '')
    const res = await GET()
    expect(await res.json()).toEqual({ enabled: false })
    vi.unstubAllEnvs()
  })
})

