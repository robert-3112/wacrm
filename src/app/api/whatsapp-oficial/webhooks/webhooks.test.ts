/**
 * Testes de contrato das rotas de outbound webhook
 * (`src/app/api/whatsapp-oficial/webhooks/**`). Os handlers são importados
 * direto, sem servidor HTTP, e todo colaborador é mockado — nenhum teste toca
 * Supabase nem faz request de rede.
 *
 * O que estes testes existem para travar, em ordem de estrago se quebrar:
 *  1. O segredo gerado na inscrição vai CIFRADO para o banco e em claro só na
 *     resposta, uma vez. Se a rota mandasse o texto plano para a RPC, o
 *     segredo de todos os endpoints ficaria legível em `pg_stat_statements`,
 *     backup e log de query — e ninguém repara olhando a tela.
 *  2. A rota `testar` nunca devolve o segredo, e responde 503 (não 500, não
 *     200 mentindo) quando falta configuração.
 *  3. GET lê com o cliente COM SESSÃO. Ler com `service_role` entregaria os
 *     endpoints de todos os tenants para qualquer sessão válida.
 *  4. DELETE desativa via RPC — nunca vira um delete de verdade.
 *  5. `dispatch` exige o segredo de cron e responde 503 quando ele não existe,
 *     em vez de rodar aberto.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'
import { decryptToken } from '@/lib/whatsapp-oficial/crypto'

const mocks = vi.hoisted(() => ({
  requireGestaoSession: vi.fn(),
  supabaseAdmin: vi.fn(),
  deliverWebhook: vi.fn(),
  loadWebhookSecret: vi.fn(),
  processWebhookDeliveryBatch: vi.fn(),
}))

vi.mock('@/lib/whatsapp-oficial/api-auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/whatsapp-oficial/api-auth')>(
    '@/lib/whatsapp-oficial/api-auth',
  )
  return { ...actual, requireGestaoSession: mocks.requireGestaoSession }
})

vi.mock('@/lib/whatsapp-oficial/supabase-admin', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
  __resetSupabaseAdminForTests: vi.fn(),
}))

// Parcial de propósito: `WebhookSecretMissingError` precisa ser a MESMA classe
// que a rota usa no `instanceof`, e as constantes de evento continuam reais.
vi.mock('@/lib/whatsapp-oficial/outbound-webhooks', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/whatsapp-oficial/outbound-webhooks')
  >('@/lib/whatsapp-oficial/outbound-webhooks')
  return {
    ...actual,
    deliverWebhook: mocks.deliverWebhook,
    loadWebhookSecret: mocks.loadWebhookSecret,
    processWebhookDeliveryBatch: mocks.processWebhookDeliveryBatch,
  }
})

import { UnauthorizedError } from '@/lib/whatsapp-oficial/api-auth'
import { WebhookSecretMissingError } from '@/lib/whatsapp-oficial/outbound-webhooks'
import * as listaRoute from './route'
import * as itemRoute from './[id]/route'
import * as testarRoute from './[id]/testar/route'
import * as dispatchRoute from './dispatch/route'

const GESTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WEBHOOK_ID = '11111111-1111-4111-8111-111111111111'
const CRON_SECRET = 'test-cron-secret'
const SEGREDO_DO_DESTINO = 'segredo-que-nao-pode-vazar-1234567890'
const URL_DESTINO = 'https://n8n.exemplo.com/webhook/sunt'

const ERRO_42501 = { code: '42501', message: 'sem_permissao' }

// ---------------------------------------------------------------- helpers

function postRequest(body?: unknown, headers?: Record<string, string>): Request {
  const init: RequestInit = { method: 'POST' }
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
    init.headers = { 'content-type': 'application/json', ...(headers ?? {}) }
  } else if (headers) {
    init.headers = headers
  }
  return new Request('http://localhost/api/whatsapp-oficial/webhooks', init)
}

function routeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

interface AdminStub {
  rpc: Mock
  from: Mock
}

function makeAdmin(outcome: { data?: unknown; error?: unknown } = {}): AdminStub {
  return {
    rpc: vi.fn().mockResolvedValue({ data: outcome.data ?? null, error: outcome.error ?? null }),
    from: vi.fn(),
  }
}

interface QueryStub {
  select: Mock
  eq: Mock
  order: Mock
  limit: Mock
  maybeSingle: Mock
  then: (resolve: (v: { data: unknown; error: unknown }) => unknown) => Promise<unknown>
}

function makeQuery(outcome: { data: unknown; error: unknown }): QueryStub {
  const q = {} as QueryStub
  q.select = vi.fn(() => q)
  q.eq = vi.fn(() => q)
  q.order = vi.fn(() => q)
  q.limit = vi.fn(() => q)
  q.maybeSingle = vi.fn(() => Promise.resolve(outcome))
  q.then = (resolve) => Promise.resolve(outcome).then(resolve)
  return q
}

function sessaoCom(admin: AdminStub, query?: QueryStub) {
  const supabaseUser = { from: vi.fn(() => query ?? makeQuery({ data: [], error: null })) }
  mocks.requireGestaoSession.mockResolvedValue({ userId: GESTOR_ID, supabaseUser, admin })
  return supabaseUser
}

beforeEach(() => {
  __resetRateLimitForTests()
  delete process.env.WHATSAPP_OUTBOX_CRON_SECRET
})

afterEach(() => {
  vi.clearAllMocks()
})

// --------------------------------------------------------------------- GET

describe('GET /api/whatsapp-oficial/webhooks', () => {
  it('lê com o cliente COM SESSÃO e nunca pede o segredo cifrado', async () => {
    const admin = makeAdmin()
    const query = makeQuery({
      data: [{ id: WEBHOOK_ID, url: URL_DESTINO, eventos: ['mensagem.recebida'], ativo: true }],
      error: null,
    })
    const supabaseUser = sessaoCom(admin, query)

    const res = await listaRoute.GET()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(supabaseUser.from).toHaveBeenCalledWith('whatsapp_outbound_webhooks')
    expect(admin.from).not.toHaveBeenCalled()
    const colunas = String(query.select.mock.calls[0][0])
    expect(colunas).not.toContain('segredo')
    expect(json.webhooks).toHaveLength(1)
    expect(json.eventos_disponiveis).toContain('mensagem.recebida')
  })

  it('sem sessão devolve 401', async () => {
    mocks.requireGestaoSession.mockRejectedValue(new UnauthorizedError())
    const res = await listaRoute.GET()
    expect(res.status).toBe(401)
  })
})

// -------------------------------------------------------------------- POST

describe('POST /api/whatsapp-oficial/webhooks', () => {
  it('manda o segredo CIFRADO para a RPC e devolve o texto plano uma única vez', async () => {
    const admin = makeAdmin({
      data: { ok: true, webhook_id: WEBHOOK_ID, tenant_id: 'sunt', url: URL_DESTINO, eventos: ['mensagem.recebida'] },
    })
    sessaoCom(admin)

    const res = await listaRoute.POST(
      postRequest({ url: URL_DESTINO, eventos: ['mensagem.recebida'] }),
    )
    const json = await res.json()
    expect(res.status).toBe(201)

    const args = admin.rpc.mock.calls[0][1] as Record<string, string>
    expect(admin.rpc.mock.calls[0][0]).toBe('whatsapp_oficial_webhook_inscrever')
    expect(args.p_actor_user_id).toBe(GESTOR_ID)

    // o segredo em claro NÃO pode ser o que foi para o banco
    expect(json.segredo).toMatch(/^[0-9a-f]{64}$/)
    expect(args.p_segredo_cifrado).not.toContain(json.segredo)
    expect(args.p_segredo_cifrado.startsWith('\\x')).toBe(true)
    // ...e o que foi para o banco tem que decifrar exatamente nele
    expect(decryptToken(args.p_segredo_cifrado)).toBe(json.segredo)
  })

  it('recusa inscrição que nunca dispararia', async () => {
    const admin = makeAdmin()
    sessaoCom(admin)

    const casos: Array<[unknown, string]> = [
      [{ eventos: ['mensagem.recebida'] }, 'url_obrigatoria'],
      [{ url: 'ftp://x.exemplo.com', eventos: ['mensagem.recebida'] }, 'url_invalida'],
      [{ url: 'nao-e-url', eventos: ['mensagem.recebida'] }, 'url_invalida'],
      [{ url: URL_DESTINO, eventos: [] }, 'eventos_obrigatorios'],
      [{ url: URL_DESTINO, eventos: 'mensagem.recebida' }, 'eventos_invalidos'],
      [{ url: URL_DESTINO, eventos: ['mensagem_recebida'] }, 'evento_invalido'],
      [{ url: URL_DESTINO, eventos: ['*'] }, 'evento_invalido'],
      [{ url: URL_DESTINO, eventos: ['ping'] }, 'evento_invalido'],
    ]

    for (const [body, slug] of casos) {
      __resetRateLimitForTests()
      const res = await listaRoute.POST(postRequest(body))
      expect(res.status, slug).toBe(422)
      expect((await res.json()).error).toBe(slug)
    }
    // nenhuma recusa pode ter chegado ao banco
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('traduz 42501 da RPC em 403 e url duplicada em 409', async () => {
    sessaoCom(makeAdmin({ error: ERRO_42501 }))
    const proibido = await listaRoute.POST(
      postRequest({ url: URL_DESTINO, eventos: ['mensagem.recebida'] }),
    )
    expect(proibido.status).toBe(403)

    __resetRateLimitForTests()
    sessaoCom(makeAdmin({ data: { ok: false, reason: 'url_ja_inscrita' } }))
    const duplicada = await listaRoute.POST(
      postRequest({ url: URL_DESTINO, eventos: ['mensagem.recebida'] }),
    )
    expect(duplicada.status).toBe(409)
    expect((await duplicada.json()).error).toBe('url_ja_inscrita')
  })

  it('sem sessão devolve 401 sem sequer ler o corpo', async () => {
    mocks.requireGestaoSession.mockRejectedValue(new UnauthorizedError())
    const res = await listaRoute.POST(postRequest({ url: URL_DESTINO, eventos: ['*'] }))
    expect(res.status).toBe(401)
  })
})

// ------------------------------------------------------------------ DELETE

describe('DELETE /api/whatsapp-oficial/webhooks/[id]', () => {
  it('desativa via RPC — nunca apaga', async () => {
    const admin = makeAdmin({ data: { ok: true, webhook_id: WEBHOOK_ID, entregas_canceladas: 2 } })
    sessaoCom(admin)

    const res = await itemRoute.DELETE(postRequest(), routeParams(WEBHOOK_ID))
    expect(res.status).toBe(200)
    expect(admin.rpc).toHaveBeenCalledWith('whatsapp_oficial_webhook_desativar', {
      p_actor_user_id: GESTOR_ID,
      p_webhook_id: WEBHOOK_ID,
    })
    expect(admin.from).not.toHaveBeenCalled()
    expect((await res.json()).entregas_canceladas).toBe(2)
  })

  it('id fora do formato uuid é 404, não 500', async () => {
    const admin = makeAdmin()
    sessaoCom(admin)
    const res = await itemRoute.DELETE(postRequest(), routeParams('nao-e-uuid'))
    expect(res.status).toBe(404)
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('42501 vira 403 e inscrição inexistente vira 404', async () => {
    sessaoCom(makeAdmin({ error: ERRO_42501 }))
    expect((await itemRoute.DELETE(postRequest(), routeParams(WEBHOOK_ID))).status).toBe(403)

    __resetRateLimitForTests()
    sessaoCom(makeAdmin({ data: { ok: false, reason: 'webhook_nao_encontrado' } }))
    expect((await itemRoute.DELETE(postRequest(), routeParams(WEBHOOK_ID))).status).toBe(404)
  })
})

// ------------------------------------------------------------------ testar

describe('POST /api/whatsapp-oficial/webhooks/[id]/testar', () => {
  function sessaoComWebhook(row: unknown) {
    const admin = makeAdmin()
    const query = makeQuery({ data: row, error: null })
    const supabaseUser = sessaoCom(admin, query)
    return { admin, query, supabaseUser }
  }

  it('dispara o ping assinado e NUNCA devolve o segredo', async () => {
    const { admin, supabaseUser } = sessaoComWebhook({
      id: WEBHOOK_ID,
      tenant_id: 'sunt',
      url: URL_DESTINO,
      ativo: true,
    })
    mocks.loadWebhookSecret.mockResolvedValue(SEGREDO_DO_DESTINO)
    mocks.deliverWebhook.mockResolvedValue({ ok: true, httpStatus: 204, erro: null })

    const res = await testarRoute.POST(postRequest(), routeParams(WEBHOOK_ID))
    const texto = await res.text()

    expect(res.status).toBe(200)
    expect(JSON.parse(texto)).toMatchObject({ ok: true, evento: 'ping', http_status: 204 })
    expect(texto).not.toContain(SEGREDO_DO_DESTINO)

    // a AUTORIZAÇÃO é a leitura com sessão (RLS), não o cliente de serviço
    expect(supabaseUser.from).toHaveBeenCalledWith('whatsapp_outbound_webhooks')
    expect(admin.from).not.toHaveBeenCalled()

    const chamada = mocks.deliverWebhook.mock.calls[0][0]
    expect(chamada.evento).toBe('ping')
    expect(chamada.secret).toBe(SEGREDO_DO_DESTINO)
    // o payload do ping não carrega dado de lead
    expect(JSON.stringify(chamada.payload)).not.toMatch(/whatsapp|telefone|conteudo|mensagem/i)
  })

  it('destino que falha é 200 com ok:false, e o erro não carrega o segredo', async () => {
    sessaoComWebhook({ id: WEBHOOK_ID, tenant_id: 'sunt', url: URL_DESTINO, ativo: true })
    mocks.loadWebhookSecret.mockResolvedValue(SEGREDO_DO_DESTINO)
    mocks.deliverWebhook.mockResolvedValue({
      ok: false,
      httpStatus: 500,
      erro: 'http_500: erro interno',
    })

    const res = await testarRoute.POST(postRequest(), routeParams(WEBHOOK_ID))
    const texto = await res.text()
    expect(res.status).toBe(200)
    expect(JSON.parse(texto)).toMatchObject({ ok: false, http_status: 500 })
    expect(texto).not.toContain(SEGREDO_DO_DESTINO)
  })

  it('sem segredo utilizável é 503 (configuração faltando), não 500', async () => {
    sessaoComWebhook({ id: WEBHOOK_ID, tenant_id: 'sunt', url: URL_DESTINO, ativo: true })
    mocks.loadWebhookSecret.mockRejectedValue(new WebhookSecretMissingError())

    const res = await testarRoute.POST(postRequest(), routeParams(WEBHOOK_ID))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('webhook_sem_segredo_utilizavel')
    expect(mocks.deliverWebhook).not.toHaveBeenCalled()
  })

  it('inscrição escondida pela RLS é 404, e inativa é 409 — nenhuma das duas dispara request', async () => {
    sessaoComWebhook(null)
    expect((await testarRoute.POST(postRequest(), routeParams(WEBHOOK_ID))).status).toBe(404)

    __resetRateLimitForTests()
    sessaoComWebhook({ id: WEBHOOK_ID, tenant_id: 'sunt', url: URL_DESTINO, ativo: false })
    const inativa = await testarRoute.POST(postRequest(), routeParams(WEBHOOK_ID))
    expect(inativa.status).toBe(409)
    expect((await inativa.json()).error).toBe('webhook_inativo')

    expect(mocks.deliverWebhook).not.toHaveBeenCalled()
    expect(mocks.loadWebhookSecret).not.toHaveBeenCalled()
  })

  it('falha transitória de leitura vira 404, não 500 com detalhe do banco', async () => {
    const admin = makeAdmin()
    sessaoCom(admin, makeQuery({ data: null, error: { message: 'connection reset' } }))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await testarRoute.POST(postRequest(), routeParams(WEBHOOK_ID))
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('connection reset')
  })
})

// ---------------------------------------------------------------- dispatch

describe('POST /api/whatsapp-oficial/webhooks/dispatch', () => {
  it('sem WHATSAPP_OUTBOX_CRON_SECRET configurado responde 503 e não roda o lote', async () => {
    const res = await dispatchRoute.POST(postRequest({}, { 'x-cron-secret': 'qualquer' }))
    expect(res.status).toBe(503)
    expect(mocks.processWebhookDeliveryBatch).not.toHaveBeenCalled()
  })

  it('segredo errado (e tamanho diferente) responde 401 sem lançar', async () => {
    process.env.WHATSAPP_OUTBOX_CRON_SECRET = CRON_SECRET
    for (const enviado of ['errado', '', 'test-cron-secreT', CRON_SECRET + 'a']) {
      const res = await dispatchRoute.POST(postRequest({}, { 'x-cron-secret': enviado }))
      expect(res.status, `segredo "${enviado}"`).toBe(401)
    }
    expect(mocks.processWebhookDeliveryBatch).not.toHaveBeenCalled()
  })

  it('com o segredo certo drena o lote e devolve os contadores', async () => {
    process.env.WHATSAPP_OUTBOX_CRON_SECRET = CRON_SECRET
    mocks.supabaseAdmin.mockReturnValue(makeAdmin())
    mocks.processWebhookDeliveryBatch.mockResolvedValue({
      claimed: 7,
      delivered: 2,
      retried: 1,
      deadLettered: 0,
      remaining: 4,
      outcomes: [],
    })

    const res = await dispatchRoute.POST(
      postRequest({ limit: 999, leaseSeconds: 1 }, { 'x-cron-secret': CRON_SECRET }),
    )
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, claimed: 7, delivered: 2, retried: 1 })
    // O que sobrou do lease TEM que sair na resposta: é o único sinal de que o
    // lote não coube no lease. Sem ele um `limit` alto parece funcionar (nenhum
    // erro) enquanto o worker entrega duplicado no destino a cada ciclo.
    expect(json.remaining).toBe(4)
    // limites saneados: 999 -> 100, 1 -> 30
    const args = mocks.processWebhookDeliveryBatch.mock.calls[0][0]
    expect(args.limit).toBe(100)
    expect(args.leaseSeconds).toBe(30)
    expect(args.workerId).toBeTruthy()
  })

  it('explosão do lote vira 500 com slug estável, sem vazar a exceção', async () => {
    process.env.WHATSAPP_OUTBOX_CRON_SECRET = CRON_SECRET
    mocks.supabaseAdmin.mockReturnValue(makeAdmin())
    mocks.processWebhookDeliveryBatch.mockRejectedValue(new Error('detalhe interno do banco'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await dispatchRoute.POST(postRequest({}, { 'x-cron-secret': CRON_SECRET }))
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('detalhe interno do banco')
  })
})
