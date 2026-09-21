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

function request(body: unknown): Request {
  return new Request('http://localhost/api/v1/sophia/replies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/v1/sophia/replies', () => {
  const rpc = vi.fn()

  beforeEach(() => {
    rpc.mockReset()
    mocks.requireApiKeyWithScope.mockReset()
    mocks.requireApiKeyWithScope.mockResolvedValue({ apiKeyId: 'key-1', admin: { rpc } })
  })

  it('requires the dedicated Sophia scope', async () => {
    mocks.requireApiKeyWithScope.mockRejectedValue(new ApiV1Error('forbidden', 403))
    const response = await POST(request({ claimId: CLAIM_ID, claimToken: TOKEN, content: 'Olá' }))
    expect(response.status).toBe(403)
    expect(rpc).not.toHaveBeenCalled()
    expect(mocks.requireApiKeyWithScope).toHaveBeenCalledWith(expect.any(Request), 'sophia:process')
  })

  it('rejects an invalid claim token before the database write', async () => {
    const response = await POST(request({ claimId: CLAIM_ID, claimToken: 'wrong', content: 'Olá' }))
    expect(response.status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('rejects an oversized body before the database write', async () => {
    const response = await POST(request({ claimId: CLAIM_ID, claimToken: TOKEN,
      content: 'x'.repeat(32 * 1024) }))
    expect(response.status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('does not claim a send when a human paused Sophia during generation', async () => {
    rpc.mockResolvedValue({ data: { ok: false, reason: 'sophia_pausada' }, error: null })
    const response = await POST(request({ claimId: CLAIM_ID, claimToken: TOKEN, content: 'Olá' }))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'sophia_pausada' })
  })

  it('rejects a stale claim after pause and resume', async () => {
    rpc.mockResolvedValue({ data: { ok: false, reason: 'sophia_estado_alterado' }, error: null })
    const response = await POST(request({ claimId: CLAIM_ID, claimToken: TOKEN, content: 'Resposta antiga' }))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'sophia_estado_alterado' })
  })

  it('reports only queue admission after the RPC succeeds', async () => {
    rpc.mockResolvedValue({
      data: { ok: true, message_id: 'message-1', conversation_id: 'conversation-1', status: 'pendente' },
      error: null,
    })
    const response = await POST(request({ claimId: CLAIM_ID, claimToken: TOKEN, content: 'Olá' }))
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({
      data: { enfileirado: true, message_id: 'message-1', conversation_id: 'conversation-1', status: 'pendente',
        idempotent_replay: false },
    })
    expect(rpc).toHaveBeenCalledWith('whatsapp_sophia_enfileirar_resposta', {
      p_claim_id: CLAIM_ID,
      p_claim_token: TOKEN,
      p_api_key_id: 'key-1',
      p_content: 'Olá',
    })
  })

  it('returns the original message on a same-content retry (200, idempotent_replay)', async () => {
    rpc.mockResolvedValue({
      data: { ok: true, message_id: 'message-1', conversation_id: 'conversation-1', status: 'enviada',
        idempotent_replay: true },
      error: null,
    })
    const response = await POST(request({ claimId: CLAIM_ID, claimToken: TOKEN, content: 'Olá' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: { enfileirado: true, message_id: 'message-1', conversation_id: 'conversation-1', status: 'enviada',
        idempotent_replay: true },
    })
  })
})
