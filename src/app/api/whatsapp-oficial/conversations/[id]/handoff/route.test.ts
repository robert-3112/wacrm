import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

const mocks = vi.hoisted(() => ({
  requireConversationAccess: vi.fn(),
}))

vi.mock('@/lib/whatsapp-oficial/api-auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/whatsapp-oficial/api-auth')>(
    '@/lib/whatsapp-oficial/api-auth',
  )
  return {
    ...actual,
    requireConversationAccess: mocks.requireConversationAccess,
  }
})

import { NotFoundError } from '@/lib/whatsapp-oficial/api-auth'
import { POST } from './route'

const params = { params: Promise.resolve({ id: 'conv-1' }) }

function jsonRequest(body: unknown) {
  return new Request('http://localhost', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/whatsapp-oficial/conversations/[id]/handoff', () => {
  beforeEach(() => {
    mocks.requireConversationAccess.mockReset()
    __resetRateLimitForTests()
  })

  it('a caller who cannot see the conversation gets 404 and the RPC is never called', async () => {
    mocks.requireConversationAccess.mockRejectedValue(new NotFoundError())
    const rpc = vi.fn()

    const res = await POST(jsonRequest({}), params)

    expect(res.status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('calls whatsapp_oficial_registrar_handoff with the conversation lead_id for an authorized caller', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { ok: true, etapa: 'qualificado' }, error: null })
    const admin = { rpc }
    mocks.requireConversationAccess.mockResolvedValue({
      userId: 'owner-corretor',
      conversation: { id: 'conv-1', tenant_id: 'sunt', canal_id: 'canal-1', lead_id: 'lead-42', status: 'aberta' },
      supabaseUser: {},
      admin,
    })

    const res = await POST(
      jsonRequest({ empreendimento_interesse_slug: 'praia-azul', intencao: 'comprar' }),
      params,
    )
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(rpc).toHaveBeenCalledWith('whatsapp_oficial_registrar_handoff', {
      p_lead_id: 'lead-42',
      p_empreendimento_interesse_slug: 'praia-azul',
      p_intencao: 'comprar',
      p_regiao_interesse: null,
      p_interesse: null,
    })
  })

  it('surfaces a business-rule rejection (ok:false) as 422, not 500', async () => {
    const admin = {
      rpc: vi.fn().mockResolvedValue({ data: { ok: false, reason: 'lead_nao_ativo' }, error: null }),
    }
    mocks.requireConversationAccess.mockResolvedValue({
      userId: 'owner-corretor',
      conversation: { id: 'conv-1', tenant_id: 'sunt', canal_id: 'canal-1', lead_id: 'lead-42', status: 'aberta' },
      supabaseUser: {},
      admin,
    })

    const res = await POST(jsonRequest({}), params)

    expect(res.status).toBe(422)
  })
})
