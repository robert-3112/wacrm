import { beforeEach, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'
import { UnauthorizedError } from '@/lib/whatsapp-oficial/api-auth'
import { POST } from './route'

const mocks = vi.hoisted(() => ({ session: vi.fn() }))
vi.mock('@/lib/whatsapp-oficial/api-auth', async (original) => ({
  ...await original<typeof import('@/lib/whatsapp-oficial/api-auth')>(),
  requireGestaoSession: mocks.session,
}))

const LEAD_ID = '11111111-1111-4111-8111-111111111111'
const CANAL_ID = '22222222-2222-4222-8222-222222222222'
const TEMPLATE_ID = '33333333-3333-4333-8333-333333333333'
const REQUEST_ID = '44444444-4444-4444-8444-444444444444'
const MESSAGE_ID = '55555555-5555-4555-8555-555555555555'
const CONVERSATION_ID = '66666666-6666-4666-8666-666666666666'

function query(row: Record<string, unknown> | null) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }),
  }
}

function setup(options: {
  phone?: string
  allowed?: boolean
  result?: Record<string, unknown>
  roleError?: unknown
  lead?: Record<string, unknown> | null
  template?: Record<string, unknown> | null
  channel?: Record<string, unknown> | null
} = {}) {
  const lead = query(options.lead === undefined
    ? { id: LEAD_ID, tenant_id: 'sunt', whatsapp: options.phone ?? '5547999444800' }
    : options.lead)
  const channel = query(options.channel === undefined
    ? { id: CANAL_ID, tenant_id: 'sunt', provider: 'meta_cloud', status: 'ativo' }
    : options.channel)
  const template = query(options.template === undefined
    ? { id: TEMPLATE_ID, tenant_id: 'sunt', canal_id: CANAL_ID, status_aprovacao: 'aprovado' }
    : options.template)
  const from = vi.fn((name: string) => {
    if (name === 'leads') return lead
    if (name === 'whatsapp_channels') return channel
    if (name === 'whatsapp_templates') return template
    throw new Error(`unexpected table ${name}`)
  })
  const rpc = vi.fn(async (name: string) => {
    if (name === 'whatsapp_campanha_ator_autorizado') {
      return { data: options.allowed ?? true, error: options.roleError ?? null }
    }
    if (name === 'whatsapp_oficial_iniciar_template') {
      return { data: options.result ?? {
        ok: true, conversation_id: CONVERSATION_ID, message_id: MESSAGE_ID,
        template_id: TEMPLATE_ID, preview: 'Hello World!', replayed: false,
      }, error: null }
    }
    throw new Error(`unexpected RPC ${name}`)
  })
  mocks.session.mockResolvedValue({ userId: '77777777-7777-4777-8777-777777777777', supabaseUser: { from }, admin: { rpc } })
  return { from, rpc, lead, channel, template }
}

function request(body: Record<string, unknown> = {}) {
  return new Request(`http://localhost/api/whatsapp-oficial/contatos/${LEAD_ID}/iniciar`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ canalId: CANAL_ID, templateId: TEMPLATE_ID, variaveis: {}, clientRequestId: REQUEST_ID, ...body }),
  })
}

const params = { params: Promise.resolve({ leadId: LEAD_ID }) }

beforeEach(() => {
  vi.resetAllMocks()
  __resetRateLimitForTests()
  process.env.WHATSAPP_PILOT_CHANNEL_ID = CANAL_ID
  process.env.WHATSAPP_PILOT_MODE = 'true'
  process.env.WHATSAPP_ALLOWLIST = '5547999444800'
})

it('exige sessão e não consulta dados sem autenticação', async () => {
  const { from, rpc } = setup()
  mocks.session.mockRejectedValue(new UnauthorizedError())
  expect((await POST(request(), params)).status).toBe(401)
  expect(from).not.toHaveBeenCalled()
  expect(rpc).not.toHaveBeenCalled()
})

it('falha fechado sem identificação do canal piloto', async () => {
  const { from, rpc } = setup()
  delete process.env.WHATSAPP_PILOT_CHANNEL_ID
  expect((await POST(request(), params)).status).toBe(503)
  expect(from).not.toHaveBeenCalled()
  expect(rpc).not.toHaveBeenCalled()
})

it('não amplia o piloto se o modo restrito for desligado', async () => {
  const { from, rpc } = setup()
  process.env.WHATSAPP_PILOT_MODE = 'false'
  expect((await POST(request(), params)).status).toBe(503)
  expect(from).not.toHaveBeenCalled()
  expect(rpc).not.toHaveBeenCalled()
})

it('exige entrada válida e canal exatamente igual ao piloto', async () => {
  const { from, rpc } = setup()
  expect((await POST(request({ clientRequestId: 'invalid' }), params)).status).toBe(400)
  expect((await POST(request({ canalId: TEMPLATE_ID }), params)).status).toBe(403)
  expect(from).not.toHaveBeenCalled()
  expect(rpc).not.toHaveBeenCalled()
})

it('não expõe lead invisível pela RLS', async () => {
  const { rpc } = setup({ lead: null })
  expect((await POST(request(), params)).status).toBe(404)
  expect(rpc).not.toHaveBeenCalled()
})

it('nega usuário sem papel de gestão antes de chamar a RPC de envio', async () => {
  const { rpc } = setup({ allowed: false })
  expect((await POST(request(), params)).status).toBe(403)
  expect(rpc).toHaveBeenCalledWith('whatsapp_campanha_ator_autorizado', {
    p_actor_user_id: '77777777-7777-4777-8777-777777777777', p_tenant_id: 'sunt',
  })
  expect(rpc).not.toHaveBeenCalledWith('whatsapp_oficial_iniciar_template', expect.anything())
})

it('não enfileira destinatário fora da allowlist do piloto', async () => {
  const { rpc } = setup({ phone: '5547999444999' })
  const response = await POST(request(), params)
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: 'destinatario_fora_allowlist' })
  expect(rpc).not.toHaveBeenCalledWith('whatsapp_oficial_iniciar_template', expect.anything())
})

it('recusa canal ou template que não pertence ao tenant/à seleção', async () => {
  const { rpc } = setup({ channel: { id: CANAL_ID, tenant_id: 'outro', provider: 'meta_cloud', status: 'ativo' } })
  expect((await POST(request(), params)).status).toBe(404)
  expect(rpc).not.toHaveBeenCalledWith('whatsapp_oficial_iniciar_template', expect.anything())
  const second = setup({ template: { id: TEMPLATE_ID, tenant_id: 'sunt', canal_id: 'outro', status_aprovacao: 'aprovado' } })
  expect((await POST(request(), params)).status).toBe(409)
  expect(second.rpc).not.toHaveBeenCalledWith('whatsapp_oficial_iniciar_template', expect.anything())
})

it('enfileira via RPC atômica e distingue fila de entrega', async () => {
  const { rpc } = setup()
  const response = await POST(request(), params)
  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({
    ok: true, enfileirado: true, replayed: false, conversationId: CONVERSATION_ID,
    messageId: MESSAGE_ID, templateId: TEMPLATE_ID, preview: 'Hello World!',
  })
  expect(rpc).toHaveBeenCalledWith('whatsapp_oficial_iniciar_template', {
    p_lead_id: LEAD_ID, p_canal_id: CANAL_ID, p_template_id: TEMPLATE_ID,
    p_variaveis: {}, p_actor_user_id: '77777777-7777-4777-8777-777777777777',
    p_client_request_id: REQUEST_ID,
  })
})

it('repetição idempotente retorna o mesmo item sem alegar novo envio', async () => {
  setup({ result: { ok: true, conversation_id: CONVERSATION_ID, message_id: MESSAGE_ID, template_id: TEMPLATE_ID, replayed: true } })
  const response = await POST(request(), params)
  expect(response.status).toBe(200)
  expect((await response.json()).replayed).toBe(true)
})

it('preserva recusas de consentimento e idempotência da RPC', async () => {
  for (const [reason, status] of [
    ['consentimento_ausente', 409], ['idempotency_conflict', 409],
    ['cooldown_24h', 409], ['destinatario_optout_duplicado', 409],
    ['sophia_resposta_em_transito', 409],
  ] as const) {
    setup({ result: { ok: false, reason } })
    const response = await POST(request(), params)
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error: reason })
    __resetRateLimitForTests()
  }
})
