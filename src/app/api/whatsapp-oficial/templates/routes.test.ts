/**
 * Contract tests das quatro rotas de template
 * (`GET /templates`, `POST /templates/sync`, `POST /templates/preview`,
 * `POST /templates/enviar`).
 *
 * Os handlers são importados direto (sem servidor HTTP) e todo colaborador é
 * mockado: `api-auth` (sessão/RLS), `crypto` (decifra do token do canal),
 * `supabase-admin` e o `fetch` global. Nada aqui toca a Meta nem um Supabase
 * real.
 *
 * O teste mais importante do arquivo não é de status code: é
 * "o token decifrado nunca aparece na resposta". Ele roda nos TRÊS caminhos
 * (sucesso, erro da Meta, erro da RPC) porque a rota manuseia uma credencial
 * de canal em texto claro e um vazamento sairia pela tela de gestão.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'
import {
  TEMPLATE_MAX_TAMANHO_VALOR,
  TEMPLATE_MAX_VALORES,
} from '@/lib/whatsapp-oficial/meta-templates'

const mocks = vi.hoisted(() => ({
  requireGestaoSession: vi.fn(),
  requireConversationAccess: vi.fn(),
  decryptToken: vi.fn(),
  supabaseAdmin: vi.fn(),
}))

vi.mock('@/lib/whatsapp-oficial/api-auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/whatsapp-oficial/api-auth')>(
    '@/lib/whatsapp-oficial/api-auth',
  )
  return {
    ...actual,
    requireGestaoSession: mocks.requireGestaoSession,
    requireConversationAccess: mocks.requireConversationAccess,
  }
})

vi.mock('@/lib/whatsapp-oficial/crypto', () => ({
  decryptToken: mocks.decryptToken,
}))

vi.mock('@/lib/whatsapp-oficial/supabase-admin', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}))

import { UnauthorizedError, NotFoundError } from '@/lib/whatsapp-oficial/api-auth'
import { GET as listarTemplates } from './route'
import { POST as sincronizarTemplates } from './sync/route'
import { POST as previewTemplate } from './preview/route'
import { POST as enviarTemplate } from './enviar/route'

/** Token reconhecível: qualquer teste pode afirmar que ele NÃO saiu na resposta. */
const TOKEN_DECIFRADO = 'EAAsegredo-do-canal-NAO-PODE-VAZAR-1234567890'

interface QueryResult {
  data: unknown
  error: { message: string } | null
}

interface QueryBuilder {
  select: Mock
  eq: Mock
  order: Mock
  maybeSingle: Mock
  /** O query builder do supabase-js é thenable: `await from().select()` resolve
   *  sem `.maybeSingle()`. A lista depende disso. */
  then: (
    onFulfilled?: ((value: QueryResult) => unknown) | null,
    onRejected?: ((reason: unknown) => unknown) | null,
  ) => Promise<unknown>
}

function makeQueryBuilder(result: QueryResult): QueryBuilder {
  const builder = {} as QueryBuilder
  builder.select = vi.fn(() => builder)
  builder.eq = vi.fn(() => builder)
  builder.order = vi.fn(() => builder)
  builder.maybeSingle = vi.fn(() => Promise.resolve(result))
  builder.then = (onFulfilled, onRejected) =>
    Promise.resolve(result).then(onFulfilled, onRejected)
  return builder
}

function makeClient(result: QueryResult) {
  const builder = makeQueryBuilder(result)
  return { client: { from: vi.fn(() => builder) }, builder }
}

function postRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost/api/whatsapp-oficial/templates${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function getRequest(query = ''): Request {
  return new Request(`http://localhost/api/whatsapp-oficial/templates${query}`)
}

function metaResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as unknown as Response
}

// ---------------------------------------------------------------------------
// POST /api/whatsapp-oficial/templates/sync
// ---------------------------------------------------------------------------

const CANAL_META = {
  id: 'canal-1',
  tenant_id: 'sunt',
  provider: 'meta_cloud',
  waba_id: 'waba-1',
  access_token_cifrado: '\\xdeadbeef',
}

const TEMPLATE_META_VALIDO = {
  id: 'meta-1',
  name: 'boas_vindas',
  language: 'pt_BR',
  status: 'APPROVED',
  category: 'MARKETING',
  components: [{ type: 'BODY', text: 'Olá {{1}}!', example: { body_text: [['Ana']] } }],
  quality_score: { score: 'GREEN' },
}

/** Sem `name` — `toSuntTemplatePayload` devolve null e a rota conta em `ignorados`. */
const TEMPLATE_META_SEM_NOME = { id: 'meta-2', language: 'pt_BR', status: 'APPROVED' }

const SYNC_RPC_OK = {
  ok: true,
  total: 1,
  inseridos: 1,
  atualizados: 0,
  inalterados: 0,
  truncado: false,
  erros: [],
}

function makeSyncAdmin(
  opts: {
    canal?: QueryResult
    rpcData?: unknown
    /** `code` é o SQLSTATE que o PostgREST repassa — 42501 = sem permissão. */
    rpcError?: { message: string; code?: string } | null
  } = {},
) {
  const builder = makeQueryBuilder(opts.canal ?? { data: CANAL_META, error: null })
  return {
    from: vi.fn(() => builder),
    rpc: vi.fn(() =>
      Promise.resolve({
        data: opts.rpcData ?? SYNC_RPC_OK,
        error: opts.rpcError ?? null,
      }),
    ),
  }
}

function gestaoContext(admin: unknown, supabaseUser: unknown = { from: vi.fn() }) {
  return { userId: 'gestor-1', supabaseUser, admin }
}

/** Sessão que a RLS de `whatsapp_channels` deixa ver o canal (= gestão do tenant). */
function gestaoComCanalVisivel(admin: unknown, visivel: unknown = { id: 'canal-1' }) {
  const { client } = makeClient({ data: visivel, error: null })
  return gestaoContext(admin, client)
}

describe('POST /api/whatsapp-oficial/templates/sync', () => {
  let fetchMock: Mock

  beforeEach(() => {
    __resetRateLimitForTests()
    mocks.requireGestaoSession.mockReset()
    mocks.decryptToken.mockReset().mockReturnValue(TOKEN_DECIFRADO)
    mocks.supabaseAdmin.mockReset()
    fetchMock = vi.fn(async () =>
      metaResponse({ data: [TEMPLATE_META_VALIDO, TEMPLATE_META_SEM_NOME], paging: {} }),
    )
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('recusa quem não tem sessão (401)', async () => {
    mocks.requireGestaoSession.mockRejectedValue(new UnauthorizedError())

    const res = await sincronizarTemplates(postRequest('/sync', { canalId: 'canal-1' }))

    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exige canalId antes de qualquer I/O (400)', async () => {
    const res = await sincronizarTemplates(postRequest('/sync', {}))

    expect(res.status).toBe(400)
    expect(mocks.requireGestaoSession).not.toHaveBeenCalled()
  })

  it('corta em 429 quando estoura o orçamento de sync', async () => {
    const admin = makeSyncAdmin()
    mocks.requireGestaoSession.mockResolvedValue(gestaoComCanalVisivel(admin))

    const limite = 6
    for (let i = 0; i < limite; i++) {
      const ok = await sincronizarTemplates(postRequest('/sync', { canalId: 'canal-1' }))
      expect(ok.status).toBe(200)
    }

    const res = await sincronizarTemplates(postRequest('/sync', { canalId: 'canal-1' }))

    expect(res.status).toBe(429)
    expect(admin.rpc).toHaveBeenCalledTimes(limite)
  })

  it('barra quem a RLS não deixa ver o canal, ANTES de decifrar o token', async () => {
    // A RPC de sync só confere `service_role` — não existe gate de papel no
    // banco. Se este 404 cair, uma sessão de corretor sincroniza o catálogo do
    // tenant e queima a cota da Meta.
    const admin = makeSyncAdmin()
    mocks.requireGestaoSession.mockResolvedValue(gestaoComCanalVisivel(admin, null))

    const res = await sincronizarTemplates(postRequest('/sync', { canalId: 'canal-1' }))
    const json = await res.json()

    expect(res.status).toBe(404)
    expect(json.error).toBe('canal_nao_encontrado')
    expect(admin.from).not.toHaveBeenCalled()
    expect(mocks.decryptToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('devolve 404 para canal inexistente', async () => {
    const admin = makeSyncAdmin({ canal: { data: null, error: null } })
    mocks.requireGestaoSession.mockResolvedValue(gestaoComCanalVisivel(admin))

    const res = await sincronizarTemplates(postRequest('/sync', { canalId: 'sumiu' }))
    const json = await res.json()

    expect(res.status).toBe(404)
    expect(json.error).toBe('canal_nao_encontrado')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('devolve 422 para canal evolution (não tem catálogo na Meta)', async () => {
    const admin = makeSyncAdmin({
      canal: {
        data: { ...CANAL_META, provider: 'evolution', waba_id: null },
        error: null,
      },
    })
    mocks.requireGestaoSession.mockResolvedValue(gestaoComCanalVisivel(admin))

    const res = await sincronizarTemplates(postRequest('/sync', { canalId: 'canal-evo' }))
    const json = await res.json()

    expect(res.status).toBe(422)
    expect(json.error).toBe('provider_sem_template')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('devolve 422 quando falta waba_id ou o token do canal', async () => {
    for (const canal of [
      { ...CANAL_META, waba_id: null },
      { ...CANAL_META, access_token_cifrado: null },
    ]) {
      __resetRateLimitForTests()
      const admin = makeSyncAdmin({ canal: { data: canal, error: null } })
      mocks.requireGestaoSession.mockResolvedValue(gestaoComCanalVisivel(admin))

      const res = await sincronizarTemplates(postRequest('/sync', { canalId: 'canal-1' }))
      const json = await res.json()

      expect(res.status).toBe(422)
      expect(json.error).toBe('credencial_ausente')
      expect(mocks.decryptToken).not.toHaveBeenCalled()
    }
  })

  it('devolve 502 com a mensagem da Meta quando a Graph API falha', async () => {
    fetchMock.mockResolvedValue(
      metaResponse(
        { error: { message: 'Application does not have permission for this action' } },
        { ok: false, status: 403 },
      ),
    )
    const admin = makeSyncAdmin()
    mocks.requireGestaoSession.mockResolvedValue(gestaoComCanalVisivel(admin))

    const res = await sincronizarTemplates(postRequest('/sync', { canalId: 'canal-1' }))
    const json = await res.json()

    expect(res.status).toBe(502)
    expect(json.error).toBe('meta_api_error')
    expect(json.detalhe).toContain('does not have permission')
    expect(json.meta_status).toBe(403)
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('mapeia o catálogo e chama a RPC com o payload traduzido', async () => {
    const admin = makeSyncAdmin()
    mocks.requireGestaoSession.mockResolvedValue(gestaoComCanalVisivel(admin))

    const res = await sincronizarTemplates(postRequest('/sync', { canalId: 'canal-1' }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(admin.rpc).toHaveBeenCalledWith('whatsapp_oficial_sync_templates', {
      // A versão de 4 argumentos foi DROPADA no banco: sem `p_actor_user_id` a
      // chamada volta "function does not exist" e o sync some inteiro.
      p_actor_user_id: 'gestor-1',
      p_tenant_id: 'sunt',
      p_canal_id: 'canal-1',
      p_templates: [
        {
          meta_template_id: 'meta-1',
          nome: 'boas_vindas',
          idioma: 'pt_BR',
          categoria: 'MARKETING',
          status_aprovacao: 'aprovado',
          quality_score: 'GREEN',
          componentes: TEMPLATE_META_VALIDO.components,
          exemplos: { body: ['Ana'] },
          motivo_rejeicao: null,
        },
      ],
      p_truncado: false,
    })
    // O template sem nome não vira linha, mas também não some do relatório.
    expect(json.ignorados).toBe(1)
    expect(json.inseridos).toBe(1)
    expect(json.truncado).toBe(false)
    expect(json.aviso).toBeUndefined()
  })

  it('avisa explicitamente quando o catálogo foi truncado', async () => {
    const admin = makeSyncAdmin({ rpcData: { ...SYNC_RPC_OK, truncado: true } })
    mocks.requireGestaoSession.mockResolvedValue(gestaoComCanalVisivel(admin))

    const res = await sincronizarTemplates(postRequest('/sync', { canalId: 'canal-1' }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.truncado).toBe(true)
    expect(json.aviso).toContain('2000')
  })

  it('traduz a recusa da RPC (canal de outro tenant) para 403', async () => {
    const admin = makeSyncAdmin({ rpcData: { ok: false, reason: 'canal_de_outro_tenant' } })
    mocks.requireGestaoSession.mockResolvedValue(gestaoComCanalVisivel(admin))

    const res = await sincronizarTemplates(postRequest('/sync', { canalId: 'canal-1' }))
    const json = await res.json()

    expect(res.status).toBe(403)
    expect(json.error).toBe('canal_de_outro_tenant')
  })

  it('vira 403 quando a RPC devolve 42501 para quem a RLS deixou passar', async () => {
    // Caso concreto: `lider`. `crm_is_gestao()` inclui líder, então ele ENXERGA
    // o canal e passa pelo pré-check de RLS acima — quem o recusa é a RPC, que
    // só aceita owner/admin/gestor. Um 500 aqui mandaria o operador abrir
    // chamado de "erro do servidor" por uma questão de permissão.
    const admin = makeSyncAdmin({ rpcError: { message: 'sem_permissao', code: '42501' } })
    mocks.requireGestaoSession.mockResolvedValue(gestaoComCanalVisivel(admin))

    const res = await sincronizarTemplates(postRequest('/sync', { canalId: 'canal-1' }))
    const json = await res.json()

    expect(res.status).toBe(403)
    expect(json.error).toBe('sem_permissao')
    // O token JÁ foi decifrado neste ponto (a recusa vem depois da ida à Meta):
    // a resposta de erro é justamente onde ele vazaria.
    expect(mocks.decryptToken).toHaveBeenCalled()
    expect(JSON.stringify(json)).not.toContain(TOKEN_DECIFRADO)
  })

  it('repassa 42501 lançado pela RPC como 403', async () => {
    const admin = makeSyncAdmin()
    admin.rpc = vi.fn(() =>
      Promise.reject(Object.assign(new Error('sem_permissao'), { code: '42501' })),
    ) as unknown as typeof admin.rpc
    mocks.requireGestaoSession.mockResolvedValue(gestaoComCanalVisivel(admin))

    const res = await sincronizarTemplates(postRequest('/sync', { canalId: 'canal-1' }))

    expect(res.status).toBe(403)
  })

  describe('o token decifrado nunca sai na resposta', () => {
    it('usa o token no header da Meta mas não o devolve no caminho feliz', async () => {
      const admin = makeSyncAdmin()
      mocks.requireGestaoSession.mockResolvedValue(gestaoComCanalVisivel(admin))

      const res = await sincronizarTemplates(postRequest('/sync', { canalId: 'canal-1' }))
      const json = await res.json()

      // Prova que a asserção abaixo não é vazia: o token FOI decifrado e usado.
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect((init.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${TOKEN_DECIFRADO}`,
      )
      expect(JSON.stringify(json)).not.toContain(TOKEN_DECIFRADO)
    })

    it('redige o token quando a própria Meta o ecoa na mensagem de erro', async () => {
      // Cenário real: os cursores `paging.next` da Graph API carregam
      // `access_token=` na query string, então um erro que cite a URL vazaria
      // a credencial do canal para a tela de gestão.
      fetchMock.mockResolvedValue(
        metaResponse(
          {
            error: {
              message:
                'Invalid OAuth token in https://graph.facebook.com/v24.0/waba-1/' +
                `message_templates?access_token=${TOKEN_DECIFRADO}`,
            },
          },
          { ok: false, status: 401 },
        ),
      )
      const admin = makeSyncAdmin()
      mocks.requireGestaoSession.mockResolvedValue(gestaoComCanalVisivel(admin))

      const res = await sincronizarTemplates(postRequest('/sync', { canalId: 'canal-1' }))
      const json = await res.json()

      expect(res.status).toBe(502)
      expect(JSON.stringify(json)).not.toContain(TOKEN_DECIFRADO)
      expect(json.detalhe).toContain('[REDACTED]')
    })

    it('não devolve o token quando a RPC de sync falha', async () => {
      const admin = makeSyncAdmin({
        rpcError: { message: `db down while using ${TOKEN_DECIFRADO}` },
      })
      mocks.requireGestaoSession.mockResolvedValue(gestaoComCanalVisivel(admin))

      const res = await sincronizarTemplates(postRequest('/sync', { canalId: 'canal-1' }))
      const json = await res.json()

      expect(res.status).toBe(500)
      expect(JSON.stringify(json)).not.toContain(TOKEN_DECIFRADO)
    })
  })
})

// ---------------------------------------------------------------------------
// GET /api/whatsapp-oficial/templates
// ---------------------------------------------------------------------------

const LINHA_TEMPLATE = {
  id: 'tpl-1',
  canal_id: 'canal-1',
  meta_template_id: 'meta-1',
  nome: 'boas_vindas',
  idioma: 'pt_BR',
  categoria: 'MARKETING',
  status_aprovacao: 'aprovado',
  quality_score: 'GREEN',
  corpo_texto: 'Olá {{1}}!',
  cabecalho_texto: null,
  cabecalho_formato: null,
  rodape_texto: null,
  variaveis: { cabecalho: [], corpo: [1], botoes: [] },
  motivo_rejeicao: null,
  sincronizado_em: '2026-07-25T12:00:00Z',
}

describe('GET /api/whatsapp-oficial/templates', () => {
  beforeEach(() => {
    __resetRateLimitForTests()
    mocks.requireGestaoSession.mockReset()
    mocks.supabaseAdmin.mockReset()
  })

  it('recusa quem não tem sessão (401)', async () => {
    mocks.requireGestaoSession.mockRejectedValue(new UnauthorizedError())

    const res = await listarTemplates(getRequest())

    expect(res.status).toBe(401)
  })

  it('lê com o cliente COM SESSÃO — nunca com service_role', async () => {
    const { client: supabaseUser, builder } = makeClient({
      data: [LINHA_TEMPLATE],
      error: null,
    })
    const admin = { from: vi.fn(), rpc: vi.fn() }
    mocks.requireGestaoSession.mockResolvedValue(gestaoContext(admin, supabaseUser))

    const res = await listarTemplates(getRequest())
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.templates).toEqual([LINHA_TEMPLATE])
    expect(supabaseUser.from).toHaveBeenCalledWith('whatsapp_templates')
    // A RLS é o gate desta rota: um select com service_role devolveria o
    // catálogo de outros tenants sem checagem nenhuma.
    expect(admin.from).not.toHaveBeenCalled()
    expect(mocks.supabaseAdmin).not.toHaveBeenCalled()
    expect(builder.order).toHaveBeenCalledWith('nome')
    expect(builder.order).toHaveBeenCalledWith('idioma')
  })

  it('aplica os filtros de canal, status e idioma quando vêm na query', async () => {
    const { client: supabaseUser, builder } = makeClient({ data: [], error: null })
    mocks.requireGestaoSession.mockResolvedValue(
      gestaoContext({ from: vi.fn() }, supabaseUser),
    )

    const res = await listarTemplates(
      getRequest('?canalId=canal-1&status=aprovado&idioma=pt_BR'),
    )

    expect(res.status).toBe(200)
    expect(builder.eq).toHaveBeenCalledWith('canal_id', 'canal-1')
    expect(builder.eq).toHaveBeenCalledWith('status_aprovacao', 'aprovado')
    expect(builder.eq).toHaveBeenCalledWith('idioma', 'pt_BR')
  })

  it('não filtra nada quando a query vem vazia', async () => {
    const { client: supabaseUser, builder } = makeClient({ data: [], error: null })
    mocks.requireGestaoSession.mockResolvedValue(
      gestaoContext({ from: vi.fn() }, supabaseUser),
    )

    await listarTemplates(getRequest('?canalId=&status='))

    expect(builder.eq).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// POST /api/whatsapp-oficial/templates/preview
// ---------------------------------------------------------------------------

const TEMPLATE_COM_DUAS_VARIAVEIS = {
  id: 'tpl-1',
  nome: 'convite_visita',
  idioma: 'pt_BR',
  status_aprovacao: 'aprovado',
  componentes: [
    { type: 'HEADER', format: 'TEXT', text: 'Olá {{1}}' },
    { type: 'BODY', text: 'Sua visita ao {{1}} é {{2}}.' },
    { type: 'FOOTER', text: 'SUNT' },
  ],
  variaveis: { cabecalho: [1], corpo: [1, 2], botoes: [] },
}

describe('POST /api/whatsapp-oficial/templates/preview', () => {
  let fetchMock: Mock

  beforeEach(() => {
    __resetRateLimitForTests()
    mocks.requireGestaoSession.mockReset()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renderiza o preview sem nenhuma chamada de rede', async () => {
    const { client: supabaseUser } = makeClient({
      data: TEMPLATE_COM_DUAS_VARIAVEIS,
      error: null,
    })
    mocks.requireGestaoSession.mockResolvedValue(
      gestaoContext({ from: vi.fn(), rpc: vi.fn() }, supabaseUser),
    )

    const res = await previewTemplate(
      postRequest('/preview', {
        templateId: 'tpl-1',
        valores: { cabecalho: ['Ana'], corpo: ['Residencial X', 'sábado 10h'] },
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(json.preview.cabecalho).toBe('Olá Ana')
    expect(json.preview.corpo).toBe('Sua visita ao Residencial X é sábado 10h.')
    expect(json.preview.rodape).toBe('SUNT')
    expect(json.validacao.ok).toBe(true)
  })

  it('lista o que falta quando os valores não cobrem as variáveis', async () => {
    const { client: supabaseUser } = makeClient({
      data: TEMPLATE_COM_DUAS_VARIAVEIS,
      error: null,
    })
    mocks.requireGestaoSession.mockResolvedValue(
      gestaoContext({ from: vi.fn() }, supabaseUser),
    )

    const res = await previewTemplate(
      postRequest('/preview', { templateId: 'tpl-1', valores: { corpo: ['Residencial X'] } }),
    )
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.validacao.ok).toBe(false)
    expect(json.validacao.faltando).toEqual([
      { onde: 'corpo', exigidas: 2, fornecidas: 1 },
      { onde: 'cabecalho', exigidas: 1, fornecidas: 0 },
    ])
  })

  it('usa a coluna `variaveis` do banco como fonte única', async () => {
    // Coluna divergente dos componentes de propósito: se a rota derivasse do
    // texto, `corpo` viria [1,2] e este teste falharia.
    const { client: supabaseUser } = makeClient({
      data: {
        ...TEMPLATE_COM_DUAS_VARIAVEIS,
        variaveis: { cabecalho: [], corpo: [1], botoes: [{ indice: 0, tipo: 'URL', variaveis: [1] }] },
      },
      error: null,
    })
    mocks.requireGestaoSession.mockResolvedValue(
      gestaoContext({ from: vi.fn() }, supabaseUser),
    )

    const res = await previewTemplate(postRequest('/preview', { templateId: 'tpl-1' }))
    const json = await res.json()

    expect(json.variaveis.corpo).toEqual([1])
    expect(json.variaveis.botoes).toEqual([{ indice: 0, tipo: 'URL', variaveis: [1] }])
  })

  it('cai para os componentes quando a coluna `variaveis` vem vazia', async () => {
    const { client: supabaseUser } = makeClient({
      data: { ...TEMPLATE_COM_DUAS_VARIAVEIS, variaveis: null },
      error: null,
    })
    mocks.requireGestaoSession.mockResolvedValue(
      gestaoContext({ from: vi.fn() }, supabaseUser),
    )

    const res = await previewTemplate(postRequest('/preview', { templateId: 'tpl-1' }))
    const json = await res.json()

    expect(json.variaveis.corpo).toEqual([1, 2])
    expect(json.variaveis.cabecalho).toEqual([1])
  })

  it('devolve 404 para template que a RLS esconde', async () => {
    const { client: supabaseUser } = makeClient({ data: null, error: null })
    mocks.requireGestaoSession.mockResolvedValue(
      gestaoContext({ from: vi.fn() }, supabaseUser),
    )

    const res = await previewTemplate(postRequest('/preview', { templateId: 'de-outro-tenant' }))

    expect(res.status).toBe(404)
  })

  it('recusa `valores` que não é objeto de arrays de string (400)', async () => {
    mocks.requireGestaoSession.mockResolvedValue(gestaoContext({ from: vi.fn() }))

    const res = await previewTemplate(
      postRequest('/preview', { templateId: 'tpl-1', valores: { corpo: [1, 2] } }),
    )

    expect(res.status).toBe(400)
  })

  // -------------------------------------------------------------------------
  // Custo da rota. Preview não escreve nada, o que fez ela nascer sem rate
  // limit e sem teto de entrada — mas ela renderiza texto com valores do
  // chamador, na única instância do Coolify.
  // -------------------------------------------------------------------------

  /** Sessão de gestão com o template de duas variáveis visível pela RLS. */
  function previewComTemplateVisivel() {
    const { client: supabaseUser } = makeClient({
      data: TEMPLATE_COM_DUAS_VARIAVEIS,
      error: null,
    })
    mocks.requireGestaoSession.mockResolvedValue(
      gestaoContext({ from: vi.fn(), rpc: vi.fn() }, supabaseUser),
    )
    return supabaseUser
  }

  it('corta em 429 quando estoura o orçamento de preview', async () => {
    const supabaseUser = previewComTemplateVisivel()

    // `campanhaWrite` = 20/min.
    const limite = 20
    for (let i = 0; i < limite; i++) {
      const ok = await previewTemplate(postRequest('/preview', { templateId: 'tpl-1' }))
      expect(ok.status).toBe(200)
    }

    const res = await previewTemplate(postRequest('/preview', { templateId: 'tpl-1' }))

    expect(res.status).toBe(429)
    // O 429 tem de vir ANTES da leitura: senão o "limite" ainda paga o round
    // trip no banco a cada chamada recusada.
    expect(supabaseUser.from).toHaveBeenCalledTimes(limite)
  })

  it.each(['corpo', 'cabecalho'] as const)(
    'recusa mais de TEMPLATE_MAX_VALORES itens em valores.%s (422)',
    async (onde) => {
      const supabaseUser = previewComTemplateVisivel()
      const demais = Array.from({ length: 100 }, (_, i) => `v${i}`)

      const res = await previewTemplate(
        postRequest('/preview', { templateId: 'tpl-1', valores: { [onde]: demais } }),
      )
      const json = await res.json()

      expect(res.status).toBe(422)
      expect(json.error).toBe('valores_demais')
      expect(json).toMatchObject({ onde, limite: TEMPLATE_MAX_VALORES, recebidos: 100 })
      // Recusa antes de ir ao banco.
      expect(supabaseUser.from).not.toHaveBeenCalled()
    },
  )

  it('recusa um valor acima de TEMPLATE_MAX_TAMANHO_VALOR (422)', async () => {
    previewComTemplateVisivel()

    const res = await previewTemplate(
      postRequest('/preview', {
        templateId: 'tpl-1',
        valores: { corpo: ['ok', 'x'.repeat(5000)] },
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(422)
    expect(json.error).toBe('valor_muito_longo')
    // 422 em vez de truncar em silêncio: um preview que mostra 1024 chars de um
    // valor de 5000 mente sobre o que seria enviado.
    expect(json).toMatchObject({
      onde: 'corpo',
      indice: 2,
      limite: TEMPLATE_MAX_TAMANHO_VALOR,
      recebidos: 5000,
    })
  })

  it('recusa a cascata `{{2}}{{2}}` quando ela passa do teto de valores', async () => {
    previewComTemplateVisivel()
    // O payload clássico de expansão: cada valor referencia os índices
    // seguintes. Sem teto de entrada isso era 200 e virava trabalho de string.
    const cascata = Array.from({ length: 60 }, (_, i) => `{{${i + 2}}}{{${i + 2}}}`)

    const res = await previewTemplate(
      postRequest('/preview', { templateId: 'tpl-1', valores: { corpo: cascata } }),
    )
    const json = await res.json()

    expect(res.status).toBe(422)
    expect(json.error).toBe('valores_demais')
  })

  it('mantém a saída pequena para uma cascata DENTRO do teto', async () => {
    previewComTemplateVisivel()
    const cascata = Array.from(
      { length: TEMPLATE_MAX_VALORES },
      (_, i) => `{{${i + 2}}}{{${i + 2}}}`.repeat(50),
    )

    const res = await previewTemplate(
      postRequest('/preview', { templateId: 'tpl-1', valores: { corpo: cascata } }),
    )
    const json = await res.json()

    expect(res.status).toBe(200)
    // Passe único: só `{{1}}` e `{{2}}` do corpo são trocados, e o que entrou no
    // lugar deles não é revarrido. Saída ≈ tamanho do texto + 2 valores, não GB.
    expect(json.preview.corpo.length).toBeLessThan(4 * TEMPLATE_MAX_TAMANHO_VALOR)
  })
})

// ---------------------------------------------------------------------------
// POST /api/whatsapp-oficial/templates/enviar
// ---------------------------------------------------------------------------

const CONVERSA = {
  id: 'conv-1',
  tenant_id: 'sunt',
  canal_id: 'canal-1',
  lead_id: 'lead-1',
  status: 'aberta',
}

function makeEnviarAdmin(
  result: unknown,
  error: { message: string; code?: string } | null = null,
) {
  return {
    from: vi.fn(),
    rpc: vi.fn(() => Promise.resolve({ data: result, error })),
  }
}

function conversationContext(admin: unknown) {
  return { userId: 'corretor-1', conversation: CONVERSA, supabaseUser: { from: vi.fn() }, admin }
}

describe('POST /api/whatsapp-oficial/templates/enviar', () => {
  beforeEach(() => {
    __resetRateLimitForTests()
    mocks.requireConversationAccess.mockReset()
  })

  it('recusa quem não tem sessão (401)', async () => {
    mocks.requireConversationAccess.mockRejectedValue(new UnauthorizedError())

    const res = await enviarTemplate(
      postRequest('/enviar', { conversationId: 'conv-1', templateId: 'tpl-1' }),
    )

    expect(res.status).toBe(401)
  })

  it('não revela conversa escondida pela RLS (404)', async () => {
    mocks.requireConversationAccess.mockRejectedValue(new NotFoundError('Conversation not found'))

    const res = await enviarTemplate(
      postRequest('/enviar', { conversationId: 'conv-de-outro', templateId: 'tpl-1' }),
    )

    expect(res.status).toBe(404)
  })

  it('enfileira e deixa explícito que NÃO enviou', async () => {
    const admin = makeEnviarAdmin({
      ok: true,
      message_id: 'msg-1',
      template_id: 'tpl-1',
      preview: { cabecalho: null, corpo: 'Olá Ana!', rodape: null, botoes: [] },
    })
    mocks.requireConversationAccess.mockResolvedValue(conversationContext(admin))

    const res = await enviarTemplate(
      postRequest('/enviar', {
        conversationId: 'conv-1',
        templateId: 'tpl-1',
        variaveis: { body: ['Ana'] },
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json).toMatchObject({ ok: true, enfileirado: true, messageId: 'msg-1' })
    // A mensagem só existe na outbox: dizer "enviado" aqui faria o corretor
    // acreditar que o cliente já recebeu.
    expect(JSON.stringify(json)).not.toContain('enviado')
    expect(admin.rpc).toHaveBeenCalledWith('whatsapp_oficial_enfileirar_template', {
      p_conversation_id: 'conv-1',
      p_template_id: 'tpl-1',
      p_variaveis: { body: ['Ana'] },
      p_actor_user_id: 'corretor-1',
    })
  })

  it('manda `{}` quando o chamador não passa variáveis', async () => {
    const admin = makeEnviarAdmin({ ok: true, message_id: 'msg-1' })
    mocks.requireConversationAccess.mockResolvedValue(conversationContext(admin))

    await enviarTemplate(
      postRequest('/enviar', { conversationId: 'conv-1', templateId: 'tpl-1' }),
    )

    expect(admin.rpc).toHaveBeenCalledWith(
      'whatsapp_oficial_enfileirar_template',
      expect.objectContaining({ p_variaveis: {} }),
    )
  })

  it('corta em 429 quando estoura o orçamento de envio', async () => {
    const admin = makeEnviarAdmin({ ok: true, message_id: 'msg-1' })
    mocks.requireConversationAccess.mockResolvedValue(conversationContext(admin))

    for (let i = 0; i < 60; i++) {
      const ok = await enviarTemplate(
        postRequest('/enviar', { conversationId: 'conv-1', templateId: 'tpl-1' }),
      )
      expect(ok.status).toBe(201)
    }

    const res = await enviarTemplate(
      postRequest('/enviar', { conversationId: 'conv-1', templateId: 'tpl-1' }),
    )

    expect(res.status).toBe(429)
  })

  it.each([
    ['lead_optout_ou_inativo', 409],
    ['canal_inativo', 409],
    ['conversa_encerrada', 409],
    ['template_nao_aprovado', 409],
    ['template_de_outro_canal', 409],
    ['provider_sem_template', 409],
    ['variaveis_insuficientes', 422],
    ['template_nao_encontrado', 422],
    ['parametros_invalidos', 422],
    ['conversa_nao_encontrada', 404],
  ])('mapeia a recusa %s para HTTP %i', async (reason, status) => {
    const admin = makeEnviarAdmin({ ok: false, reason })
    mocks.requireConversationAccess.mockResolvedValue(conversationContext(admin))

    const res = await enviarTemplate(
      postRequest('/enviar', { conversationId: 'conv-1', templateId: 'tpl-1' }),
    )
    const json = await res.json()

    expect(res.status).toBe(status)
    expect(json.error).toBe(reason)
  })

  it('repassa exigidas/fornecidas de `variaveis_insuficientes`', async () => {
    const admin = makeEnviarAdmin({
      ok: false,
      reason: 'variaveis_insuficientes',
      exigidas: 2,
      fornecidas: 1,
    })
    mocks.requireConversationAccess.mockResolvedValue(conversationContext(admin))

    const res = await enviarTemplate(
      postRequest('/enviar', {
        conversationId: 'conv-1',
        templateId: 'tpl-1',
        variaveis: { body: ['Ana'] },
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(422)
    expect(json).toMatchObject({ error: 'variaveis_insuficientes', exigidas: 2, fornecidas: 1 })
  })

  it('falha fechado quando a RPC de enfileiramento quebra', async () => {
    const admin = makeEnviarAdmin(null, { message: 'db down' })
    mocks.requireConversationAccess.mockResolvedValue(conversationContext(admin))

    const res = await enviarTemplate(
      postRequest('/enviar', { conversationId: 'conv-1', templateId: 'tpl-1' }),
    )

    expect(res.status).toBe(500)
  })

  it('vira 403 quando a RPC devolve 42501 (papel que a RLS deixou passar)', async () => {
    // `lider` passa em `requireConversationAccess` — a policy de
    // `whatsapp_conversations` usa `crm_is_gestao()`, que o inclui — e só é
    // recusado pela RPC. Um 500 aqui esconderia uma questão de permissão atrás
    // de "erro do servidor".
    const admin = makeEnviarAdmin(null, { message: 'sem_permissao', code: '42501' })
    mocks.requireConversationAccess.mockResolvedValue(conversationContext(admin))

    const res = await enviarTemplate(
      postRequest('/enviar', { conversationId: 'conv-1', templateId: 'tpl-1' }),
    )

    expect(res.status).toBe(403)
  })

  it('recusa mais de TEMPLATE_MAX_VALORES em `variaveis.body` (422)', async () => {
    // A RPC só confere a contagem MÍNIMA ("faltou valor"), nunca a máxima, e o
    // render dela roda dentro da transação no banco do CRM. Sem este teto, uma
    // cascata de 60 valores sai da conversa de um corretor e vira custo do
    // Postgres compartilhado.
    const admin = makeEnviarAdmin({ ok: true, message_id: 'msg-1' })
    mocks.requireConversationAccess.mockResolvedValue(conversationContext(admin))
    const cascata = Array.from({ length: 60 }, (_, i) => `{{${i + 2}}}{{${i + 2}}}`)

    const res = await enviarTemplate(
      postRequest('/enviar', {
        conversationId: 'conv-1',
        templateId: 'tpl-1',
        variaveis: { body: cascata },
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(422)
    expect(json).toMatchObject({
      error: 'valores_demais',
      onde: 'body',
      limite: TEMPLATE_MAX_VALORES,
      recebidos: 60,
    })
    // Nada chegou ao banco.
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('recusa um valor de `variaveis` acima do teto de tamanho (422)', async () => {
    const admin = makeEnviarAdmin({ ok: true, message_id: 'msg-1' })
    mocks.requireConversationAccess.mockResolvedValue(conversationContext(admin))

    for (const [variaveis, onde] of [
      [{ body: ['x'.repeat(5000)] }, 'body'],
      [{ headerText: 'y'.repeat(5000) }, 'headerText'],
    ] as const) {
      const res = await enviarTemplate(
        postRequest('/enviar', { conversationId: 'conv-1', templateId: 'tpl-1', variaveis }),
      )
      const json = await res.json()

      expect(res.status).toBe(422)
      expect(json).toMatchObject({
        error: 'valor_muito_longo',
        onde,
        limite: TEMPLATE_MAX_TAMANHO_VALOR,
        recebidos: 5000,
      })
    }
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('exige templateId (400) antes de autorizar', async () => {
    const res = await enviarTemplate(postRequest('/enviar', { conversationId: 'conv-1' }))

    expect(res.status).toBe(400)
    expect(mocks.requireConversationAccess).not.toHaveBeenCalled()
  })
})
