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
import { MetaApiError } from '@/lib/whatsapp-oficial/meta-api'
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
    whatsapp_conversations: { id: '11111111-1111-4111-8111-111111111111', status: 'aberta', optout_em: null, sophia_ativa: false },
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
    rpc: vi.fn().mockImplementation(async (name: string) => name === 'whatsapp_sophia_definir_estado'
      ? { data: { ok: true, sophia_ativa: false, in_flight_replies: 0 }, error: null }
      : { data: { ok: true, message: stagedMessage, replayed: false }, error: null }),
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

function request(
  file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0x00])], 'foto.jpg', { type: 'image/jpeg' }),
  caption = 'Fachada',
) {
  const form = new FormData()
  form.set('file', file)
  form.set('caption', caption)
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

  it('pauses an active Sophia before enqueueing, and does not enqueue if the pause fails', async () => {
    const conversation = { id: '11111111-1111-4111-8111-111111111111', status: 'aberta', optout_em: null, sophia_ativa: true }
    const admin = makeAdmin({ whatsapp_conversations: conversation }); authorize(admin)
    admin.rpc.mockImplementation(async (name: string) => name === 'whatsapp_sophia_definir_estado'
      ? { data: { ok: true, sophia_ativa: false, cancelled_replies: 0, in_flight_replies: 2 }, error: null }
      : { data: { ok: true, message: stagedMessage, replayed: false }, error: null })
    const res = await POST(request())
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ sophia_pausada: true, in_flight_replies: 2 })
    expect(admin.rpc.mock.calls.map(([name]) => name))
      .toEqual(['whatsapp_sophia_definir_estado', 'whatsapp_oficial_enfileirar_midia'])

    __resetRateLimitForTests()
    const failing = makeAdmin({ whatsapp_conversations: conversation }); authorize(failing)
    failing.rpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'db down' } })
    expect((await POST(request())).status).toBe(500)
    expect(failing.rpc).toHaveBeenCalledTimes(1)
  })

  it('queues a captionless MP3 as audio', async () => {
    const admin = makeAdmin(); authorize(admin)
    const audio = new File([new Uint8Array([0xff, 0xfb, 0x90, 0x64])],
      'corretor.mp3', { type: 'audio/mpeg' })
    const res = await POST(request(audio, ''))
    expect(res.status).toBe(201)
    expect(admin.rpc).toHaveBeenCalledWith('whatsapp_oficial_enfileirar_midia',
      expect.objectContaining({ p_media_kind: 'audio', p_media_mime_type: 'audio/mpeg', p_caption: '' }))
  })

  it('rejects MP3 captions before uploading', async () => {
    const admin = makeAdmin(); authorize(admin)
    const audio = new File([new Uint8Array([0xff, 0xfb, 0x90, 0x64])],
      'corretor.mp3', { type: 'audio/mpeg' })
    const res = await POST(request(audio, 'Uma legenda'))
    expect(res.status).toBe(400)
    expect(mocks.uploadMedia).not.toHaveBeenCalled()
  })

  it('queues an MP4 with a caption as video', async () => {
    const admin = makeAdmin(); authorize(admin)
    const box = (type: string, payload: number[]) => {
      const bytes = new Uint8Array(payload.length + 8)
      new DataView(bytes.buffer).setUint32(0, bytes.length)
      bytes.set(new TextEncoder().encode(type), 4)
      bytes.set(payload, 8)
      return bytes
    }
    const video = new File([new Uint8Array([
      ...box('ftyp', [...new TextEncoder().encode('isom'), 0, 0, 0, 0]),
      ...box('moov', [0, 1]), ...box('mdat', [1, 2]),
    ])], 'tour.mp4', { type: 'video/mp4' })
    const res = await POST(request(video, 'Tour do apartamento'))
    expect(res.status).toBe(201)
    expect(admin.rpc).toHaveBeenCalledWith('whatsapp_oficial_enfileirar_midia',
      expect.objectContaining({ p_media_kind: 'video', p_media_mime_type: 'video/mp4',
        p_caption: 'Tour do apartamento' }))
  })

  it('explains a Meta rejection of an MP4 before enqueueing', async () => {
    const admin = makeAdmin(); authorize(admin)
    const box = (type: string, payload: number[]) => {
      const bytes = new Uint8Array(payload.length + 8)
      new DataView(bytes.buffer).setUint32(0, bytes.length)
      bytes.set(new TextEncoder().encode(type), 4)
      bytes.set(payload, 8)
      return bytes
    }
    const video = new File([new Uint8Array([
      ...box('ftyp', [...new TextEncoder().encode('isom'), 0, 0, 0, 0]),
      ...box('moov', [0, 1]), ...box('mdat', [1, 2]),
    ])], 'tour.mp4', { type: 'video/mp4' })
    mocks.uploadMedia.mockRejectedValue(new MetaApiError('Unsupported codec', { httpStatus: 400, code: 100 }))
    const res = await POST(request(video, 'Tour'))
    expect(res.status).toBe(422)
    expect((await res.json()).error).toContain('H.264/AAC')
    expect(admin.rpc).not.toHaveBeenCalled()
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

