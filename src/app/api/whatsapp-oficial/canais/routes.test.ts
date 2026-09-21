import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

const mocks = vi.hoisted(() => ({ requireGestaoSession: vi.fn(), loadManagedChannel: vi.fn(), testChannelConnection: vi.fn() }))
vi.mock('@/lib/whatsapp-oficial/api-auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/whatsapp-oficial/api-auth')>('@/lib/whatsapp-oficial/api-auth')
  return { ...actual, requireGestaoSession: mocks.requireGestaoSession }
})
vi.mock('@/lib/whatsapp-oficial/channel-management', () => ({
  loadManagedChannel: mocks.loadManagedChannel,
  testChannelConnection: mocks.testChannelConnection,
}))

import { UnauthorizedError } from '@/lib/whatsapp-oficial/api-auth'
import { POST as create } from './route'
import { POST as test } from './[id]/teste/route'
import { PATCH as status } from './[id]/status/route'

const ID = '11111111-1111-4111-8111-111111111111'
const context = { params: Promise.resolve({ id: ID }) }
const rpc = vi.fn()

function request(method: string, body: object): Request {
  return new Request('http://localhost', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

beforeEach(() => {
  __resetRateLimitForTests()
  rpc.mockReset()
  mocks.requireGestaoSession.mockReset().mockResolvedValue({ userId: 'owner', admin: { rpc } })
  mocks.loadManagedChannel.mockReset().mockResolvedValue({ id: ID, tenant_id: 'sunt', provider: 'meta_cloud', status: 'inativo' })
  mocks.testChannelConnection.mockReset().mockResolvedValue({ ok: true })
})

describe('channel routes', () => {
  it('never processes a create without a session', async () => {
    mocks.requireGestaoSession.mockRejectedValue(new UnauthorizedError())
    expect((await create(request('POST', { provider: 'meta_cloud' }))).status).toBe(401)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('validates provider-specific fields before storing a Meta secret encrypted', async () => {
    const invalid = await create(request('POST', { nome: 'Outro', provider: 'meta_cloud', phoneNumberId: 'bad', wabaId: '987', credential: 'token' }))
    expect(invalid.status).toBe(422)
    expect(rpc).not.toHaveBeenCalled()

    rpc.mockResolvedValue({ data: { ok: true, canal_id: ID, status: 'inativo' }, error: null })
    const result = await create(request('POST', { nome: 'Outro', provider: 'meta_cloud', phoneNumberId: '123456', wabaId: '987654', credential: 'secret-token' }))
    expect(result.status).toBe(201)
    expect(await result.json()).toEqual({ ok: true, canal_id: ID, status: 'inativo' })
    const args = rpc.mock.calls[0][1] as Record<string, unknown>
    expect(args.p_actor_user_id).toBe('owner')
    expect(args.p_credencial_cifrada).toMatch(/^\\x[0-9a-f]+$/)
    expect(args.p_credencial_cifrada).not.toContain('secret-token')
    expect(args.p_evolution_instance).toBeNull()
  })

  it('does not activate a number when the read-only provider test fails', async () => {
    mocks.testChannelConnection.mockResolvedValue({ ok: false, reason: 'meta_nao_confirmou_numero' })
    const response = await status(request('PATCH', { status: 'ativo', expectedStatus: 'inativo' }), context)
    expect(response.status).toBe(422)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('pauses through the atomic RPC without contacting a provider', async () => {
    rpc.mockResolvedValue({ data: { ok: true, status: 'pausado' }, error: null })
    const response = await status(request('PATCH', { status: 'pausado', expectedStatus: 'ativo' }), context)
    expect(response.status).toBe(200)
    expect(mocks.testChannelConnection).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledWith('whatsapp_oficial_canal_mudar_status', {
      p_actor_user_id: 'owner', p_canal_id: ID, p_expected_status: 'ativo', p_new_status: 'pausado',
    })
  })

  it('reports an out-of-date status as a conflict, without losing a concurrent pause', async () => {
    rpc.mockResolvedValue({ data: { ok: false, reason: 'status_alterado' }, error: null })
    const response = await status(request('PATCH', { status: 'ativo', expectedStatus: 'inativo' }), context)
    expect(response.status).toBe(409)
  })

  it('connection test invokes the authorized read-only probe', async () => {
    const response = await test(new Request('http://localhost', { method: 'POST' }), context)
    expect(response.status).toBe(200)
    expect(mocks.loadManagedChannel).toHaveBeenCalledWith({ rpc }, 'owner', ID)
    expect(mocks.testChannelConnection).toHaveBeenCalledTimes(1)
  })
})
