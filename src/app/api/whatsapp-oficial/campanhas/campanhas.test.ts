/**
 * Testes de contrato das rotas de campanha
 * (`src/app/api/whatsapp-oficial/campanhas/**`). Os handlers são importados
 * direto (sem servidor HTTP) e todo colaborador é mockado — nenhum teste toca
 * Supabase, Meta ou rede.
 *
 * O que estes testes existem para travar, em ordem de estrago se quebrar:
 *  1. `dryRun` DEFAULT TRUE em `POST /[id]/destinatarios` — esquecer o campo
 *     não pode materializar público.
 *  2. `toErrorResponse` traduzindo 42501 da RPC em 403 (a rota não repete a
 *     regra de papel; se a tradução sumir, vira 500 e o operador não entende).
 *  3. Lista e detalhe lendo com o cliente COM SESSÃO — ler com service_role
 *     vazaria campanhas de todo mundo para qualquer sessão válida.
 *  4. O dispatch não abortando a fila inteira por causa de uma campanha ruim.
 *  5. O agregado de destinatários paginando com ORDER BY estável e só dizendo
 *     `truncado` quando de fato sobrou linha além do teto — os dois erros aqui
 *     são silenciosos: número errado na tela, sem exceção nenhuma.
 *  6. Config de janela recusada na entrada (metade de janela, lista de dias
 *     vazia ou fora de 1..7), porque a campanha inválida que passa vira uma
 *     campanha que simplesmente nunca envia.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

const mocks = vi.hoisted(() => ({
  requireGestaoSession: vi.fn(),
  supabaseAdmin: vi.fn(),
}))

vi.mock('@/lib/whatsapp-oficial/api-auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/whatsapp-oficial/api-auth')>(
    '@/lib/whatsapp-oficial/api-auth',
  )
  return {
    ...actual,
    requireGestaoSession: mocks.requireGestaoSession,
  }
})

vi.mock('@/lib/whatsapp-oficial/supabase-admin', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
  __resetSupabaseAdminForTests: vi.fn(),
}))

import { UnauthorizedError } from '@/lib/whatsapp-oficial/api-auth'
import * as listaRoute from './route'
import * as detalheRoute from './[id]/route'
import * as destinatariosRoute from './[id]/destinatarios/route'
import * as aprovarRoute from './[id]/aprovar/route'
import * as pausarRoute from './[id]/pausar/route'
import * as retomarRoute from './[id]/retomar/route'
import * as cancelarRoute from './[id]/cancelar/route'
import * as dispatchRoute from './dispatch/route'

const GESTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CAMPANHA_ID = '11111111-1111-4111-8111-111111111111'
const OUTRA_CAMPANHA_ID = '44444444-4444-4444-8444-444444444444'
const CANAL_ID = '22222222-2222-4222-8222-222222222222'
const TEMPLATE_ID = '33333333-3333-4333-8333-333333333333'
const CRON_SECRET = 'test-cron-secret'

const ERRO_42501 = { code: '42501', message: 'sem_permissao' }

// ---------------------------------------------------------------- helpers

function postRequest(body?: unknown): Request {
  const init: RequestInit = { method: 'POST' }
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
    init.headers = { 'content-type': 'application/json' }
  }
  return new Request('http://localhost/api/whatsapp-oficial/campanhas', init)
}

function getRequest(query = ''): Request {
  return new Request(`http://localhost/api/whatsapp-oficial/campanhas${query}`)
}

function routeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

interface AdminStub {
  rpc: Mock
  from: Mock
}

/** `data`/`error` no formato que o supabase-js devolve (ele NÃO lança). */
function makeAdmin(outcome: { data?: unknown; error?: unknown } = {}): AdminStub {
  return {
    rpc: vi.fn().mockResolvedValue({ data: outcome.data ?? null, error: outcome.error ?? null }),
    from: vi.fn(),
  }
}

interface QueryOutcome {
  data: unknown
  error: unknown
}

interface QueryStub {
  select: Mock
  eq: Mock
  order: Mock
  limit: Mock
  range: Mock
  maybeSingle: Mock
  then: (
    resolve: (value: QueryOutcome) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise<unknown>
}

/** Builder do PostgREST fingido: encadeável e "thenable", como o de verdade. */
function makeQuery(outcome: QueryOutcome): QueryStub {
  const q = {} as QueryStub
  q.select = vi.fn(() => q)
  q.eq = vi.fn(() => q)
  q.order = vi.fn(() => q)
  q.limit = vi.fn(() => q)
  q.range = vi.fn(() => q)
  q.maybeSingle = vi.fn(() => Promise.resolve(outcome))
  q.then = (resolve, reject) => Promise.resolve(outcome).then(resolve, reject)
  return q
}

interface LinhaDestinatario {
  status: string | null
  motivo_supressao: string | null
}

/** Uma página por `await` — a rota de detalhe pagina até vir página curta. */
function makeRecipientsQuery(paginas: LinhaDestinatario[][]): QueryStub {
  let chamada = 0
  const q = {} as QueryStub
  q.select = vi.fn(() => q)
  q.eq = vi.fn(() => q)
  q.order = vi.fn(() => q)
  q.limit = vi.fn(() => q)
  q.range = vi.fn(() => q)
  q.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }))
  q.then = (resolve, reject) => {
    const pagina = paginas[chamada] ?? []
    chamada += 1
    return Promise.resolve({ data: pagina, error: null }).then(resolve, reject)
  }
  return q
}

function autenticado(admin: AdminStub, supabaseUser: { from: Mock } = { from: vi.fn() }) {
  mocks.requireGestaoSession.mockResolvedValue({ userId: GESTOR_ID, supabaseUser, admin })
  return { admin, supabaseUser }
}

function semSessao() {
  mocks.requireGestaoSession.mockRejectedValue(new UnauthorizedError())
}

beforeEach(() => {
  mocks.requireGestaoSession.mockReset()
  mocks.supabaseAdmin.mockReset()
  __resetRateLimitForTests()
})

// ------------------------------------------------------- GET /campanhas

describe('GET /api/whatsapp-oficial/campanhas', () => {
  it('devolve 401 sem sessão', async () => {
    semSessao()
    const res = await listaRoute.GET(getRequest())
    expect(res.status).toBe(401)
  })

  it('lê com o cliente da sessão e nunca com o service_role', async () => {
    const admin = makeAdmin()
    const query = makeQuery({ data: [{ id: CAMPANHA_ID, nome: 'Reativação' }], error: null })
    const supabaseUser = { from: vi.fn(() => query) }
    autenticado(admin, supabaseUser)

    const res = await listaRoute.GET(getRequest())
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.campanhas).toHaveLength(1)
    expect(supabaseUser.from).toHaveBeenCalledWith('whatsapp_broadcasts')
    // A RLS de whatsapp_broadcasts é a autorização da lista. Se algum dia
    // alguém "consertar" isto para o admin, a lista vaza o tenant inteiro.
    expect(admin.from).not.toHaveBeenCalled()
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('repassa os filtros de status e canal', async () => {
    const query = makeQuery({ data: [], error: null })
    autenticado(makeAdmin(), { from: vi.fn(() => query) })

    const res = await listaRoute.GET(getRequest(`?status=aprovado&canalId=${CANAL_ID}`))

    expect(res.status).toBe(200)
    expect(query.eq).toHaveBeenCalledWith('status', 'aprovado')
    expect(query.eq).toHaveBeenCalledWith('canal_id', CANAL_ID)
  })

  it('recusa status fora do vocabulário (422) e canalId fora do formato uuid', async () => {
    autenticado(makeAdmin(), { from: vi.fn(() => makeQuery({ data: [], error: null })) })

    expect((await listaRoute.GET(getRequest('?status=enviando_agora'))).status).toBe(422)
    expect((await listaRoute.GET(getRequest('?canalId=nao-e-uuid'))).status).toBe(422)
  })
})

// ------------------------------------------------------ POST /campanhas

describe('POST /api/whatsapp-oficial/campanhas', () => {
  const corpoValido = {
    canalId: CANAL_ID,
    nome: 'Reativação bolsão',
    templateId: TEMPLATE_ID,
    config: {
      segmentacao: { etapas: ['novo'], sem_corretor: true },
      politica_consentimento: 'exigir_base_legal',
      bases_legais: ['fb_lead_form'],
      cadencia_segundos: 30,
      politica_handoff: 'sophia_qualifica',
    },
  }

  it('devolve 401 sem sessão', async () => {
    semSessao()
    const res = await listaRoute.POST(postRequest(corpoValido))
    expect(res.status).toBe(401)
  })

  it('recusa bases_legais vazia com 422 antes de chamar a RPC', async () => {
    const admin = makeAdmin()
    autenticado(admin)

    const res = await listaRoute.POST(
      postRequest({ ...corpoValido, config: { ...corpoValido.config, bases_legais: [] } }),
    )
    const json = await res.json()

    expect(res.status).toBe(422)
    expect(json.error).toBe('bases_legais_vazia')
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('recusa janela de horário pela metade com 422, sem ir ao banco', async () => {
    const admin = makeAdmin()
    autenticado(admin)

    const soInicio = await listaRoute.POST(
      postRequest({ ...corpoValido, config: { ...corpoValido.config, janela_inicio: '09:00' } }),
    )
    const soFim = await listaRoute.POST(
      postRequest({ ...corpoValido, config: { ...corpoValido.config, janela_fim: '18:00' } }),
    )

    expect(soInicio.status).toBe(422)
    expect((await soInicio.json()).error).toBe('janela_incompleta')
    expect(soFim.status).toBe(422)
    expect((await soFim.json()).error).toBe('janela_incompleta')
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('recusa janela_dias vazia com 422 antes de chamar a RPC', async () => {
    // `[]` não é "todo dia serve": na RPC ele bloqueia TODOS os dias e a
    // campanha nasce condenada a nunca enviar, sem erro em lugar nenhum.
    const admin = makeAdmin()
    autenticado(admin)

    const res = await listaRoute.POST(
      postRequest({ ...corpoValido, config: { ...corpoValido.config, janela_dias: [] } }),
    )

    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe('janela_dias_vazia')
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it.each([
    { caso: 'dia 0 (domingo em base zero)', dias: [0, 1] as unknown },
    { caso: 'dia 8', dias: [8] as unknown },
    { caso: 'fração', dias: [1, 2.5] as unknown },
    { caso: 'número como string', dias: ['1'] as unknown },
    { caso: 'nem é lista', dias: 'seg,ter' as unknown },
  ])('recusa janela_dias com $caso (422)', async ({ dias }) => {
    const admin = makeAdmin()
    autenticado(admin)

    const res = await listaRoute.POST(
      postRequest({ ...corpoValido, config: { ...corpoValido.config, janela_dias: dias } }),
    )

    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe('janela_dias_invalida')
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('deixa a janela completa e válida passar intacta para a RPC', async () => {
    const admin = makeAdmin({ data: { ok: true, broadcast_id: CAMPANHA_ID, status: 'rascunho' } })
    autenticado(admin)

    const config = {
      ...corpoValido.config,
      janela_inicio: '09:00',
      janela_fim: '18:00',
      janela_dias: [1, 2, 3, 4, 5],
    }

    const res = await listaRoute.POST(postRequest({ ...corpoValido, config }))

    expect(res.status).toBe(201)
    // A validação da rota filtra, não reescreve: a config chega no banco igual
    // ao que o operador mandou.
    expect(admin.rpc).toHaveBeenCalledWith(
      'whatsapp_oficial_campanha_criar',
      expect.objectContaining({ p_config: config }),
    )
  })

  it('repassa o janela_incompleta da RPC como 422 (defesa em profundidade)', async () => {
    autenticado(makeAdmin({ data: { ok: false, reason: 'janela_incompleta' } }))

    const res = await listaRoute.POST(postRequest(corpoValido))

    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe('janela_incompleta')
  })

  // -- variaveis_padrao ------------------------------------------------------
  // Sem estas travas o jsonb entra CRU: a RPC faz um `coalesce` da chave e o
  // adapter faz um cast. Forma errada não erra em lugar nenhum até o worker, já
  // com as linhas de recipients/messages/outbox gravadas — e `variaveis_padrao`
  // é write-once, então não há conserto pela tela.

  it.each([
    { caso: 'array (passa pelo isRecord do adapter)', valor: ['Ana', '10h'] as unknown },
    { caso: 'escalar', valor: 'Ana' as unknown },
    { caso: 'body string', valor: { body: 'Ana' } as unknown },
    { caso: 'body com item não-string', valor: { body: ['ok', null] } as unknown },
    { caso: 'headerText array', valor: { headerText: ['Ana'] } as unknown },
    {
      caso: 'buttonParams com chave não-numérica',
      valor: { buttonParams: { url: 'x' } } as unknown,
    },
  ])('recusa variaveis_padrao $caso com 422 antes de chamar a RPC', async ({ valor }) => {
    const admin = makeAdmin()
    autenticado(admin)

    const res = await listaRoute.POST(
      postRequest({ ...corpoValido, config: { ...corpoValido.config, variaveis_padrao: valor } }),
    )

    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe('variaveis_padrao_invalida')
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('aplica os tetos de 40 valores e 1024 chars, com índice 1-indexado', async () => {
    const admin = makeAdmin()
    autenticado(admin)

    const demais = await listaRoute.POST(
      postRequest({
        ...corpoValido,
        config: {
          ...corpoValido.config,
          variaveis_padrao: { body: Array.from({ length: 41 }, () => 'x') },
        },
      }),
    )
    const longo = await listaRoute.POST(
      postRequest({
        ...corpoValido,
        config: { ...corpoValido.config, variaveis_padrao: { body: ['ok', 'x'.repeat(1025)] } },
      }),
    )

    expect(demais.status).toBe(422)
    expect(await demais.json()).toMatchObject({ error: 'valores_demais', recebidos: 41 })
    expect(longo.status).toBe(422)
    // 1-indexado para casar com o `{{2}}` que o operador vê na tela.
    expect(await longo.json()).toMatchObject({ error: 'valor_muito_longo', indice: 2 })
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('deixa um variaveis_padrao bem formado passar INTACTO para a RPC', async () => {
    const admin = makeAdmin({ data: { ok: true, broadcast_id: CAMPANHA_ID, status: 'rascunho' } })
    autenticado(admin)

    const variaveisPadrao = {
      body: ['Ana', '', '10h'],
      headerMediaUrl: 'https://cdn/x.png',
      buttonParams: { 0: 'promo-julho' },
    }
    const config = { ...corpoValido.config, variaveis_padrao: variaveisPadrao }

    const res = await listaRoute.POST(postRequest({ ...corpoValido, config }))

    expect(res.status).toBe(201)
    // A rota filtra, não reescreve — inclusive o buraco no meio do body, que é
    // significativo: compactar deslocaria {{3}} para o lugar de {{2}}.
    expect(admin.rpc).toHaveBeenCalledWith(
      'whatsapp_oficial_campanha_criar',
      expect.objectContaining({ p_config: config }),
    )
  })

  it('repassa o variaveis_insuficientes da RPC como 422 (o mínimo é do banco)', async () => {
    autenticado(makeAdmin({ data: { ok: false, reason: 'variaveis_insuficientes', exigidas: 3 } }))

    const res = await listaRoute.POST(postRequest(corpoValido))

    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe('variaveis_insuficientes')
  })

  it('recusa políticas fora do vocabulário e nome vazio com 422', async () => {
    const admin = makeAdmin()
    autenticado(admin)

    const consentimento = await listaRoute.POST(
      postRequest({
        ...corpoValido,
        config: { ...corpoValido.config, politica_consentimento: 'manda_bala' },
      }),
    )
    const handoff = await listaRoute.POST(
      postRequest({
        ...corpoValido,
        config: { ...corpoValido.config, politica_handoff: 'quem_pegar_primeiro' },
      }),
    )
    const nome = await listaRoute.POST(postRequest({ ...corpoValido, nome: '   ' }))

    expect(consentimento.status).toBe(422)
    expect((await consentimento.json()).error).toBe('politica_consentimento_invalida')
    expect(handoff.status).toBe(422)
    expect((await handoff.json()).error).toBe('politica_handoff_invalida')
    expect(nome.status).toBe(422)
    expect((await nome.json()).error).toBe('nome_obrigatorio')
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('devolve 404 quando o canal não existe', async () => {
    autenticado(makeAdmin({ data: { ok: false, reason: 'canal_nao_encontrado' } }))

    const res = await listaRoute.POST(postRequest(corpoValido))

    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('canal_nao_encontrado')
  })

  it('devolve 422 para as demais recusas da RPC', async () => {
    autenticado(makeAdmin({ data: { ok: false, reason: 'template_nao_aprovado' } }))

    const res = await listaRoute.POST(postRequest(corpoValido))

    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe('template_nao_aprovado')
  })

  it('cria a campanha repassando a config inteira para a RPC', async () => {
    const admin = makeAdmin({
      data: {
        ok: true,
        broadcast_id: CAMPANHA_ID,
        status: 'rascunho',
        provider: 'meta_cloud',
        canal_status: 'ativo',
      },
    })
    autenticado(admin)

    const res = await listaRoute.POST(postRequest(corpoValido))
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json.broadcast_id).toBe(CAMPANHA_ID)
    expect(admin.rpc).toHaveBeenCalledWith('whatsapp_oficial_campanha_criar', {
      p_actor_user_id: GESTOR_ID,
      p_canal_id: CANAL_ID,
      p_nome: 'Reativação bolsão',
      p_template_id: TEMPLATE_ID,
      p_mensagem_livre: null,
      p_config: corpoValido.config,
    })
  })

  it('traduz o 42501 da RPC em 403 (ator sem papel de gestão)', async () => {
    autenticado(makeAdmin({ error: ERRO_42501 }))

    const res = await listaRoute.POST(postRequest(corpoValido))

    expect(res.status).toBe(403)
  })

  it('devolve 429 quando estoura o orçamento de campanhaWrite', async () => {
    autenticado(makeAdmin({ data: { ok: true, broadcast_id: CAMPANHA_ID, status: 'rascunho' } }))

    const limite = 20
    for (let i = 0; i < limite; i += 1) {
      const ok = await listaRoute.POST(postRequest(corpoValido))
      expect(ok.status).toBe(201)
    }
    const estourou = await listaRoute.POST(postRequest(corpoValido))

    expect(estourou.status).toBe(429)
  })
})

// ------------------------------------------------- GET /campanhas/[id]

describe('GET /api/whatsapp-oficial/campanhas/[id]', () => {
  it('devolve 401 sem sessão', async () => {
    semSessao()
    const res = await detalheRoute.GET(getRequest(), routeParams(CAMPANHA_ID))
    expect(res.status).toBe(401)
  })

  it('agrega destinatários por status e por motivo, lendo com a sessão', async () => {
    const admin = makeAdmin()
    const campanhaQuery = makeQuery({
      data: {
        id: CAMPANHA_ID,
        nome: 'Reativação',
        status: 'rascunho',
        dry_run_resultado: { elegiveis: 4, suprimidos: 2 },
      },
      error: null,
    })
    const destinatariosQuery = makeRecipientsQuery([
      [
        { status: 'pendente', motivo_supressao: null },
        { status: 'pendente', motivo_supressao: null },
        { status: 'suprimido', motivo_supressao: 'optout' },
        { status: 'suprimido', motivo_supressao: 'cooldown' },
        { status: 'suprimido', motivo_supressao: 'optout' },
      ],
    ])
    const supabaseUser = {
      from: vi.fn((tabela: string) =>
        tabela === 'whatsapp_broadcasts' ? campanhaQuery : destinatariosQuery,
      ),
    }
    autenticado(admin, supabaseUser)

    const res = await detalheRoute.GET(getRequest(), routeParams(CAMPANHA_ID))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.campanha.dry_run_resultado).toEqual({ elegiveis: 4, suprimidos: 2 })
    expect(json.destinatarios).toEqual({
      total: 5,
      truncado: false,
      por_status: { pendente: 2, suprimido: 3 },
      por_motivo_supressao: { optout: 2, cooldown: 1 },
    })
    expect(supabaseUser.from).toHaveBeenCalledWith('whatsapp_broadcasts')
    expect(supabaseUser.from).toHaveBeenCalledWith('whatsapp_broadcast_recipients')
    expect(admin.from).not.toHaveBeenCalled()
  })

  it('CRÍTICO: diz o que o template ainda exige — a tela não tem o catálogo', async () => {
    // `variaveis_padrao` é write-once e é copiado para cada destinatário na
    // materialização: quem aprova precisa saber ANTES do clique que o envio vai
    // morrer com 422 permanente. E o veredito é recalculado a cada abertura de
    // propósito — o sync reescreve `variaveis` de um template já aprovado.
    const campanhaQuery = makeQuery({
      data: {
        id: CAMPANHA_ID,
        nome: 'Reativação',
        template_id: TEMPLATE_ID,
        variaveis_padrao: { body: ['Ana'] },
      },
      error: null,
    })
    const templateQuery = makeQuery({
      data: {
        id: TEMPLATE_ID,
        nome: 'order_confirmation',
        variaveis: { cabecalho: [], corpo: [1, 2, 3], botoes: [] },
        cabecalho_formato: null,
        cabecalho_texto: null,
        corpo_texto: 'Olá {{1}}, o pedido {{2}} chega em {{3}}.',
        componentes: [{ type: 'BODY', text: 'Olá {{1}}, o pedido {{2}} chega em {{3}}.' }],
      },
      error: null,
    })
    const supabaseUser = {
      from: vi.fn((tabela: string) => {
        if (tabela === 'whatsapp_broadcasts') return campanhaQuery
        if (tabela === 'whatsapp_templates') return templateQuery
        return makeRecipientsQuery([[]])
      }),
    }
    autenticado(makeAdmin(), supabaseUser)

    const res = await detalheRoute.GET(getRequest(), routeParams(CAMPANHA_ID))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.exigencias).toEqual({
      templateId: TEMPLATE_ID,
      nome: 'order_confirmation',
      faltando: ['corpo {{2}}', 'corpo {{3}}'],
      naoSuportado: null,
    })
    // Lido com a SESSÃO: `whatsapp_templates` só tem policy de SELECT para
    // gestão, e um service_role aqui vazaria catálogo de outro tenant.
    expect(supabaseUser.from).toHaveBeenCalledWith('whatsapp_templates')
  })

  it('campanha sem template não consulta o catálogo e devolve exigencias null', async () => {
    const campanhaQuery = makeQuery({
      data: { id: CAMPANHA_ID, template_id: null, variaveis_padrao: null },
      error: null,
    })
    const supabaseUser = {
      from: vi.fn((tabela: string) =>
        tabela === 'whatsapp_broadcasts' ? campanhaQuery : makeRecipientsQuery([[]]),
      ),
    }
    autenticado(makeAdmin(), supabaseUser)

    const json = await (await detalheRoute.GET(getRequest(), routeParams(CAMPANHA_ID))).json()

    expect(json.exigencias).toBeNull()
    expect(supabaseUser.from).not.toHaveBeenCalledWith('whatsapp_templates')
  })

  it('ordena TODA página do agregado por uma coluna estável e única', async () => {
    const campanhaQuery = makeQuery({ data: { id: CAMPANHA_ID }, error: null })
    // Página cheia (3) + página curta (1) = duas idas ao banco.
    const destinatariosQuery = makeRecipientsQuery([
      [
        { status: 'pendente', motivo_supressao: null },
        { status: 'pendente', motivo_supressao: null },
        { status: 'pendente', motivo_supressao: null },
      ],
      [{ status: 'enviado', motivo_supressao: null }],
    ])
    autenticado(makeAdmin(), {
      from: vi.fn((tabela: string) =>
        tabela === 'whatsapp_broadcasts' ? campanhaQuery : destinatariosQuery,
      ),
    })

    const res = await detalheRoute.GET(getRequest(), routeParams(CAMPANHA_ID))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.destinatarios.total).toBe(4)
    // Sem ORDER BY o Postgres não promete ordem entre uma página e a seguinte:
    // o dispatch marcando `enfileirado_em` no meio da contagem faz linha
    // reaparecer numa página posterior (contada duas vezes) ou fugir para trás
    // do cursor (nunca contada), e o agregado sai errado em silêncio.
    expect(destinatariosQuery.order.mock.calls).toEqual([
      ['id', { ascending: true }],
      ['id', { ascending: true }],
    ])
  })

  describe('teto do agregado', () => {
    /** 20 páginas cheias de 1000 = exatamente MAX_LINHAS_DESTINATARIOS. */
    function paginasAteOTeto(): LinhaDestinatario[][] {
      const cheia: LinhaDestinatario[] = Array.from({ length: 1000 }, () => ({
        status: 'pendente',
        motivo_supressao: null,
      }))
      return Array.from({ length: 20 }, () => cheia)
    }

    function detalheCom(paginas: LinhaDestinatario[][]) {
      const campanhaQuery = makeQuery({ data: { id: CAMPANHA_ID }, error: null })
      const destinatariosQuery = makeRecipientsQuery(paginas)
      autenticado(makeAdmin(), {
        from: vi.fn((tabela: string) =>
          tabela === 'whatsapp_broadcasts' ? campanhaQuery : destinatariosQuery,
        ),
      })
      return detalheRoute.GET(getRequest(), routeParams(CAMPANHA_ID))
    }

    it('total EXATAMENTE no teto não é truncado', async () => {
      // Não existe linha 20.001: o agregado está completo. Dizer "truncado"
      // aqui manda o operador caçar destinatários que não existem.
      const json = await (await detalheCom(paginasAteOTeto())).json()

      expect(json.destinatarios.total).toBe(20_000)
      expect(json.destinatarios.truncado).toBe(false)
    })

    it('teto + 1 é truncado, e a linha espiada não entra na conta', async () => {
      const json = await (
        await detalheCom([...paginasAteOTeto(), [{ status: 'pendente', motivo_supressao: null }]])
      ).json()

      expect(json.destinatarios.total).toBe(20_000)
      expect(json.destinatarios.truncado).toBe(true)
    })
  })

  it('devolve 404 quando a RLS esconde a campanha', async () => {
    const campanhaQuery = makeQuery({ data: null, error: null })
    autenticado(makeAdmin(), { from: vi.fn(() => campanhaQuery) })

    const res = await detalheRoute.GET(getRequest(), routeParams(CAMPANHA_ID))

    expect(res.status).toBe(404)
  })

  it('devolve 404 para um id fora do formato uuid, sem consultar o banco', async () => {
    const supabaseUser = { from: vi.fn() }
    autenticado(makeAdmin(), supabaseUser)

    const res = await detalheRoute.GET(getRequest(), routeParams('nao-e-uuid'))

    expect(res.status).toBe(404)
    expect(supabaseUser.from).not.toHaveBeenCalled()
  })
})

// ------------------------------ POST /campanhas/[id]/destinatarios

describe('POST /api/whatsapp-oficial/campanhas/[id]/destinatarios', () => {
  const respostaDryRun = {
    data: { ok: true, dry_run: true, elegiveis: 10, suprimidos: 2, a_enfileirar: 8 },
  }

  it('devolve 401 sem sessão', async () => {
    semSessao()
    const res = await destinatariosRoute.POST(postRequest({}), routeParams(CAMPANHA_ID))
    expect(res.status).toBe(401)
  })

  it('CRÍTICO: corpo sem o campo dryRun chama a RPC com p_dry_run = true', async () => {
    const admin = makeAdmin(respostaDryRun)
    autenticado(admin)

    const res = await destinatariosRoute.POST(postRequest({}), routeParams(CAMPANHA_ID))

    expect(res.status).toBe(200)
    expect(admin.rpc).toHaveBeenCalledWith('whatsapp_oficial_campanha_gerar_destinatarios', {
      p_actor_user_id: GESTOR_ID,
      p_broadcast_id: CAMPANHA_ID,
      p_dry_run: true,
      p_limite: null,
    })
  })

  it('CRÍTICO: só materializa com dryRun literalmente false', async () => {
    const admin = makeAdmin({ data: { ok: true, dry_run: false, linhas_gravadas: 8 } })
    autenticado(admin)

    await destinatariosRoute.POST(
      postRequest({ dryRun: false, limite: 500 }),
      routeParams(CAMPANHA_ID),
    )

    expect(admin.rpc).toHaveBeenCalledWith('whatsapp_oficial_campanha_gerar_destinatarios', {
      p_actor_user_id: GESTOR_ID,
      p_broadcast_id: CAMPANHA_ID,
      p_dry_run: false,
      p_limite: 500,
    })
  })

  it.each([
    { caso: 'corpo ausente', corpo: undefined as unknown },
    { caso: 'json quebrado', corpo: '{ nao é json' as unknown },
    { caso: 'dryRun como string', corpo: { dryRun: 'false' } as unknown },
    { caso: 'dryRun nulo', corpo: { dryRun: null } as unknown },
    { caso: 'dryRun zero', corpo: { dryRun: 0 } as unknown },
  ])('CRÍTICO: $caso continua sendo dry-run', async ({ corpo }) => {
    const admin = makeAdmin(respostaDryRun)
    autenticado(admin)

    await destinatariosRoute.POST(postRequest(corpo), routeParams(CAMPANHA_ID))

    expect(admin.rpc).toHaveBeenCalledWith(
      'whatsapp_oficial_campanha_gerar_destinatarios',
      expect.objectContaining({ p_dry_run: true }),
    )
  })

  it('recusa limite inválido com 422', async () => {
    const admin = makeAdmin(respostaDryRun)
    autenticado(admin)

    const res = await destinatariosRoute.POST(
      postRequest({ limite: -3 }),
      routeParams(CAMPANHA_ID),
    )

    expect(res.status).toBe(422)
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('mapeia campanha_nao_editavel para 409 e campanha_nao_encontrada para 404', async () => {
    autenticado(makeAdmin({ data: { ok: false, reason: 'campanha_nao_editavel', status: 'aprovado' } }))
    const conflito = await destinatariosRoute.POST(postRequest({}), routeParams(CAMPANHA_ID))
    expect(conflito.status).toBe(409)
    expect((await conflito.json()).status).toBe('aprovado')

    autenticado(makeAdmin({ data: { ok: false, reason: 'campanha_nao_encontrada' } }))
    const ausente = await destinatariosRoute.POST(postRequest({}), routeParams(CAMPANHA_ID))
    expect(ausente.status).toBe(404)
  })

  it('traduz o 42501 da RPC em 403 mesmo quando o client rejeita a promise', async () => {
    const admin = makeAdmin()
    admin.rpc.mockRejectedValue(ERRO_42501)
    autenticado(admin)

    const res = await destinatariosRoute.POST(postRequest({}), routeParams(CAMPANHA_ID))

    expect(res.status).toBe(403)
  })
})

// ----------------------------------- POST /campanhas/[id]/aprovar

describe('POST /api/whatsapp-oficial/campanhas/[id]/aprovar', () => {
  it('devolve 401 sem sessão', async () => {
    semSessao()
    const res = await aprovarRoute.POST(postRequest(), routeParams(CAMPANHA_ID))
    expect(res.status).toBe(401)
  })

  it.each([
    'status_invalido',
    'aprovador_igual_criador',
    'destinatarios_nao_gerados',
    'sem_destinatario_elegivel',
  ])('mapeia %s para 409', async (reason) => {
    autenticado(makeAdmin({ data: { ok: false, reason, status: 'rascunho' } }))

    const res = await aprovarRoute.POST(postRequest(), routeParams(CAMPANHA_ID))

    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe(reason)
  })

  it('mapeia campanha_nao_encontrada para 404', async () => {
    autenticado(makeAdmin({ data: { ok: false, reason: 'campanha_nao_encontrada' } }))
    const res = await aprovarRoute.POST(postRequest(), routeParams(CAMPANHA_ID))
    expect(res.status).toBe(404)
  })

  it('aprova e devolve o total de destinatários', async () => {
    const admin = makeAdmin({ data: { ok: true, status: 'aprovado', destinatarios: 812 } })
    autenticado(admin)

    const res = await aprovarRoute.POST(postRequest(), routeParams(CAMPANHA_ID))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.destinatarios).toBe(812)
    expect(admin.rpc).toHaveBeenCalledWith('whatsapp_oficial_campanha_aprovar', {
      p_actor_user_id: GESTOR_ID,
      p_broadcast_id: CAMPANHA_ID,
    })
  })
})

// -------------------------- pausar / retomar / cancelar

describe('POST /api/whatsapp-oficial/campanhas/[id]/{pausar,retomar,cancelar}', () => {
  const acoes = [
    { nome: 'pausar', handler: pausarRoute.POST },
    { nome: 'retomar', handler: retomarRoute.POST },
    { nome: 'cancelar', handler: cancelarRoute.POST },
  ]

  it.each(acoes)('$nome devolve 401 sem sessão', async ({ handler }) => {
    semSessao()
    const res = await handler(postRequest({}), routeParams(CAMPANHA_ID))
    expect(res.status).toBe(401)
  })

  it.each(acoes)('$nome mapeia status_invalido para 409', async ({ handler }) => {
    autenticado(makeAdmin({ data: { ok: false, reason: 'status_invalido', status: 'concluido' } }))

    const res = await handler(postRequest({}), routeParams(CAMPANHA_ID))
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.error).toBe('status_invalido')
    expect(json.status).toBe('concluido')
  })

  it('pausar repassa o motivo e devolve o novo status', async () => {
    const admin = makeAdmin({ data: { ok: true, status: 'pausado' } })
    autenticado(admin)

    const res = await pausarRoute.POST(
      postRequest({ motivo: 'volume alto de reclamação' }),
      routeParams(CAMPANHA_ID),
    )

    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('pausado')
    expect(admin.rpc).toHaveBeenCalledWith('whatsapp_oficial_campanha_pausar', {
      p_actor_user_id: GESTOR_ID,
      p_broadcast_id: CAMPANHA_ID,
      p_motivo: 'volume alto de reclamação',
    })
  })

  it('retomar mapeia sem_aprovador para 409', async () => {
    autenticado(makeAdmin({ data: { ok: false, reason: 'sem_aprovador' } }))
    const res = await retomarRoute.POST(postRequest(), routeParams(CAMPANHA_ID))
    expect(res.status).toBe(409)
  })

  it('cancelar devolve itens_cancelados', async () => {
    const admin = makeAdmin({ data: { ok: true, status: 'cancelado', itens_cancelados: 137 } })
    autenticado(admin)

    const res = await cancelarRoute.POST(
      postRequest({ motivo: 'campanha errada' }),
      routeParams(CAMPANHA_ID),
    )
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.itens_cancelados).toBe(137)
    expect(admin.rpc).toHaveBeenCalledWith('whatsapp_oficial_campanha_cancelar', {
      p_actor_user_id: GESTOR_ID,
      p_broadcast_id: CAMPANHA_ID,
      p_motivo: 'campanha errada',
    })
  })

  it('cancelar traduz o 42501 da RPC em 403', async () => {
    autenticado(makeAdmin({ error: ERRO_42501 }))
    const res = await cancelarRoute.POST(postRequest({}), routeParams(CAMPANHA_ID))
    expect(res.status).toBe(403)
  })
})

// ------------------------------------- POST /campanhas/dispatch

describe('POST /api/whatsapp-oficial/campanhas/dispatch', () => {
  function cronRequest(opts: { secret?: string; body?: unknown } = {}): Request {
    const headers = new Headers()
    if (opts.secret !== undefined) headers.set('x-cron-secret', opts.secret)
    const init: RequestInit = { method: 'POST', headers }
    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body)
      headers.set('content-type', 'application/json')
    }
    return new Request('http://localhost/api/whatsapp-oficial/campanhas/dispatch', init)
  }

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('devolve 503 quando o segredo do cron não está configurado', async () => {
    vi.stubEnv('WHATSAPP_OUTBOX_CRON_SECRET', '')

    const res = await dispatchRoute.POST(cronRequest({ secret: 'qualquer' }))

    expect(res.status).toBe(503)
    expect(mocks.supabaseAdmin).not.toHaveBeenCalled()
  })

  it('devolve 401 com segredo errado ou ausente', async () => {
    vi.stubEnv('WHATSAPP_OUTBOX_CRON_SECRET', CRON_SECRET)

    expect((await dispatchRoute.POST(cronRequest())).status).toBe(401)
    expect((await dispatchRoute.POST(cronRequest({ secret: 'errado' }))).status).toBe(401)
    expect(mocks.supabaseAdmin).not.toHaveBeenCalled()
  })

  it('enfileira um lote por campanha pendente e soma os enfileirados', async () => {
    vi.stubEnv('WHATSAPP_OUTBOX_CRON_SECRET', CRON_SECRET)

    const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'whatsapp_oficial_campanhas_pendentes') {
        return {
          data: {
            ok: true,
            campanhas: [
              { broadcast_id: CAMPANHA_ID, tenant_id: 'sunt', nome: 'A', status: 'aprovado' },
              { broadcast_id: OUTRA_CAMPANHA_ID, tenant_id: 'sunt', nome: 'B', status: 'enviando' },
            ],
          },
          error: null,
        }
      }
      if (args.p_broadcast_id === CAMPANHA_ID) {
        return { data: { ok: true, enfileirados: 25, lote: 25 }, error: null }
      }
      return { data: { ok: true, enfileirados: 0, reason: 'fora_da_janela_hora' }, error: null }
    })
    mocks.supabaseAdmin.mockReturnValue({ rpc })

    const res = await dispatchRoute.POST(cronRequest({ secret: CRON_SECRET, body: { limite: 5 } }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.campanhas).toBe(2)
    expect(json.enfileirados).toBe(25)
    expect(json.resultados).toEqual([
      { broadcast_id: CAMPANHA_ID, enfileirados: 25 },
      { broadcast_id: OUTRA_CAMPANHA_ID, enfileirados: 0, reason: 'fora_da_janela_hora' },
    ])
    expect(rpc).toHaveBeenCalledWith('whatsapp_oficial_campanhas_pendentes', { p_limite: 5 })
  })

  it('uma campanha que explode não impede as seguintes', async () => {
    vi.stubEnv('WHATSAPP_OUTBOX_CRON_SECRET', CRON_SECRET)

    const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'whatsapp_oficial_campanhas_pendentes') {
        return {
          data: {
            ok: true,
            campanhas: [{ broadcast_id: CAMPANHA_ID }, { broadcast_id: OUTRA_CAMPANHA_ID }],
          },
          error: null,
        }
      }
      if (args.p_broadcast_id === CAMPANHA_ID) {
        throw new Error('deadlock detected')
      }
      return { data: { ok: true, enfileirados: 7 }, error: null }
    })
    mocks.supabaseAdmin.mockReturnValue({ rpc })

    const res = await dispatchRoute.POST(cronRequest({ secret: CRON_SECRET }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.campanhas).toBe(2)
    expect(json.enfileirados).toBe(7)
    expect(json.resultados[0]).toEqual({
      broadcast_id: CAMPANHA_ID,
      enfileirados: 0,
      reason: 'erro_ao_enfileirar',
    })
    expect(json.resultados[1].enfileirados).toBe(7)
  })

  it('faz clamp do limite em 1..50 e aceita corpo vazio', async () => {
    vi.stubEnv('WHATSAPP_OUTBOX_CRON_SECRET', CRON_SECRET)

    const rpc = vi.fn().mockResolvedValue({ data: { ok: true, campanhas: [] }, error: null })
    mocks.supabaseAdmin.mockReturnValue({ rpc })

    await dispatchRoute.POST(cronRequest({ secret: CRON_SECRET, body: { limite: 9999 } }))
    expect(rpc).toHaveBeenLastCalledWith('whatsapp_oficial_campanhas_pendentes', { p_limite: 50 })

    await dispatchRoute.POST(cronRequest({ secret: CRON_SECRET, body: { limite: 0 } }))
    expect(rpc).toHaveBeenLastCalledWith('whatsapp_oficial_campanhas_pendentes', { p_limite: 1 })

    await dispatchRoute.POST(cronRequest({ secret: CRON_SECRET }))
    expect(rpc).toHaveBeenLastCalledWith('whatsapp_oficial_campanhas_pendentes', { p_limite: null })
  })

  it('devolve 500 quando a RPC de campanhas pendentes falha', async () => {
    vi.stubEnv('WHATSAPP_OUTBOX_CRON_SECRET', CRON_SECRET)

    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'db down' } })
    mocks.supabaseAdmin.mockReturnValue({ rpc })

    const res = await dispatchRoute.POST(cronRequest({ secret: CRON_SECRET }))

    expect(res.status).toBe(500)
  })
})
