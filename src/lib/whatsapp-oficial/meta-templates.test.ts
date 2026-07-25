/**
 * Testes de `./meta-templates.ts` — o catálogo de templates da Meta.
 *
 * Nenhuma chamada de rede: `fetchMetaTemplates` recebe `fetchImpl` injetado, e as demais
 * funções são puras. O foco é nas três divergências deliberadas em relação à rota legada do
 * WACRM (componentes verbatim, status traduzido sem destravar envio, versão da Graph API
 * compartilhada) e nos dois defeitos que elas corrigem — porque é exatamente isso que uma
 * refatoração futura tende a reintroduzir sem perceber.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  META_TEMPLATE_FIELDS,
  MetaTemplateFetchError,
  extractTemplateExamples,
  extractTemplateVariables,
  extractVariableIndices,
  fetchMetaTemplates,
  mapMetaCategoryToSunt,
  mapMetaStatusToSunt,
  normalizeQualityScore,
  renderTemplatePreview,
  renderTemplateText,
  toSuntTemplatePayload,
  validateTemplateValues,
  type MetaTemplateComponentRaw,
} from './meta-templates'

const API_BASE = 'https://graph.test/v24.0'

function jsonPage(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

/** Fetch injetável com o cast mínimo — o corpo do teste inspeciona `.mock.calls`. */
function makeFetch() {
  const fn = vi.fn()
  return { fn, impl: fn as unknown as typeof fetch }
}

function callUrls(fn: ReturnType<typeof vi.fn>): string[] {
  return fn.mock.calls.map((c) => c[0] as string)
}

function callAuthHeaders(fn: ReturnType<typeof vi.fn>): unknown[] {
  return fn.mock.calls.map(
    (c) => (c[1] as { headers?: Record<string, string> } | undefined)?.headers?.Authorization,
  )
}

// ---------------------------------------------------------------------------
// fetchMetaTemplates
// ---------------------------------------------------------------------------

describe('fetchMetaTemplates — paginação', () => {
  it('segue paging.next por várias páginas e acumula todos os templates', async () => {
    const { fn, impl } = makeFetch()
    fn.mockResolvedValueOnce(
      jsonPage({
        data: [{ name: 't1', language: 'pt_BR' }],
        paging: { next: `${API_BASE}/WABA/message_templates?after=CUR1` },
      }),
    )
    fn.mockResolvedValueOnce(
      jsonPage({
        data: [{ name: 't2', language: 'pt_BR' }],
        paging: { next: `${API_BASE}/WABA/message_templates?after=CUR2` },
      }),
    )
    fn.mockResolvedValueOnce(jsonPage({ data: [{ name: 't3', language: 'pt_BR' }] }))

    const result = await fetchMetaTemplates({
      wabaId: 'WABA',
      accessToken: 'tok',
      apiBase: API_BASE,
      fetchImpl: impl,
    })

    expect(result.pages).toBe(3)
    expect(result.truncated).toBe(false)
    expect(result.templates.map((t) => t.name)).toEqual(['t1', 't2', 't3'])

    const urls = callUrls(fn)
    expect(urls[0]).toContain(`${API_BASE}/WABA/message_templates?limit=100`)
    expect(urls[0]).toContain(`fields=${META_TEMPLATE_FIELDS}`)
    expect(urls[1]).toBe(`${API_BASE}/WABA/message_templates?after=CUR1`)
    expect(urls[2]).toBe(`${API_BASE}/WABA/message_templates?after=CUR2`)
  })

  it('reenvia o header Authorization em TODA página, inclusive nas vindas de paging.next', async () => {
    // Teste crítico: `paging.next` é uma URL ABSOLUTA da Meta, montada por ela. Se o token só
    // fosse para a primeira página, o sync funcionaria em catálogo pequeno (1 página) e falharia
    // com 401 a partir da segunda — ou seja, quebraria só em produção, no cliente grande.
    const { fn, impl } = makeFetch()
    fn.mockResolvedValueOnce(
      jsonPage({
        data: [{ name: 't1', language: 'pt_BR' }],
        paging: { next: 'https://graph.facebook.com/v24.0/WABA/message_templates?after=CUR1' },
      }),
    )
    fn.mockResolvedValueOnce(
      jsonPage({
        data: [{ name: 't2', language: 'pt_BR' }],
        paging: { next: 'https://graph.facebook.com/v24.0/WABA/message_templates?after=CUR2' },
      }),
    )
    fn.mockResolvedValueOnce(jsonPage({ data: [{ name: 't3', language: 'pt_BR' }] }))

    await fetchMetaTemplates({
      wabaId: 'WABA',
      accessToken: 'tok-secreto',
      apiBase: API_BASE,
      fetchImpl: impl,
    })

    expect(fn).toHaveBeenCalledTimes(3)
    expect(callAuthHeaders(fn)).toEqual([
      'Bearer tok-secreto',
      'Bearer tok-secreto',
      'Bearer tok-secreto',
    ])
  })

  it('para no pageCap e devolve truncated=true quando ainda havia próxima página', async () => {
    const { fn, impl } = makeFetch()
    fn.mockResolvedValue(
      jsonPage({
        data: [{ name: 't', language: 'pt_BR' }],
        paging: { next: `${API_BASE}/WABA/message_templates?after=SEMPRE_TEM_MAIS` },
      }),
    )

    const result = await fetchMetaTemplates({
      wabaId: 'WABA',
      accessToken: 'tok',
      apiBase: API_BASE,
      pageCap: 2,
      fetchImpl: impl,
    })

    expect(fn).toHaveBeenCalledTimes(2)
    expect(result.pages).toBe(2)
    expect(result.truncated).toBe(true)
    expect(result.templates).toHaveLength(2)
  })

  it('NÃO marca truncated quando o catálogo acaba exatamente no pageCap', async () => {
    // truncated é a bandeira que faz a RPC preservar templates ausentes em vez de tratá-los
    // como apagados na Meta. Marcá-la por engano deixa lixo no catálogo para sempre.
    const { fn, impl } = makeFetch()
    fn.mockResolvedValueOnce(
      jsonPage({
        data: [{ name: 't1', language: 'pt_BR' }],
        paging: { next: `${API_BASE}/WABA/message_templates?after=CUR1` },
      }),
    )
    fn.mockResolvedValueOnce(jsonPage({ data: [{ name: 't2', language: 'pt_BR' }] }))

    const result = await fetchMetaTemplates({
      wabaId: 'WABA',
      accessToken: 'tok',
      apiBase: API_BASE,
      pageCap: 2,
      fetchImpl: impl,
    })

    expect(result.pages).toBe(2)
    expect(result.truncated).toBe(false)
  })
})

describe('fetchMetaTemplates — erros', () => {
  it('lança MetaTemplateFetchError com a mensagem da Meta e o status HTTP preservados', async () => {
    const { fn, impl } = makeFetch()
    fn.mockResolvedValueOnce(
      jsonPage({ error: { message: 'Invalid OAuth access token.' } }, 401),
    )

    await expect(
      fetchMetaTemplates({
        wabaId: 'WABA',
        accessToken: 'tok',
        apiBase: API_BASE,
        fetchImpl: impl,
      }),
    ).rejects.toMatchObject({
      name: 'MetaTemplateFetchError',
      message: 'Invalid OAuth access token.',
      httpStatus: 401,
    })
  })

  it('cai no fallback quando o corpo do erro não é JSON', async () => {
    const { fn, impl } = makeFetch()
    fn.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('Unexpected token < in JSON')
      },
    } as unknown as Response)

    await expect(
      fetchMetaTemplates({
        wabaId: 'WABA',
        accessToken: 'tok',
        apiBase: API_BASE,
        fetchImpl: impl,
      }),
    ).rejects.toMatchObject({ message: 'Meta API error: 502', httpStatus: 502 })
  })

  it('não faz commit parcial: erro na 2ª página descarta também a 1ª', async () => {
    // Gravar metade do catálogo faria o operador acreditar que os templates ausentes foram
    // apagados na Meta. Por isso o erro aborta o sync inteiro, sem resultado parcial.
    const { fn, impl } = makeFetch()
    fn.mockResolvedValueOnce(
      jsonPage({
        data: [{ name: 'sobreviveria', language: 'pt_BR' }],
        paging: { next: `${API_BASE}/WABA/message_templates?after=CUR1` },
      }),
    )
    fn.mockResolvedValueOnce(jsonPage({ error: { message: 'rate limited' } }, 429))

    const promise = fetchMetaTemplates({
      wabaId: 'WABA',
      accessToken: 'tok',
      apiBase: API_BASE,
      fetchImpl: impl,
    })

    await expect(promise).rejects.toBeInstanceOf(MetaTemplateFetchError)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('exige wabaId e accessToken antes de tocar na rede', async () => {
    const { fn, impl } = makeFetch()

    await expect(
      fetchMetaTemplates({ wabaId: '', accessToken: 'tok', apiBase: API_BASE, fetchImpl: impl }),
    ).rejects.toMatchObject({ message: 'WABA id ausente', httpStatus: 400 })

    await expect(
      fetchMetaTemplates({ wabaId: 'WABA', accessToken: '', apiBase: API_BASE, fetchImpl: impl }),
    ).rejects.toMatchObject({ message: 'access token ausente', httpStatus: 400 })

    expect(fn).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Tradução Meta -> SUNT
// ---------------------------------------------------------------------------

describe('mapMetaStatusToSunt', () => {
  const casos: Array<[string, string]> = [
    ['APPROVED', 'aprovado'],
    ['REJECTED', 'rejeitado'],
    ['PAUSED', 'pausado'],
    ['DISABLED', 'desabilitado'],
    ['IN_APPEAL', 'em_apelacao'],
    ['PENDING_DELETION', 'exclusao_pendente'],
    ['DRAFT', 'rascunho'],
    ['PENDING', 'pendente'],
    ['PENDING_REVIEW', 'pendente'],
  ]

  it.each(casos)('traduz %s -> %s', (meta, sunt) => {
    expect(mapMetaStatusToSunt(meta)).toBe(sunt)
  })

  it('normaliza caixa e espaços', () => {
    expect(mapMetaStatusToSunt('  approved  ')).toBe('aprovado')
  })

  it('status desconhecido/ausente vira pendente e NUNCA aprovado', () => {
    // Um valor novo da Meta não pode destravar envio sozinho: o default é o estado que
    // bloqueia, não o que libera.
    for (const desconhecido of ['LIMIT_EXCEEDED', 'ALGO_NOVO_DA_META', '', undefined, null]) {
      expect(mapMetaStatusToSunt(desconhecido)).toBe('pendente')
      expect(mapMetaStatusToSunt(desconhecido)).not.toBe('aprovado')
    }
  })
})

describe('mapMetaCategoryToSunt', () => {
  it('aceita as três categorias e normaliza caixa', () => {
    expect(mapMetaCategoryToSunt('marketing')).toBe('MARKETING')
    expect(mapMetaCategoryToSunt(' UTILITY ')).toBe('UTILITY')
    expect(mapMetaCategoryToSunt('AUTHENTICATION')).toBe('AUTHENTICATION')
  })

  it('devolve null para categoria desconhecida ou ausente', () => {
    expect(mapMetaCategoryToSunt('OTP')).toBeNull()
    expect(mapMetaCategoryToSunt(undefined)).toBeNull()
    expect(mapMetaCategoryToSunt(null)).toBeNull()
  })
})

describe('normalizeQualityScore', () => {
  it('aceita as duas formas que a Meta manda (objeto e escalar)', () => {
    expect(normalizeQualityScore({ score: 'GREEN' })).toBe('GREEN')
    expect(normalizeQualityScore('yellow')).toBe('YELLOW')
    expect(normalizeQualityScore({ score: ' red ' })).toBe('RED')
  })

  it('devolve null para score desconhecido, vazio ou ausente', () => {
    expect(normalizeQualityScore({ score: 'UNKNOWN' })).toBeNull()
    expect(normalizeQualityScore('')).toBeNull()
    expect(normalizeQualityScore(undefined)).toBeNull()
  })
})

describe('extractTemplateExamples', () => {
  it('junta os samples de corpo e cabeçalho', () => {
    const componentes: MetaTemplateComponentRaw[] = [
      { type: 'HEADER', format: 'TEXT', text: 'Oi {{1}}', example: { header_text: ['Ana'] } },
      { type: 'BODY', text: '{{1}} e {{2}}', example: { body_text: [['Ana', 'Centro']] } },
    ]
    expect(extractTemplateExamples(componentes)).toEqual({
      body: ['Ana', 'Centro'],
      header: ['Ana'],
    })
  })

  it('devolve null quando não há exemplo nenhum — null significa "não mexe", não "apaga"', () => {
    expect(
      extractTemplateExamples([
        { type: 'HEADER', format: 'TEXT', text: 'Oi' },
        { type: 'BODY', text: 'sem variavel' },
      ]),
    ).toBeNull()
    expect(extractTemplateExamples(undefined)).toBeNull()
  })

  it('carrega header_handle e header_url quando presentes', () => {
    expect(
      extractTemplateExamples([
        {
          type: 'HEADER',
          format: 'IMAGE',
          example: { header_handle: ['4::abc'], header_url: ['https://x/y.png'] },
        },
      ]),
    ).toEqual({ header_handle: ['4::abc'], header_url: ['https://x/y.png'] })
  })
})

// ---------------------------------------------------------------------------
// toSuntTemplatePayload
// ---------------------------------------------------------------------------

/** Template com um botão de tipo desconhecido (FLOW) NO MEIO — o caso que quebra o envio. */
function componentesComFlow(): MetaTemplateComponentRaw[] {
  return [
    { type: 'HEADER', format: 'TEXT', text: 'Oi {{1}}' },
    { type: 'BODY', text: 'Seu imovel {{1}} em {{2}} esta disponivel' },
    { type: 'FOOTER', text: 'SUNT Imoveis' },
    {
      type: 'BUTTONS',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Quero saber mais' },
        { type: 'FLOW', text: 'Abrir formulario', flow_id: '999' },
        { type: 'URL', text: 'Ver no site', url: 'https://sunt.com.br/{{1}}' },
      ],
    },
  ]
}

describe('toSuntTemplatePayload', () => {
  it('devolve null sem nome ou sem idioma', () => {
    expect(toSuntTemplatePayload({ language: 'pt_BR' })).toBeNull()
    expect(toSuntTemplatePayload({ name: '  ', language: 'pt_BR' })).toBeNull()
    expect(toSuntTemplatePayload({ name: 'boas_vindas' })).toBeNull()
    expect(toSuntTemplatePayload({ name: 'boas_vindas', language: '   ' })).toBeNull()
  })

  it('preserva os componentes VERBATIM, inclusive o botão FLOW no meio', () => {
    // A rota legada refatia o template em colunas e DESCARTA botões de tipo desconhecido.
    // Como o envio identifica botão por POSIÇÃO, perder o FLOW faria o índice 2 (URL) virar 1
    // e o clique no site disparar o botão errado. Aqui o array sai idêntico ao da Meta.
    const componentes = componentesComFlow()
    const payload = toSuntTemplatePayload({
      id: '123',
      name: 'oferta',
      language: 'pt_BR',
      status: 'APPROVED',
      category: 'MARKETING',
      components: componentes,
    })

    expect(payload).not.toBeNull()
    expect(payload!.componentes).toEqual(componentes)

    const botoes = payload!.componentes[3].buttons ?? []
    expect(botoes).toHaveLength(3)
    expect(botoes[1].type).toBe('FLOW')
    expect(botoes[2].type).toBe('URL')
    expect(botoes[2].url).toBe('https://sunt.com.br/{{1}}')
  })

  it('preenche o resto do payload a partir do template cru', () => {
    const payload = toSuntTemplatePayload({
      id: '456',
      name: '  oferta  ',
      language: ' pt_BR ',
      status: 'REJECTED',
      category: 'utility',
      quality_score: { score: 'RED' },
      rejected_reason: 'INVALID_FORMAT',
      components: [{ type: 'BODY', text: 'oi' }],
    })

    expect(payload).toMatchObject({
      meta_template_id: '456',
      nome: 'oferta',
      idioma: 'pt_BR',
      categoria: 'UTILITY',
      status_aprovacao: 'rejeitado',
      quality_score: 'RED',
      motivo_rejeicao: 'INVALID_FORMAT',
      exemplos: null,
    })
  })

  it('trata componentes ausentes como lista vazia (nunca undefined)', () => {
    const payload = toSuntTemplatePayload({ name: 'x', language: 'pt_BR' })
    expect(payload!.componentes).toEqual([])
    expect(payload!.meta_template_id).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Variáveis
// ---------------------------------------------------------------------------

describe('extractVariableIndices', () => {
  it('devolve índices distintos e ordenados', () => {
    expect(extractVariableIndices('{{2}} depois {{1}} e de novo {{2}}')).toEqual([1, 2])
  })

  it('ignora texto vazio e {{0}}', () => {
    expect(extractVariableIndices('')).toEqual([])
    expect(extractVariableIndices(null)).toEqual([])
    expect(extractVariableIndices('{{0}} nao conta')).toEqual([])
  })
})

describe('extractTemplateVariables', () => {
  it('mapeia cabeçalho, corpo e TODOS os botões por posição', () => {
    // Omitir um botão sem variável deslocaria o índice posicional dos seguintes — que é
    // justamente o que o builder de envio usa para montar `index: String(i)`.
    const variaveis = extractTemplateVariables(componentesComFlow())

    expect(variaveis.cabecalho).toEqual([1])
    expect(variaveis.corpo).toEqual([1, 2])
    expect(variaveis.botoes).toEqual([
      { indice: 0, tipo: 'QUICK_REPLY', variaveis: [] },
      { indice: 1, tipo: 'FLOW', variaveis: [] },
      { indice: 2, tipo: 'URL', variaveis: [1] },
    ])
  })

  it('devolve listas vazias para um template sem componentes', () => {
    expect(extractTemplateVariables(undefined)).toEqual({
      cabecalho: [],
      corpo: [],
      botoes: [],
    })
  })
})

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

describe('renderTemplateText', () => {
  it('substitui {{N}} com o array 0-indexado (texto é 1-indexado)', () => {
    expect(renderTemplateText('Oi {{1}}, o {{2}} chegou', ['Ana', 'imovel'])).toBe(
      'Oi Ana, o imovel chegou',
    )
  })

  it('valor faltando no meio do array vira string vazia', () => {
    const valores: string[] = ['Ana']
    valores[2] = 'Centro' // índice 1 fica vazio de propósito (campo em branco no formulário)
    expect(renderTemplateText('{{1}} / {{2}} / {{3}}', valores)).toBe('Ana /  / Centro')
  })

  it('texto ou valores ausentes não quebram', () => {
    expect(renderTemplateText(undefined, ['x'])).toBe('')
    expect(renderTemplateText('sem variavel', undefined)).toBe('sem variavel')
  })
})

describe('renderTemplatePreview', () => {
  it('renderiza cabeçalho de texto, corpo, rodapé e botões', () => {
    const preview = renderTemplatePreview(componentesComFlow(), {
      cabecalho: ['Ana'],
      corpo: ['Alto da Boa Vista', 'Centro'],
    })

    expect(preview.cabecalho).toBe('Oi Ana')
    expect(preview.corpo).toBe('Seu imovel Alto da Boa Vista em Centro esta disponivel')
    expect(preview.rodape).toBe('SUNT Imoveis')
    expect(preview.botoes).toEqual([
      { indice: 0, tipo: 'QUICK_REPLY', texto: 'Quero saber mais' },
      { indice: 1, tipo: 'FLOW', texto: 'Abrir formulario' },
      { indice: 2, tipo: 'URL', texto: 'Ver no site' },
    ])
  })

  it('cabeçalho de mídia vira o rótulo do formato, não texto interpolado', () => {
    const preview = renderTemplatePreview([
      { type: 'HEADER', format: 'IMAGE' },
      { type: 'BODY', text: 'corpo' },
    ])
    expect(preview.cabecalho).toBe('[IMAGE]')
  })

  it('sem cabeçalho o preview traz null, e valor faltando vira string vazia', () => {
    const preview = renderTemplatePreview([{ type: 'BODY', text: 'Oi {{1}}' }], { corpo: [''] })
    expect(preview.cabecalho).toBeNull()
    expect(preview.corpo).toBe('Oi ')
    expect(preview.rodape).toBeNull()
    expect(preview.botoes).toEqual([])
  })
})

describe('validateTemplateValues', () => {
  it('aponta corpo e cabeçalho faltando, na ordem corpo -> cabeçalho', () => {
    const variaveis = extractTemplateVariables(componentesComFlow())
    const resultado = validateTemplateValues(variaveis, { corpo: ['so um'] })

    expect(resultado.ok).toBe(false)
    expect(resultado.faltando).toEqual([
      { onde: 'corpo', exigidas: 2, fornecidas: 1 },
      { onde: 'cabecalho', exigidas: 1, fornecidas: 0 },
    ])
  })

  it('ok quando todas as variáveis foram fornecidas', () => {
    const variaveis = extractTemplateVariables(componentesComFlow())
    const resultado = validateTemplateValues(variaveis, {
      cabecalho: ['Ana'],
      corpo: ['Alto', 'Centro'],
    })
    expect(resultado).toEqual({ ok: true, faltando: [] })
  })

  it('template sem variáveis é válido mesmo sem valores', () => {
    const variaveis = extractTemplateVariables([{ type: 'BODY', text: 'texto fixo' }])
    expect(validateTemplateValues(variaveis, {}).ok).toBe(true)
  })
})
