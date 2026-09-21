import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

const mocks = vi.hoisted(() => ({ requireGestaoSession: vi.fn(), decryptToken: vi.fn() }))
vi.mock('@/lib/whatsapp-oficial/api-auth', async () => ({
  ...await vi.importActual<typeof import('@/lib/whatsapp-oficial/api-auth')>('@/lib/whatsapp-oficial/api-auth'),
  requireGestaoSession: mocks.requireGestaoSession,
}))
vi.mock('@/lib/whatsapp-oficial/crypto', () => ({ decryptToken: mocks.decryptToken }))

import { POST } from './route'

const canalId = '8fa74ac1-a9bd-47c9-a682-560804953dd7'
const body = { canalId, name: 'sunt_teste', category: 'MARKETING',
  body: 'Olá {{1}}', examples: ['Cliente'] }
const request = () => new Request('http://localhost/api/whatsapp-oficial/templates/criar', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
const query = (data: unknown) => {
  const builder: Record<string, unknown> = {}
  for (const name of ['select', 'eq', 'in', 'limit']) builder[name] = vi.fn(() => builder)
  builder.maybeSingle = vi.fn(async () => ({ data, error: null }))
  return builder
}

describe('POST /templates/criar', () => {
  beforeEach(() => { vi.clearAllMocks(); __resetRateLimitForTests(); mocks.decryptToken.mockReturnValue('token-secreto') })
  afterEach(() => vi.unstubAllGlobals())

  it('recusa líder antes de decifrar credencial ou chamar a Meta', async () => {
    const visible = query({ id: canalId, tenant_id: 'sunt' })
    const role = query(null)
    const admin = { from: vi.fn(() => role) }
    mocks.requireGestaoSession.mockResolvedValue({ userId: 'user-1',
      supabaseUser: { from: vi.fn(() => visible) }, admin })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await POST(request())
    expect(response.status).toBe(403)
    expect(mocks.decryptToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('envia somente o payload validado e não devolve o token', async () => {
    const visible = query({ id: canalId, tenant_id: 'sunt' })
    const role = query({ role: 'gestor' })
    const channel = query({ provider: 'meta_cloud', status: 'ativo', waba_id: '12345',
      access_token_cifrado: 'cipher' })
    const admin = { from: vi.fn((table: string) => table === 'app_roles' ? role : channel) }
    mocks.requireGestaoSession.mockResolvedValue({ userId: 'user-1',
      supabaseUser: { from: vi.fn(() => visible) }, admin })
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ id: '98765', status: 'PENDING' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await POST(request())
    expect(response.status).toBe(202)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/12345\/message_templates$/)
    expect(JSON.parse(String(init.body))).toMatchObject({ name: 'sunt_teste', language: 'pt_BR',
      components: [{ type: 'BODY', text: 'Olá {{1}}', example: { body_text: [['Cliente']] } }] })
    expect(await response.text()).not.toContain('token-secreto')
  })
})
