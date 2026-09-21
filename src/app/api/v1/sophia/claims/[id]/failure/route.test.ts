import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireApiKeyWithScope: vi.fn() }))
vi.mock('@/lib/whatsapp-oficial/api-key-auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/whatsapp-oficial/api-key-auth')>(
    '@/lib/whatsapp-oficial/api-key-auth',
  )
  return { ...actual, requireApiKeyWithScope: mocks.requireApiKeyWithScope }
})

import { ApiV1Error } from '@/lib/whatsapp-oficial/api-key-auth'
import { POST } from './route'

const CLAIM_ID = '11111111-1111-4111-8111-111111111111'
const TOKEN = `sc_${'a'.repeat(64)}`

function call(body: unknown, id = CLAIM_ID) {
  return POST(new Request(`http://localhost/api/v1/sophia/claims/${id}/failure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) })
}

describe('POST /api/v1/sophia/claims/[id]/failure', () => {
  const rpc = vi.fn()

  beforeEach(() => {
    rpc.mockReset()
    mocks.requireApiKeyWithScope.mockReset()
    mocks.requireApiKeyWithScope.mockResolvedValue({ apiKeyId: 'key-1', admin: { rpc } })
  })

  it('requires the dedicated Sophia scope', async () => {
    mocks.requireApiKeyWithScope.mockRejectedValue(new ApiV1Error('forbidden', 403))
    expect((await call({ claim_token: TOKEN, reason: 'timeout' })).status).toBe(403)
    expect(mocks.requireApiKeyWithScope).toHaveBeenCalledWith(expect.any(Request), 'sophia:process')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('validates id, token, reason and extra fields before the RPC', async () => {
    expect((await call({ claim_token: TOKEN, reason: 'x' }, 'nope')).status).toBe(400)
    expect((await call({ claim_token: 'wrong', reason: 'x' })).status).toBe(400)
    expect((await call({ claim_token: TOKEN, reason: ' ' })).status).toBe(400)
    expect((await call({ claim_token: TOKEN, reason: 'x'.repeat(201) })).status).toBe(400)
    expect((await call({ claim_token: TOKEN, reason: 'x', extra: 1 })).status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('marks the claim failed', async () => {
    rpc.mockResolvedValue({ data: { ok: true, claim_id: CLAIM_ID, status: 'failed' }, error: null })
    const response = await call({ claim_token: TOKEN, reason: ' llm timeout ' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { claim_id: CLAIM_ID, status: 'failed' } })
    expect(rpc).toHaveBeenCalledWith('whatsapp_sophia_marcar_falha', {
      p_claim_id: CLAIM_ID, p_claim_token: TOKEN, p_api_key_id: 'key-1', p_reason: 'llm timeout',
    })
  })

  it.each([
    ['claim_nao_encontrado', 404],
    ['claim_finalizado', 409],
  ])('maps %s to %i', async (reason, status) => {
    rpc.mockResolvedValue({ data: { ok: false, reason }, error: null })
    expect((await call({ claim_token: TOKEN, reason: 'x' })).status).toBe(status)
  })

  it('maps a revoked key (42501) to 401', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'chave_invalida' } })
    expect((await call({ claim_token: TOKEN, reason: 'x' })).status).toBe(401)
  })
})
