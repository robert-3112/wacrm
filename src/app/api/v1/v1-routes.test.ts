/**
 * Testes das rotas `/api/v1`.
 *
 * A fixture abaixo NÃO é um mock que só registra chamadas — é um mini-PostgREST em memória que
 * aplica de verdade os `.eq()`, a ordenação e o filtro de keyset. A diferença importa: um mock
 * de chamadas provaria que a rota "chamou eq('tenant_id', X)", o que continuaria passando se o
 * filtro fosse aplicado na coluna errada ou depois de um `or()` que o anula. Aqui, se o
 * isolamento entre tenants estiver furado, a linha do outro tenant aparece no corpo da
 * resposta e o teste quebra — que é o único jeito honesto de testar isso sem banco.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

// ─────────────────────────────────────────────────────────────────────────────
// Banco de mentira
// ─────────────────────────────────────────────────────────────────────────────

interface Linha {
  id: string
  created_at: string
  [k: string]: unknown
}

const db: Record<string, Linha[]> = {
  whatsapp_conversations: [],
  whatsapp_messages: [],
  leads: [],
}

/** Todo `.eq()` que as rotas pediram, para provar filtro que o fake não sabe emular. */
const eqPedidos: Array<{ tabela: string; coluna: string; valor: unknown }> = []

/** `created_at.lt.<ts>,and(created_at.eq.<ts>,id.lt.<uuid>)` — o que `keysetFilter` produz. */
function aplicaKeyset(linhas: Linha[], expressao: string): Linha[] {
  const m = /^created_at\.lt\.(.+?),and\(created_at\.eq\.(.+?),id\.lt\.(.+?)\)$/.exec(expressao)
  if (!m) throw new Error(`expressao de keyset inesperada: ${expressao}`)
  const [, ts, tsIgual, id] = m
  return linhas.filter(
    (l) => l.created_at < ts || (l.created_at === tsIgual && String(l.id) < id),
  )
}

class FakeQuery implements PromiseLike<{ data: Linha[] | null; error: { message: string } | null }> {
  private linhas: Linha[]
  private limite: number | null = null
  private readonly inner: boolean

  constructor(
    private readonly tabela: string,
    select: string,
  ) {
    this.linhas = [...(db[tabela] ?? [])]
    this.inner = select.includes('!inner')
  }

  eq(coluna: string, valor: unknown) {
    eqPedidos.push({ tabela: this.tabela, coluna, valor })
    if (coluna.includes('.')) {
      // Filtro de RECURSO EMBEDADO (`lead.tenant_id`). O fake registra e NÃO aplica, de
      // propósito: se emulasse, o teste de vazamento entre tenants passaria por causa do fake e
      // a guarda do serializador — a única camada que sobrevive a uma mudança de comportamento
      // do PostgREST — ficaria sem prova nenhuma. Que o filtro foi PEDIDO ao banco é provado
      // separadamente, por `eqPedidos`.
      return this
    }
    this.linhas = this.linhas.filter((l) => l[coluna] === valor)
    return this
  }

  or(expressao: string) {
    this.linhas = aplicaKeyset(this.linhas, expressao)
    return this
  }

  order(coluna: string, opts: { ascending: boolean }) {
    // Ordenação estável em cascata, igual ao `.order().order()` do PostgREST.
    this.linhas = [...this.linhas].sort((a, b) => {
      const x = String(a[coluna] ?? '')
      const y = String(b[coluna] ?? '')
      if (x === y) return 0
      return (x < y ? -1 : 1) * (opts.ascending ? 1 : -1)
    })
    return this
  }

  limit(n: number) {
    this.limite = n
    return this
  }

  async maybeSingle() {
    return { data: this.materializa()[0] ?? null, error: null }
  }

  private materializa(): Linha[] {
    let out = this.linhas

    if (this.tabela === 'whatsapp_conversations') {
      out = out.map((c) => ({
        ...c,
        lead: db.leads.find((l) => l.id === c.lead_id) ?? null,
      }))
    }
    if (this.tabela === 'leads' && this.inner) {
      // `!inner` = descarta lead sem conversa.
      out = out.filter((l) =>
        db.whatsapp_conversations.some((c) => c.lead_id === l.id),
      )
    }
    return this.limite === null ? out : out.slice(0, this.limite)
  }

  then<R1 = { data: Linha[] | null; error: null }, R2 = never>(
    resolve?: ((v: { data: Linha[] | null; error: null }) => R1 | PromiseLike<R1>) | null,
    reject?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve({ data: this.materializa(), error: null }).then(resolve, reject)
  }
}

const rpc = vi.fn()

vi.mock('@/lib/whatsapp-oficial/supabase-admin', () => ({
  supabaseAdmin: () => ({
    from: (tabela: string) => ({ select: (cols: string) => new FakeQuery(tabela, cols) }),
    rpc: (...args: unknown[]) => rpc(...args),
  }),
}))

import { GET as getHealth } from './health/route'
import { GET as getConversations } from './conversations/route'
import { GET as getMessages } from './conversations/[id]/messages/route'
import { POST as postMessage } from './messages/route'
import { GET as getContacts } from './contacts/route'

// ─────────────────────────────────────────────────────────────────────────────
// Chaves e semeadura
// ─────────────────────────────────────────────────────────────────────────────

const CHAVE_A = `wa_live_${'a'.repeat(48)}`
const CHAVE_B = `wa_live_${'b'.repeat(48)}`

const TODOS_ESCOPOS = [
  'messages:read',
  'messages:send',
  'conversations:read',
  'contacts:read',
]

const chaves: Record<string, { apiKeyId: string; tenant: string; escopos: string[] }> = {}

function registraChave(
  chave: string,
  apiKeyId: string,
  tenant: string,
  escopos: string[] = TODOS_ESCOPOS,
) {
  chaves[chave] = { apiKeyId, tenant, escopos }
}

/** Substitui a RPC de autenticação pelo comportamento real dela (provado no PGlite). */
function autenticacaoPadrao() {
  rpc.mockImplementation(async (nome: string, args: Record<string, unknown>) => {
    if (nome === 'whatsapp_oficial_autenticar_api_key') {
      const k = chaves[args.p_chave as string]
      if (!k) return { data: { ok: false, reason: 'chave_invalida' }, error: null }
      return {
        data: {
          ok: true,
          api_key_id: k.apiKeyId,
          tenant_id: k.tenant,
          escopos: k.escopos,
        },
        error: null,
      }
    }
    if (nome === 'whatsapp_oficial_enfileirar_mensagem_api') {
      const dona = Object.values(chaves).find((k) => k.apiKeyId === args.p_api_key_id)
      const conversa = db.whatsapp_conversations.find((c) => c.id === args.p_conversation_id)
      // Espelha a checagem que a RPC faz: conversa de outro tenant é indistinguível de
      // inexistente.
      if (!conversa || !dona || conversa.tenant_id !== dona.tenant) {
        return { data: { ok: false, reason: 'conversa_nao_encontrada' }, error: null }
      }
      if (conversa.optout_em) {
        return { data: { ok: false, reason: 'lead_optout_ou_inativo' }, error: null }
      }
      return {
        data: {
          ok: true,
          message: {
            id: 'msg-nova',
            conversation_id: conversa.id,
            direction: 'outbound',
            message_type: 'text',
            content: args.p_content,
            status: 'pendente',
            created_at: '2026-07-26T12:00:00.000Z',
          },
        },
        error: null,
      }
    }
    throw new Error(`RPC inesperada: ${nome}`)
  })
}

function req(url: string, chave?: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (chave) headers.set('authorization', `Bearer ${chave}`)
  return new Request(`http://localhost${url}`, { ...init, headers })
}

function corpo(res: Response) {
  return res.json() as Promise<Record<string, unknown>>
}

function uuid(n: number, prefixo = '1') {
  return `${prefixo.repeat(8)}-0000-4000-8000-${String(n).padStart(12, '0')}`
}

function semeia() {
  db.whatsapp_conversations = []
  db.whatsapp_messages = []
  db.leads = []

  // Tenant A: 1 lead com conversa + 1 lead sem conversa nenhuma.
  db.leads.push(
    { id: uuid(1), created_at: '2026-07-01T00:00:00.000Z', tenant_id: 'sunt', nome: 'Ana', whatsapp: '5511900000001' },
    { id: uuid(2), created_at: '2026-07-02T00:00:00.000Z', tenant_id: 'sunt', nome: 'Sem Conversa', whatsapp: '5511900000002' },
  )
  db.whatsapp_conversations.push({
    id: uuid(10),
    created_at: '2026-07-10T00:00:00.000Z',
    tenant_id: 'sunt',
    canal_id: uuid(90),
    lead_id: uuid(1),
    status: 'aberta',
    optout_em: null,
    ultima_mensagem_em: '2026-07-10T01:00:00.000Z',
    ultima_mensagem_preview: 'oi',
  })
  db.whatsapp_messages.push({
    id: uuid(100),
    created_at: '2026-07-10T01:00:00.000Z',
    tenant_id: 'sunt',
    conversation_id: uuid(10),
    direction: 'inbound',
    message_type: 'text',
    content: 'mensagem do tenant A',
    status: 'recebida',
  })

  // Tenant B: lead, conversa e mensagem que o tenant A jamais pode ver.
  db.leads.push({
    id: uuid(1, '2'),
    created_at: '2026-07-03T00:00:00.000Z',
    tenant_id: 'outra-imobiliaria',
    nome: 'SEGREDO DO VIZINHO',
    whatsapp: '5511911111111',
  })
  db.whatsapp_conversations.push({
    id: uuid(11, '2'),
    created_at: '2026-07-11T00:00:00.000Z',
    tenant_id: 'outra-imobiliaria',
    canal_id: uuid(91, '2'),
    lead_id: uuid(1, '2'),
    status: 'aberta',
    optout_em: null,
    ultima_mensagem_preview: 'CONFIDENCIAL',
  })
  db.whatsapp_messages.push({
    id: uuid(101, '2'),
    created_at: '2026-07-11T01:00:00.000Z',
    tenant_id: 'outra-imobiliaria',
    conversation_id: uuid(11, '2'),
    direction: 'inbound',
    message_type: 'text',
    content: 'CONFIDENCIAL DO VIZINHO',
    status: 'recebida',
  })
}

beforeEach(() => {
  rpc.mockReset()
  __resetRateLimitForTests()
  eqPedidos.length = 0
  for (const k of Object.keys(chaves)) delete chaves[k]
  registraChave(CHAVE_A, 'key-a', 'sunt')
  registraChave(CHAVE_B, 'key-b', 'outra-imobiliaria')
  semeia()
  autenticacaoPadrao()
})

// ─────────────────────────────────────────────────────────────────────────────
// Autenticação, uniforme em todas as rotas
// ─────────────────────────────────────────────────────────────────────────────

describe('401 — todas as rotas, todos os casos, o mesmo corpo', () => {
  const rotas: Array<[string, (r: Request) => Promise<Response>]> = [
    ['health', (r) => getHealth(r)],
    ['conversations', (r) => getConversations(r)],
    ['contacts', (r) => getContacts(r)],
    ['messages (POST)', (r) => postMessage(r)],
    [
      'conversations/{id}/messages',
      (r) => getMessages(r, { params: Promise.resolve({ id: uuid(10) }) }),
    ],
  ]

  const casos: Array<[string, string | undefined]> = [
    ['sem header', undefined],
    ['chave inexistente', `wa_live_${'f'.repeat(48)}`],
  ]

  for (const [nomeRota, handler] of rotas) {
    for (const [nomeCaso, chave] of casos) {
      it(`${nomeRota}: 401 ${nomeCaso}`, async () => {
        const res = await handler(req('/api/v1/x', chave, { method: 'POST', body: '{}' }))
        expect(res.status).toBe(401)
        expect(await corpo(res)).toEqual({
          error: 'unauthorized',
          message: 'Missing or invalid API key',
        })
      })
    }
  }

  it('revogada e expirada respondem exatamente como inexistente', async () => {
    const respostas: string[] = []
    for (const reason of ['chave_invalida', 'chave_revogada', 'chave_expirada']) {
      rpc.mockResolvedValueOnce({ data: { ok: false, reason }, error: null })
      const res = await getConversations(req('/api/v1/conversations', CHAVE_A))
      respostas.push(`${res.status}:${JSON.stringify(await corpo(res))}`)
    }
    expect(new Set(respostas).size).toBe(1)
    expect(respostas[0]).toContain('401')
  })

  it('header malformado nao chega a consultar o banco', async () => {
    const res = await getConversations(
      new Request('http://localhost/api/v1/conversations', {
        headers: { authorization: 'Bearer nao-e-uma-chave' },
      }),
    )
    expect(res.status).toBe(401)
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('403 — escopo ausente', () => {
  it('conversations exige conversations:read', async () => {
    registraChave(CHAVE_A, 'key-a', 'sunt', ['messages:read'])
    const res = await getConversations(req('/api/v1/conversations', CHAVE_A))
    expect(res.status).toBe(403)
    expect(await corpo(res)).toMatchObject({
      error: 'insufficient_scope',
      required: 'conversations:read',
    })
  })

  it('POST /messages exige messages:send', async () => {
    registraChave(CHAVE_A, 'key-a', 'sunt', ['messages:read', 'conversations:read'])
    const res = await postMessage(
      req('/api/v1/messages', CHAVE_A, {
        method: 'POST',
        body: JSON.stringify({ conversationId: uuid(10), content: 'oi' }),
      }),
    )
    expect(res.status).toBe(403)
    expect(await corpo(res)).toMatchObject({ required: 'messages:send' })
    // Sem escopo, nem chega a tentar enfileirar.
    expect(rpc).not.toHaveBeenCalledWith(
      'whatsapp_oficial_enfileirar_mensagem_api',
      expect.anything(),
    )
  })

  it('contacts exige contacts:read', async () => {
    registraChave(CHAVE_A, 'key-a', 'sunt', ['conversations:read'])
    const res = await getContacts(req('/api/v1/contacts', CHAVE_A))
    expect(res.status).toBe(403)
    expect(await corpo(res)).toMatchObject({ required: 'contacts:read' })
  })

  it('health nao exige escopo: chave sem escopo nenhum passa', async () => {
    registraChave(CHAVE_A, 'key-a', 'sunt', [])
    const res = await getHealth(req('/api/v1/health', CHAVE_A))
    expect(res.status).toBe(200)
    expect(await corpo(res)).toEqual({ data: { ok: true, tenant: 'sunt', escopos: [] } })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// O teste que mais importa
// ─────────────────────────────────────────────────────────────────────────────

describe('ISOLAMENTO ENTRE TENANTS', () => {
  it('conversations: a chave de A nao lista a conversa de B', async () => {
    const res = await getConversations(req('/api/v1/conversations', CHAVE_A))
    expect(res.status).toBe(200)
    const body = await corpo(res)
    const linhas = body.data as Array<Record<string, unknown>>
    expect(linhas).toHaveLength(1)
    expect(linhas[0].id).toBe(uuid(10))
    // Prova pelo conteúdo, não pela contagem: nada do vizinho pode aparecer em lugar nenhum.
    expect(JSON.stringify(body)).not.toContain('CONFIDENCIAL')
    expect(JSON.stringify(body)).not.toContain('SEGREDO DO VIZINHO')
  })

  it('conversations: a chave de B ve a dela, e so a dela', async () => {
    const res = await getConversations(req('/api/v1/conversations', CHAVE_B))
    const linhas = (await corpo(res)).data as Array<Record<string, unknown>>
    expect(linhas).toHaveLength(1)
    expect(linhas[0].id).toBe(uuid(11, '2'))
  })

  it('conversations: filtrar por lead_id do vizinho devolve vazio, nao o lead do vizinho', async () => {
    const res = await getConversations(
      req(`/api/v1/conversations?lead_id=${uuid(1, '2')}`, CHAVE_A),
    )
    expect(res.status).toBe(200)
    expect((await corpo(res)).data).toEqual([])
  })

  it('messages: conversa do vizinho da 404, igualzinho a um id inexistente', async () => {
    const doVizinho = await getMessages(req('/api/v1/x', CHAVE_A), {
      params: Promise.resolve({ id: uuid(11, '2') }),
    })
    const inexistente = await getMessages(req('/api/v1/x', CHAVE_A), {
      params: Promise.resolve({ id: uuid(999) }),
    })

    expect(doVizinho.status).toBe(404)
    expect(inexistente.status).toBe(404)
    expect(await corpo(doVizinho)).toEqual(await corpo(inexistente))
  })

  it('messages: traz SO as mensagens da conversa pedida, nao as do tenant inteiro', async () => {
    // Sem uma segunda conversa no MESMO tenant este teste não existe de verdade: com uma
    // conversa só, esquecer o filtro por conversation_id devolve o mesmo resultado certo.
    db.leads.push({
      id: uuid(3),
      created_at: '2026-07-04T00:00:00.000Z',
      tenant_id: 'sunt',
      nome: 'Bruno',
    })
    db.whatsapp_conversations.push({
      id: uuid(12),
      created_at: '2026-07-12T00:00:00.000Z',
      tenant_id: 'sunt',
      canal_id: uuid(90),
      lead_id: uuid(3),
      status: 'aberta',
      optout_em: null,
    })
    db.whatsapp_messages.push({
      id: uuid(102),
      created_at: '2026-07-12T01:00:00.000Z',
      tenant_id: 'sunt',
      conversation_id: uuid(12),
      direction: 'inbound',
      message_type: 'text',
      content: 'DE OUTRA CONVERSA DO MESMO TENANT',
      status: 'recebida',
    })

    const res = await getMessages(req('/api/v1/x', CHAVE_A), {
      params: Promise.resolve({ id: uuid(10) }),
    })
    const body = await corpo(res)
    const linhas = body.data as Array<Record<string, unknown>>
    expect(linhas.map((l) => l.id)).toEqual([uuid(100)])
    expect(JSON.stringify(body)).not.toContain('DE OUTRA CONVERSA')
  })

  it('messages: a chave de A so ve as mensagens dela', async () => {
    const res = await getMessages(req('/api/v1/x', CHAVE_A), {
      params: Promise.resolve({ id: uuid(10) }),
    })
    expect(res.status).toBe(200)
    const body = await corpo(res)
    expect((body.data as unknown[]).length).toBe(1)
    expect(JSON.stringify(body)).not.toContain('CONFIDENCIAL')
  })

  it('contacts: a chave de A nao ve o contato de B', async () => {
    const res = await getContacts(req('/api/v1/contacts', CHAVE_A))
    const body = await corpo(res)
    const linhas = body.data as Array<Record<string, unknown>>
    expect(linhas.map((l) => l.nome)).toEqual(['Ana'])
    expect(JSON.stringify(body)).not.toContain('SEGREDO DO VIZINHO')
  })

  it('POST /messages: a chave de A nao enfileira na conversa de B', async () => {
    const res = await postMessage(
      req('/api/v1/messages', CHAVE_A, {
        method: 'POST',
        body: JSON.stringify({ conversationId: uuid(11, '2'), content: 'oi vizinho' }),
      }),
    )
    expect(res.status).toBe(404)

    const inexistente = await postMessage(
      req('/api/v1/messages', CHAVE_A, {
        method: 'POST',
        body: JSON.stringify({ conversationId: uuid(999), content: 'oi' }),
      }),
    )
    expect(await corpo(res)).toEqual(await corpo(inexistente))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// O escopo tem que valer no CORPO, não só no 403
// ─────────────────────────────────────────────────────────────────────────────

describe('conversations — o escopo gateia o que sai no corpo', () => {
  /** Lê a única conversa do tenant A com a chave A configurada com `escopos`. */
  async function conversaCom(escopos: string[]) {
    registraChave(CHAVE_A, 'key-a', 'sunt', escopos)
    const res = await getConversations(req('/api/v1/conversations', CHAVE_A))
    expect(res.status).toBe(200)
    const linhas = (await corpo(res)).data as Array<Record<string, unknown>>
    return linhas[0]
  }

  it('so conversations:read: sem preview e sem telefone', async () => {
    const linha = await conversaCom(['conversations:read'])

    // O preview é `left(conteudo, 200)` de TODA mensagem: entregá-lo aqui deixaria uma chave de
    // "só ver a lista" reconstruir as conversas por polling, enquanto
    // GET /conversations/{id}/messages responde 403 para a mesma chave.
    expect(linha).not.toHaveProperty('last_message_preview')
    // Omitido, não mascarado: `null` faria o integrador confundir "não pode ver" com "não tem".
    expect(Object.keys(linha)).not.toContain('last_message_preview')
    // Telefone completo é o que /contacts cobra `contacts:read` para entregar.
    expect(linha.contact).toEqual({ id: uuid(1), nome: 'Ana' })
    expect(JSON.stringify(linha)).not.toContain('5511900000001')

    // Metadado de conversa continua: é ele que diz que vale a pena buscar as mensagens.
    expect(linha.last_message_at).toBe('2026-07-10T01:00:00.000Z')
  })

  it('com messages:read + contacts:read: recebe tudo', async () => {
    const linha = await conversaCom(['conversations:read', 'messages:read', 'contacts:read'])
    expect(linha.last_message_preview).toBe('oi')
    expect(linha.contact).toEqual({ id: uuid(1), nome: 'Ana', whatsapp: '5511900000001' })
  })

  it('os dois escopos sao independentes — um nao carrega o outro', async () => {
    const soMensagens = await conversaCom(['conversations:read', 'messages:read'])
    expect(soMensagens.last_message_preview).toBe('oi')
    expect(soMensagens.contact).not.toHaveProperty('whatsapp')

    const soContatos = await conversaCom(['conversations:read', 'contacts:read'])
    expect(soContatos).not.toHaveProperty('last_message_preview')
    expect(soContatos.contact).toHaveProperty('whatsapp', '5511900000001')
  })

  it('a MESMA conversa com escopos diferentes produz corpos diferentes', async () => {
    const magra = await conversaCom(['conversations:read'])
    const cheia = await conversaCom(['conversations:read', 'messages:read', 'contacts:read'])

    expect(magra.id).toBe(cheia.id)
    expect(JSON.stringify(magra)).not.toEqual(JSON.stringify(cheia))
    // E a diferença é exatamente o que os outros escopos protegem.
    expect(JSON.stringify(cheia)).toContain('5511900000001')
    expect(JSON.stringify(magra)).not.toContain('5511900000001')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Embed de lead: a FK é simples, o tenant não vem de graça
// ─────────────────────────────────────────────────────────────────────────────

describe('conversations — tenant do lead embedado', () => {
  /** Conversa DO tenant A cujo `lead_id` aponta para o lead do tenant B. Não há FK composta
   *  nem CHECK impedindo essa linha de existir. */
  function semeiaLeadCruzado() {
    db.whatsapp_conversations.push({
      id: uuid(13),
      created_at: '2026-07-13T00:00:00.000Z',
      tenant_id: 'sunt',
      canal_id: uuid(90),
      lead_id: uuid(1, '2'),
      status: 'aberta',
      optout_em: null,
      ultima_mensagem_em: '2026-07-13T01:00:00.000Z',
      ultima_mensagem_preview: 'oi',
    })
  }

  it('pede o filtro de tenant TAMBEM no recurso embedado, nao so na tabela base', async () => {
    await getConversations(req('/api/v1/conversations', CHAVE_A))
    expect(eqPedidos).toContainEqual({
      tabela: 'whatsapp_conversations',
      coluna: 'tenant_id',
      valor: 'sunt',
    })
    expect(eqPedidos).toContainEqual({
      tabela: 'whatsapp_conversations',
      coluna: 'lead.tenant_id',
      valor: 'sunt',
    })
  })

  it('conversa de A apontando para lead de B nao vaza nome nem telefone', async () => {
    semeiaLeadCruzado()
    const erros = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await getConversations(req('/api/v1/conversations', CHAVE_A))
    const body = await corpo(res)
    const texto = JSON.stringify(body)

    expect(texto).not.toContain('SEGREDO DO VIZINHO')
    expect(texto).not.toContain('5511911111111')

    const linhas = body.data as Array<Record<string, unknown>>
    const cruzada = linhas.find((l) => l.id === uuid(13))
    // A CONVERSA é do tenant A e continua listada — quem some é só o contato divergente.
    expect(cruzada).toBeDefined()
    expect(cruzada?.contact).toBeNull()
    // E a conversa sadia do mesmo tenant não foi junto no laço.
    expect(linhas.find((l) => l.id === uuid(10))?.contact).toMatchObject({ nome: 'Ana' })

    // Divergência é problema de integridade: registra, mas sem PII no log.
    expect(erros).toHaveBeenCalled()
    const logado = erros.mock.calls.flat().join(' ')
    expect(logado).not.toContain('SEGREDO DO VIZINHO')
    expect(logado).not.toContain('5511911111111')
    erros.mockRestore()
  })

  it('nem com contacts:read o contato de outro tenant aparece', async () => {
    semeiaLeadCruzado()
    const erros = vi.spyOn(console, 'error').mockImplementation(() => {})
    registraChave(CHAVE_A, 'key-a', 'sunt', TODOS_ESCOPOS)

    const res = await getConversations(req('/api/v1/conversations', CHAVE_A))
    const linhas = (await corpo(res)).data as Array<Record<string, unknown>>
    expect(linhas.find((l) => l.id === uuid(13))?.contact).toBeNull()
    erros.mockRestore()
  })

  it('lead sem tenant_id no embed cai fechado: contato omitido, conversa mantida', async () => {
    // Se alguém enxugar o SELECT e o `tenant_id` do lead sumir, a guarda não tem como PROVAR
    // que o lead é do mesmo tenant. O certo é perder o contato, não confiar.
    db.leads.push({ id: uuid(4), created_at: '2026-07-05T00:00:00.000Z', nome: 'Sem Tenant' })
    db.whatsapp_conversations.push({
      id: uuid(14),
      created_at: '2026-07-14T00:00:00.000Z',
      tenant_id: 'sunt',
      canal_id: uuid(90),
      lead_id: uuid(4),
      status: 'aberta',
      optout_em: null,
    })

    const res = await getConversations(req('/api/v1/conversations', CHAVE_A))
    const linhas = (await corpo(res)).data as Array<Record<string, unknown>>
    const semTenant = linhas.find((l) => l.id === uuid(14))
    expect(semTenant).toBeDefined()
    expect(semTenant?.contact).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Contrato de listagem e paginação
// ─────────────────────────────────────────────────────────────────────────────

describe('contacts', () => {
  it('so traz lead COM conversa no canal oficial', async () => {
    const res = await getContacts(req('/api/v1/contacts', CHAVE_A))
    const linhas = (await corpo(res)).data as Array<Record<string, unknown>>
    // O lead "Sem Conversa" existe no tenant, mas não é contato do canal.
    expect(linhas.map((l) => l.nome)).not.toContain('Sem Conversa')
  })
})

describe('conversations — filtros', () => {
  it('status invalido devolve 400 explicando os aceitos', async () => {
    const res = await getConversations(req('/api/v1/conversations?status=abert', CHAVE_A))
    expect(res.status).toBe(400)
    expect((await corpo(res)).message).toContain('aberta')
  })

  it('lead_id fora do formato uuid devolve 400', async () => {
    const res = await getConversations(req('/api/v1/conversations?lead_id=123', CHAVE_A))
    expect(res.status).toBe(400)
  })

  it('status valido filtra', async () => {
    const res = await getConversations(req('/api/v1/conversations?status=encerrada', CHAVE_A))
    expect((await corpo(res)).data).toEqual([])
  })

  it('embute o contato da conversa', async () => {
    const res = await getConversations(req('/api/v1/conversations', CHAVE_A))
    const linhas = (await corpo(res)).data as Array<Record<string, unknown>>
    expect(linhas[0].contact).toEqual({
      id: uuid(1),
      nome: 'Ana',
      whatsapp: '5511900000001',
    })
  })
})

describe('paginacao por cursor', () => {
  /** 5 conversas do tenant A, uma por dia. */
  function semeiaMuitas() {
    db.whatsapp_conversations = []
    db.leads = [{ id: uuid(1), created_at: '2026-07-01T00:00:00.000Z', tenant_id: 'sunt', nome: 'Ana' }]
    for (let i = 1; i <= 5; i += 1) {
      db.whatsapp_conversations.push({
        id: uuid(i),
        created_at: `2026-07-0${i}T00:00:00.000Z`,
        tenant_id: 'sunt',
        lead_id: uuid(1),
        canal_id: uuid(90),
        status: 'aberta',
        optout_em: null,
      })
    }
  }

  it('percorre a lista inteira sem repetir nem pular', async () => {
    semeiaMuitas()
    const vistos: string[] = []
    let cursor: string | null = null

    for (let pagina = 0; pagina < 10; pagina += 1) {
      const url = `/api/v1/conversations?limit=2${cursor ? `&cursor=${cursor}` : ''}`
      const res = await getConversations(req(url, CHAVE_A))
      const body = await corpo(res)
      const linhas = body.data as Array<Record<string, unknown>>
      vistos.push(...linhas.map((l) => String(l.id)))
      const pag = body.pagination as { next_cursor: string | null; has_more: boolean }
      if (!pag.has_more) {
        expect(pag.next_cursor).toBeNull()
        break
      }
      cursor = pag.next_cursor
    }

    expect(vistos).toHaveLength(5)
    expect(new Set(vistos).size).toBe(5)
    // Mais nova primeiro.
    expect(vistos[0]).toBe(uuid(5))
  })

  it('insert concorrente no meio da varredura nao faz a pagina 2 repetir nem pular', async () => {
    semeiaMuitas()

    const p1 = await getConversations(req('/api/v1/conversations?limit=2', CHAVE_A))
    const b1 = await corpo(p1)
    const ids1 = (b1.data as Array<Record<string, unknown>>).map((l) => String(l.id))
    const cursor = (b1.pagination as { next_cursor: string }).next_cursor

    // Chega uma conversa NOVA (mais recente que todas) entre uma página e outra — exatamente o
    // que o webhook faz o dia inteiro. Com offset, isso empurraria a janela e a página 2
    // repetiria a última linha da página 1.
    db.whatsapp_conversations.push({
      id: uuid(6),
      created_at: '2026-07-09T00:00:00.000Z',
      tenant_id: 'sunt',
      lead_id: uuid(1),
      canal_id: uuid(90),
      status: 'aberta',
      optout_em: null,
    })

    const p2 = await getConversations(
      req(`/api/v1/conversations?limit=2&cursor=${cursor}`, CHAVE_A),
    )
    const ids2 = ((await corpo(p2)).data as Array<Record<string, unknown>>).map((l) =>
      String(l.id),
    )

    expect(ids1).toEqual([uuid(5), uuid(4)])
    // Continua exatamente de onde parou: nada repetido, nada pulado.
    expect(ids2).toEqual([uuid(3), uuid(2)])
    expect(ids1.filter((id) => ids2.includes(id))).toEqual([])
  })

  it('cursor forjado e tratado como primeira pagina, nunca como filtro', async () => {
    semeiaMuitas()
    const res = await getConversations(
      req('/api/v1/conversations?limit=2&cursor=id.neq.null', CHAVE_A),
    )
    expect(res.status).toBe(200)
    const linhas = (await corpo(res)).data as Array<Record<string, unknown>>
    expect(linhas.map((l) => String(l.id))).toEqual([uuid(5), uuid(4)])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /messages
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/v1/messages', () => {
  function envia(body: unknown, chave = CHAVE_A) {
    return postMessage(
      req('/api/v1/messages', chave, { method: 'POST', body: JSON.stringify(body) }),
    )
  }

  it('responde enfileirado:true e NUNCA a palavra "enviado"', async () => {
    const res = await envia({ conversationId: uuid(10), content: 'Bom dia!' })
    expect(res.status).toBe(201)

    const body = await corpo(res)
    expect((body.data as Record<string, unknown>).enfileirado).toBe(true)

    const texto = JSON.stringify(body)
    expect(texto).not.toMatch(/enviad[ao]/i)
    expect(texto).not.toMatch(/\bsent\b/i)
    // O status da mensagem é o da fila, não o de entrega.
    expect((body.data as { message: { status: string } }).message.status).toBe('pendente')
  })

  it('passa o api_key_id como ator-maquina, nunca um usuario', async () => {
    await envia({ conversationId: uuid(10), content: 'oi' })
    expect(rpc).toHaveBeenCalledWith('whatsapp_oficial_enfileirar_mensagem_api', {
      p_conversation_id: uuid(10),
      p_content: 'oi',
      p_api_key_id: 'key-a',
    })
    // A RPC de ator humano não pode ser usada por uma chave de API.
    expect(rpc).not.toHaveBeenCalledWith(
      'whatsapp_oficial_enfileirar_mensagem',
      expect.anything(),
    )
  })

  it('trima o conteudo antes de enfileirar', async () => {
    await envia({ conversationId: uuid(10), content: '  oi  ' })
    expect(rpc).toHaveBeenCalledWith(
      'whatsapp_oficial_enfileirar_mensagem_api',
      expect.objectContaining({ p_content: 'oi' }),
    )
  })

  const ruins: Array<[string, unknown]> = [
    ['corpo vazio', {}],
    ['sem conteudo', { conversationId: uuid(10) }],
    ['conteudo so de espacos', { conversationId: uuid(10), content: '   ' }],
    ['sem conversationId', { content: 'oi' }],
    ['conversationId nao-uuid', { conversationId: 'abc', content: 'oi' }],
    ['conteudo gigante', { conversationId: uuid(10), content: 'x'.repeat(4097) }],
  ]
  for (const [rotulo, body] of ruins) {
    it(`400: ${rotulo}`, async () => {
      const res = await envia(body)
      expect(res.status).toBe(400)
      expect((await corpo(res)).error).toBe('bad_request')
      expect(rpc).not.toHaveBeenCalledWith(
        'whatsapp_oficial_enfileirar_mensagem_api',
        expect.anything(),
      )
    })
  }

  it('json invalido nao derruba a rota', async () => {
    const res = await postMessage(
      req('/api/v1/messages', CHAVE_A, { method: 'POST', body: 'nao e json' }),
    )
    expect(res.status).toBe(400)
  })

  it('opt-out vira 409, nao 500 nem sucesso silencioso', async () => {
    db.whatsapp_conversations[0].optout_em = '2026-07-20T00:00:00.000Z'
    const res = await envia({ conversationId: uuid(10), content: 'oi' })
    expect(res.status).toBe(409)
    expect((await corpo(res)).error).toBe('lead_optout_ou_inativo')
  })

  it('chave revogada entre autenticar e enfileirar vira 401, nao 500', async () => {
    rpc.mockImplementation(async (nome: string) => {
      if (nome === 'whatsapp_oficial_autenticar_api_key') {
        return {
          data: { ok: true, api_key_id: 'key-a', tenant_id: 'sunt', escopos: TODOS_ESCOPOS },
          error: null,
        }
      }
      return { data: null, error: { code: '42501', message: 'chave_revogada' } }
    })
    const res = await envia({ conversationId: uuid(10), content: 'oi' })
    expect(res.status).toBe(401)
    expect(JSON.stringify(await corpo(res))).not.toContain('chave_revogada')
  })

  it('falha inesperada da RPC vira 500 sem vazar texto interno', async () => {
    rpc.mockImplementation(async (nome: string) => {
      if (nome === 'whatsapp_oficial_autenticar_api_key') {
        return {
          data: { ok: true, api_key_id: 'key-a', tenant_id: 'sunt', escopos: TODOS_ESCOPOS },
          error: null,
        }
      }
      return { data: null, error: { message: 'deadlock detected on whatsapp_outbox' } }
    })
    const res = await envia({ conversationId: uuid(10), content: 'oi' })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await corpo(res))).not.toContain('deadlock')
  })
})

describe('health', () => {
  it('devolve ok, tenant e escopos para o integrador conferir a credencial', async () => {
    const res = await getHealth(req('/api/v1/health', CHAVE_A))
    expect(res.status).toBe(200)
    expect(await corpo(res)).toEqual({
      data: { ok: true, tenant: 'sunt', escopos: TODOS_ESCOPOS },
    })
  })

  it('cada chave enxerga o proprio tenant', async () => {
    const res = await getHealth(req('/api/v1/health', CHAVE_B))
    expect((await corpo(res)).data).toMatchObject({ tenant: 'outra-imobiliaria' })
  })
})
