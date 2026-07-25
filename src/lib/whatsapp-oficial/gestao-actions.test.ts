/**
 * Testes das chamadas de gestão feitas pelo navegador.
 *
 * O que trava aqui, em ordem de estrago se quebrar:
 *  1. `montarConfigCampanha` OMITINDO chave vazia. `bases_legais: []` suprime
 *     todo mundo e `janela_dias: []` bloqueia todos os dias — os dois são
 *     recusados pela rota hoje, mas o dia em que a rota afrouxar, a campanha
 *     nasce condenada em silêncio.
 *  2. `gerarDestinatarios(id, false)` sendo a ÚNICA forma de materializar, e
 *     `dryRun` viajando no corpo com o booleano certo.
 *  3. `montarValoresPreview` não compactando buraco no meio — compactar
 *     deslocaria {{3}} para o lugar de {{2}} e o preview mentiria.
 *  4. A normalização de erro preservando status e campos extras (o 409 com
 *     `status`, o `variaveis_insuficientes` com `exigidas`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acaoCampanha,
  criarCampanha,
  gerarDestinatarios,
  listarTemplates,
  montarConfigCampanha,
  montarCorpoCampanha,
  montarQueryTemplates,
  montarValoresPreview,
  previewTemplate,
  SLUG_FALHA_DE_REDE,
  type FormularioCampanha,
} from './gestao-actions'

const CAMPANHA_ID = '11111111-1111-4111-8111-111111111111'
const CANAL_ID = '22222222-2222-4222-8222-222222222222'

function mockFetch(resposta: { status?: number; body?: unknown }) {
  const fn = vi.fn().mockResolvedValue({
    ok: (resposta.status ?? 200) < 400,
    status: resposta.status ?? 200,
    json: async () => resposta.body ?? {},
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

/** Corpo JSON que a última chamada de fetch enviou. */
function corpoEnviado(fn: ReturnType<typeof vi.fn>, chamada = 0): Record<string, unknown> {
  const init = fn.mock.calls[chamada][1] as RequestInit
  return JSON.parse(String(init.body)) as Record<string, unknown>
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------- templates

describe('montarQueryTemplates', () => {
  it('sempre manda o canal', () => {
    expect(montarQueryTemplates({ canalId: CANAL_ID })).toBe(`canalId=${CANAL_ID}`)
  })

  it('CRÍTICO: traduz "todos" para omissão em vez de mandar o valor', () => {
    // `status=todos` viraria `eq('status_aprovacao','todos')` na rota e
    // devolveria lista vazia sem erro nenhum.
    const qs = montarQueryTemplates({ canalId: CANAL_ID, status: 'todos', idioma: 'todos' })
    expect(qs).toBe(`canalId=${CANAL_ID}`)
  })

  it('repassa filtros reais', () => {
    const qs = montarQueryTemplates({ canalId: CANAL_ID, status: 'aprovado', idioma: 'pt_BR' })
    expect(qs).toContain('status=aprovado')
    expect(qs).toContain('idioma=pt_BR')
  })
})

describe('montarValoresPreview', () => {
  it('não manda bloco que o template não exige', () => {
    const v = montarValoresPreview({ cabecalho: [], corpo: [1] }, { corpo: { 1: 'oi' } })
    expect(v).toEqual({ corpo: ['oi'] })
    expect('cabecalho' in v).toBe(false)
  })

  it('CRÍTICO: buraco no meio vira string vazia, nunca compacta', () => {
    // Compactar colocaria o valor de {{3}} na posição de {{2}} — o preview
    // ficaria plausível e errado.
    const v = montarValoresPreview({ cabecalho: [], corpo: [1, 2, 3] }, { corpo: { 1: 'a', 3: 'c' } })
    expect(v.corpo).toEqual(['a', '', 'c'])
  })

  it('preenche até o MAIOR índice exigido mesmo com índices não contíguos', () => {
    // Um corpo com {{1}} e {{4}} exige um array de 4 posições, senão {{4}}
    // ficaria fora da faixa e continuaria literal no render.
    const v = montarValoresPreview({ cabecalho: [], corpo: [1, 4] }, { corpo: { 1: 'a', 4: 'd' } })
    expect(v.corpo).toEqual(['a', '', '', 'd'])
  })

  it('descarta valor digitado além do que o template pede', () => {
    // Sem o corte, a rota responderia 422 `valores_demais` por culpa da tela.
    const v = montarValoresPreview({ cabecalho: [], corpo: [1] }, { corpo: { 1: 'a', 2: 'sobra' } })
    expect(v.corpo).toEqual(['a'])
  })

  it('template sem variável nenhuma manda objeto vazio', () => {
    expect(montarValoresPreview({ cabecalho: [], corpo: [] }, {})).toEqual({})
  })

  it('previewTemplate posta templateId e valores', async () => {
    const fn = mockFetch({ body: { templateId: 't1' } })
    await previewTemplate('t1', { corpo: ['x'] })
    expect(corpoEnviado(fn)).toEqual({ templateId: 't1', valores: { corpo: ['x'] } })
  })

  it('listarTemplates usa GET sem corpo', async () => {
    const fn = mockFetch({ body: { templates: [] } })
    await listarTemplates({ canalId: CANAL_ID })
    const [url, init] = fn.mock.calls[0] as [string, RequestInit]
    expect(url).toContain(`canalId=${CANAL_ID}`)
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
  })
})

// ---------------------------------------------------------------- campanhas

describe('montarConfigCampanha', () => {
  const base: FormularioCampanha = { canalId: CANAL_ID, nome: 'Reativação' }

  it('formulário em branco não produz config nenhuma', () => {
    expect(montarConfigCampanha(base)).toEqual({})
  })

  it('CRÍTICO: lista vazia é omitida, nunca enviada como []', () => {
    const config = montarConfigCampanha({
      ...base,
      basesLegais: [],
      janelaDias: [],
      segmentacao: { etapas: [], temperaturas: [], tags: [], origens: [] },
    })
    // `bases_legais: []` com a política padrão suprime TODO MUNDO;
    // `janela_dias: []` bloqueia todos os dias. Nenhuma das duas chaves pode
    // sair daqui.
    expect(config).toEqual({})
    expect('bases_legais' in config).toBe(false)
    expect('janela_dias' in config).toBe(false)
    expect('segmentacao' in config).toBe(false)
  })

  it('descarta strings em branco dentro das listas', () => {
    const config = montarConfigCampanha({
      ...base,
      basesLegais: ['  ', ''],
      segmentacao: { tags: ['  ', 'bolsao'] },
    })
    expect('bases_legais' in config).toBe(false)
    expect(config.segmentacao).toEqual({ tags: ['bolsao'] })
  })

  it('CRÍTICO: meia janela não é enviada', () => {
    expect(montarConfigCampanha({ ...base, janelaInicio: '09:00' })).toEqual({})
    expect(montarConfigCampanha({ ...base, janelaFim: '18:00' })).toEqual({})
    expect(montarConfigCampanha({ ...base, janelaInicio: '09:00', janelaFim: '18:00' })).toEqual({
      janela_inicio: '09:00',
      janela_fim: '18:00',
    })
  })

  it('normaliza os dias: filtra fora de 1..7, deduplica e ordena', () => {
    const config = montarConfigCampanha({ ...base, janelaDias: [5, 1, 0, 8, 1, 3] })
    expect(config.janela_dias).toEqual([1, 3, 5])
  })

  it('omite janela_dias quando nada sobrou do filtro', () => {
    // `[0, 8]` sem filtro viraria `janela_dias_invalida`; filtrado, viraria
    // `[]`, que é o pior dos dois. Omitir é o único resultado seguro.
    expect(montarConfigCampanha({ ...base, janelaDias: [0, 8] })).toEqual({})
  })

  it('só manda sem_corretor quando é true', () => {
    expect(montarConfigCampanha({ ...base, segmentacao: { semCorretor: false } })).toEqual({})
    expect(montarConfigCampanha({ ...base, segmentacao: { semCorretor: true } })).toEqual({
      segmentacao: { sem_corretor: true },
    })
  })

  it('repassa os números só quando são números', () => {
    const config = montarConfigCampanha({
      ...base,
      cooldownDias: 30,
      cadenciaSegundos: null,
      loteMax: 50,
      limiteDiario: null,
    })
    expect(config).toEqual({ cooldown_dias: 30, lote_max: 50 })
  })

  it('aceita zero como valor legítimo', () => {
    // `cooldown_dias: 0` significa "sem cooldown" e é diferente de omitir
    // (que usa o default 30 da RPC).
    expect(montarConfigCampanha({ ...base, cooldownDias: 0 }).cooldown_dias).toBe(0)
  })
})

describe('montarCorpoCampanha', () => {
  it('manda o mínimo quando só há nome e canal', () => {
    expect(montarCorpoCampanha({ canalId: CANAL_ID, nome: '  Reativação  ' })).toEqual({
      canalId: CANAL_ID,
      nome: 'Reativação',
    })
  })

  it('omite templateId nulo e mensagem livre em branco', () => {
    const corpo = montarCorpoCampanha({
      canalId: CANAL_ID,
      nome: 'X',
      templateId: null,
      mensagemLivre: '   ',
    })
    expect('templateId' in corpo).toBe(false)
    expect('mensagemLivre' in corpo).toBe(false)
  })

  it('inclui config só quando ela tem conteúdo', () => {
    const semConfig = montarCorpoCampanha({ canalId: CANAL_ID, nome: 'X', basesLegais: [] })
    expect('config' in semConfig).toBe(false)
    const comConfig = montarCorpoCampanha({
      canalId: CANAL_ID,
      nome: 'X',
      basesLegais: ['fb_lead_form'],
    })
    expect(comConfig.config).toEqual({ bases_legais: ['fb_lead_form'] })
  })

  it('criarCampanha posta o corpo montado', async () => {
    const fn = mockFetch({ status: 201, body: { ok: true, broadcast_id: CAMPANHA_ID } })
    await criarCampanha({ canalId: CANAL_ID, nome: 'Reativação', basesLegais: ['fb_lead_form'] })
    expect(corpoEnviado(fn)).toEqual({
      canalId: CANAL_ID,
      nome: 'Reativação',
      config: { bases_legais: ['fb_lead_form'] },
    })
  })
})

describe('gerarDestinatarios', () => {
  it('CRÍTICO: dry-run manda dryRun: true', async () => {
    const fn = mockFetch({ body: { ok: true, dry_run: true, elegiveis: 8, suprimidos: 2 } })
    await gerarDestinatarios(CAMPANHA_ID, true)
    expect(corpoEnviado(fn)).toEqual({ dryRun: true })
  })

  it('CRÍTICO: materializar manda dryRun: false — literalmente', async () => {
    // A rota só materializa com `=== false`. Um `undefined` aqui viraria
    // dry-run silencioso e o operador acharia que gravou.
    const fn = mockFetch({ body: { ok: true, dry_run: false, linhas_gravadas: 8 } })
    await gerarDestinatarios(CAMPANHA_ID, false)
    expect(corpoEnviado(fn).dryRun).toBe(false)
  })

  it('só manda limite quando é número', async () => {
    const fn = mockFetch({ body: { ok: true } })
    await gerarDestinatarios(CAMPANHA_ID, true, null)
    expect('limite' in corpoEnviado(fn)).toBe(false)
    await gerarDestinatarios(CAMPANHA_ID, true, 500)
    expect(corpoEnviado(fn, 1).limite).toBe(500)
  })
})

describe('acaoCampanha', () => {
  it('monta a URL da ação', async () => {
    const fn = mockFetch({ body: { ok: true, status: 'aprovado' } })
    await acaoCampanha(CAMPANHA_ID, 'aprovar')
    expect(fn.mock.calls[0][0]).toBe(`/api/whatsapp-oficial/campanhas/${CAMPANHA_ID}/aprovar`)
  })

  it('manda motivo só em pausar/cancelar', async () => {
    const fn = mockFetch({ body: { ok: true } })
    await acaoCampanha(CAMPANHA_ID, 'pausar', 'volume alto')
    expect(corpoEnviado(fn)).toEqual({ motivo: 'volume alto' })
    await acaoCampanha(CAMPANHA_ID, 'aprovar', 'volume alto')
    expect(corpoEnviado(fn, 1)).toEqual({})
  })

  it('motivo em branco não vira chave', async () => {
    const fn = mockFetch({ body: { ok: true } })
    await acaoCampanha(CAMPANHA_ID, 'cancelar', '   ')
    expect(corpoEnviado(fn)).toEqual({})
  })
})

// ------------------------------------------------------- normalização de erro

describe('normalização da resposta de erro', () => {
  it('preserva slug, status e campos extras', async () => {
    mockFetch({ status: 409, body: { error: 'status_invalido', status: 'concluido' } })
    const r = await acaoCampanha(CAMPANHA_ID, 'pausar')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.slug).toBe('status_invalido')
    expect(r.status).toBe(409)
    // O `status` da campanha viaja em `detalhes`, separado do status HTTP —
    // as duas coisas se chamam "status" e não podem se sobrescrever.
    expect(r.detalhes.status).toBe('concluido')
    expect(r.mensagem).toContain('status que permita')
  })

  it('traduz o slug de quatro olhos em vez de repassar cru', async () => {
    mockFetch({ status: 409, body: { error: 'aprovador_igual_criador' } })
    const r = await acaoCampanha(CAMPANHA_ID, 'aprovar')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.mensagem).toContain('quatro olhos')
  })

  it('resposta de erro sem corpo JSON ainda vira mensagem por status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('not json')
        },
      }),
    )
    const r = await acaoCampanha(CAMPANHA_ID, 'aprovar')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.slug).toBe('')
    expect(r.mensagem).toContain('Erro interno')
  })

  it('falha de rede tem slug próprio e status 0', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const r = await acaoCampanha(CAMPANHA_ID, 'aprovar')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.slug).toBe(SLUG_FALHA_DE_REDE)
    expect(r.status).toBe(0)
  })

  it('abort é relançado, não vira erro de tela', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')),
    )
    // Quem chamou trata o abort como "pedido substituído"; transformá-lo em
    // ApiFalha faria a tela piscar erro a cada troca de canal.
    await expect(listarTemplates({ canalId: CANAL_ID })).rejects.toThrow()
  })
})
