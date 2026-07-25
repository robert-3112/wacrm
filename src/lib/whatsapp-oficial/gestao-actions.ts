/**
 * Chamadas do navegador para as rotas de gestão (templates e campanhas), com
 * o erro já traduzido.
 *
 * Deliberadamente NÃO reusa o `request` de `inbox-actions.ts`, e a diferença
 * não é estética: aquele helper achata a resposta de erro em
 * `{ ok: false, error: string }`, jogando fora o status HTTP e os campos
 * extras. As rotas de campanha dependem dos dois — `409 status_invalido` vem
 * com o `status` atual da campanha, `variaveis_insuficientes` vem com
 * `exigidas`/`fornecidas`, e o 409 x 422 é o que separa "o mundo não permite
 * agora" de "seu formulário está errado". Um helper que descarta isso obrigaria
 * cada tela a refazer o fetch cru.
 *
 * Nenhuma função aqui envia mensagem: `enviarTemplate` ENFILEIRA (a resposta
 * da rota diz `enfileirado: true` de propósito) e as ações de campanha só
 * mudam status. Quem entrega — ou simula, no modo shadow — é o worker da
 * outbox.
 */

import { traduzirErro } from './gestao-erros'
import type {
  CampanhaDetalheResposta,
  CampanhaResumo,
  GerarDestinatariosResultado,
  TemplatePreviewResposta,
  TemplateSyncResultado,
  WhatsAppTemplate,
} from '@/types/whatsapp-oficial'

export interface ApiSucesso<T> {
  ok: true
  data: T
}

export interface ApiFalha {
  ok: false
  /** Slug cru devolvido pela rota — para a tela decidir comportamento
   *  (ex.: `aprovador_igual_criador` merece um bloco explicativo, não um toast). */
  slug: string
  /** Frase pronta em português. */
  mensagem: string
  /** 0 quando a requisição nem chegou a sair (falha de rede). */
  status: number
  /** Campos extras da resposta de erro (`exigidas`, `status`, `detalhe`...). */
  detalhes: Record<string, unknown>
}

export type ApiResultado<T> = ApiSucesso<T> | ApiFalha

interface RequestOpts {
  method?: 'GET' | 'POST'
  body?: unknown
  signal?: AbortSignal
}

/** Erro de rede/abort não tem slug nem status — a tela precisa distinguir
 *  isso de uma recusa do servidor para saber se vale oferecer "tentar de
 *  novo". */
export const SLUG_FALHA_DE_REDE = 'falha_de_rede'

async function requisitar<T>(url: string, opts: RequestOpts = {}): Promise<ApiResultado<T>> {
  const { method = 'GET', body, signal } = opts

  let res: Response
  try {
    res = await fetch(url, {
      method,
      signal,
      ...(method === 'POST'
        ? {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body ?? {}),
          }
        : {}),
    })
  } catch (err) {
    // Um abort (troca de canal, desmonte do componente) não é falha: quem
    // chamou precisa poder ignorá-lo em vez de mostrar erro na tela.
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    return {
      ok: false,
      slug: SLUG_FALHA_DE_REDE,
      mensagem: 'Falha de rede — verifique a conexão e tente de novo.',
      status: 0,
      detalhes: {},
    }
  }

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>

  if (!res.ok) {
    const slug = typeof json.error === 'string' ? json.error : ''
    const detalhes: Record<string, unknown> = {}
    for (const [chave, valor] of Object.entries(json)) {
      if (chave !== 'error') detalhes[chave] = valor
    }
    return {
      ok: false,
      slug,
      mensagem: traduzirErro(slug, res.status),
      status: res.status,
      detalhes,
    }
  }

  return { ok: true, data: json as T }
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export interface ListarTemplatesFiltro {
  canalId: string
  status?: string
  idioma?: string
}

/**
 * Monta a query string do catálogo.
 *
 * Chave com valor vazio é OMITIDA, e isso importa: a rota faz
 * `if (status) query = query.eq(...)`, então mandar `status=` seria inofensivo
 * hoje — mas mandar `status=todos` (o valor que o `<Select>` usa para "sem
 * filtro") viraria `eq('status_aprovacao', 'todos')` e devolveria lista vazia
 * sem erro nenhum. A tradução de "todos" para "omitir" mora aqui, uma vez só.
 */
export function montarQueryTemplates(filtro: ListarTemplatesFiltro): string {
  const params = new URLSearchParams()
  params.set('canalId', filtro.canalId)
  if (filtro.status && filtro.status !== 'todos') params.set('status', filtro.status)
  if (filtro.idioma && filtro.idioma !== 'todos') params.set('idioma', filtro.idioma)
  return params.toString()
}

export function listarTemplates(
  filtro: ListarTemplatesFiltro,
  signal?: AbortSignal,
): Promise<ApiResultado<{ templates: WhatsAppTemplate[] }>> {
  return requisitar(`/api/whatsapp-oficial/templates?${montarQueryTemplates(filtro)}`, { signal })
}

export function sincronizarTemplates(
  canalId: string,
): Promise<ApiResultado<TemplateSyncResultado>> {
  return requisitar('/api/whatsapp-oficial/templates/sync', {
    method: 'POST',
    body: { canalId },
  })
}

/**
 * Monta o `valores` do preview a partir do que o operador digitou.
 *
 * Os índices `{{N}}` são 1-indexados no texto e a rota espera um ARRAY denso
 * 0-indexado, então a posição no array é a identidade do valor. Duas
 * consequências que esta função existe para garantir:
 *
 *  1. Buraco no meio (`{{1}}` e `{{3}}` preenchidos, `{{2}}` não) NÃO pode
 *     compactar o array — isso deslocaria `{{3}}` para a posição de `{{2}}` e
 *     o preview mentiria sobre o texto final. Buraco vira string vazia.
 *  2. Só mandamos a chave quando o template exige aquele bloco. Um
 *     `cabecalho: []` num template sem cabeçalho é ruído; pior, um array
 *     preenchido para um bloco inexistente sugeriria na tela um valor que o
 *     envio ignoraria.
 *
 * O corte final usa o MAIOR índice exigido, não `Math.max` do que foi
 * digitado: valor digitado além do que o template pede é descartado aqui, em
 * vez de virar `valores_demais` (422) na rota.
 */
export function montarValoresPreview(
  exigidos: { cabecalho: number[]; corpo: number[] },
  digitados: { cabecalho?: Record<number, string>; corpo?: Record<number, string> },
): { cabecalho?: string[]; corpo?: string[] } {
  const bloco = (indices: number[], valores: Record<number, string> | undefined) => {
    if (indices.length === 0) return undefined
    const maior = Math.max(...indices)
    const lista: string[] = []
    for (let i = 1; i <= maior; i += 1) {
      lista.push(valores?.[i] ?? '')
    }
    return lista
  }

  const resultado: { cabecalho?: string[]; corpo?: string[] } = {}
  const cabecalho = bloco(exigidos.cabecalho, digitados.cabecalho)
  if (cabecalho) resultado.cabecalho = cabecalho
  const corpo = bloco(exigidos.corpo, digitados.corpo)
  if (corpo) resultado.corpo = corpo
  return resultado
}

export function previewTemplate(
  templateId: string,
  valores: { cabecalho?: string[]; corpo?: string[] },
  signal?: AbortSignal,
): Promise<ApiResultado<TemplatePreviewResposta>> {
  return requisitar('/api/whatsapp-oficial/templates/preview', {
    method: 'POST',
    body: { templateId, valores },
    signal,
  })
}

// ---------------------------------------------------------------------------
// Campanhas
// ---------------------------------------------------------------------------

export function listarCampanhas(
  filtro: { canalId?: string; status?: string } = {},
  signal?: AbortSignal,
): Promise<ApiResultado<{ ok: true; campanhas: CampanhaResumo[] }>> {
  const params = new URLSearchParams()
  if (filtro.canalId) params.set('canalId', filtro.canalId)
  if (filtro.status && filtro.status !== 'todos') params.set('status', filtro.status)
  const qs = params.toString()
  return requisitar(`/api/whatsapp-oficial/campanhas${qs ? `?${qs}` : ''}`, { signal })
}

export function obterCampanha(
  id: string,
  signal?: AbortSignal,
): Promise<ApiResultado<CampanhaDetalheResposta>> {
  return requisitar(`/api/whatsapp-oficial/campanhas/${id}`, { signal })
}

/** Campos do formulário de criação, já normalizados pelos inputs. */
export interface FormularioCampanha {
  canalId: string
  nome: string
  templateId?: string | null
  mensagemLivre?: string
  politicaConsentimento?: string
  basesLegais?: string[]
  politicaHandoff?: string
  cooldownDias?: number | null
  cadenciaSegundos?: number | null
  loteMax?: number | null
  limiteDiario?: number | null
  janelaInicio?: string
  janelaFim?: string
  janelaDias?: number[]
  segmentacao?: {
    etapas?: string[]
    temperaturas?: string[]
    tags?: string[]
    origens?: string[]
    semCorretor?: boolean
    criadoDe?: string
    criadoAte?: string
  }
}

/**
 * Monta o `config` da campanha OMITINDO tudo que o operador não preencheu.
 *
 * Isto é a trava mais importante deste módulo, porque no vocabulário desta API
 * "ausente" e "vazio" são opostos, não sinônimos:
 *
 *  - `bases_legais: []` com a política `exigir_base_legal` não é "sem
 *    restrição": nenhuma base casa, e a geração de público SUPRIME TODO MUNDO.
 *    A rota recusa com `bases_legais_vazia` justamente porque esse erro é
 *    invisível depois.
 *  - `janela_dias: []` não é "todo dia serve": nenhum dia fica liberado e a
 *    campanha nunca envia, sem erro em lugar nenhum (`janela_dias_vazia`).
 *  - Metade de janela (`janela_inicio` sem `janela_fim`) é `janela_incompleta`.
 *    Mandamos as duas ou nenhuma.
 *
 * O mesmo vale para os filtros de segmentação: na RPC, "todo filtro ausente =
 * sem restrição", mas um array vazio é um `IN ()` que não casa com ninguém.
 */
export function montarConfigCampanha(form: FormularioCampanha): Record<string, unknown> {
  const config: Record<string, unknown> = {}

  if (form.politicaConsentimento) config.politica_consentimento = form.politicaConsentimento
  if (form.politicaHandoff) config.politica_handoff = form.politicaHandoff

  const bases = (form.basesLegais ?? []).map((b) => b.trim()).filter(Boolean)
  if (bases.length > 0) config.bases_legais = bases

  if (typeof form.cooldownDias === 'number') config.cooldown_dias = form.cooldownDias
  if (typeof form.cadenciaSegundos === 'number') config.cadencia_segundos = form.cadenciaSegundos
  if (typeof form.loteMax === 'number') config.lote_max = form.loteMax
  if (typeof form.limiteDiario === 'number') config.limite_diario = form.limiteDiario

  // Janela: só vai completa. Meia janela é recusa garantida da rota.
  const inicio = (form.janelaInicio ?? '').trim()
  const fim = (form.janelaFim ?? '').trim()
  if (inicio && fim) {
    config.janela_inicio = inicio
    config.janela_fim = fim
  }

  const dias = (form.janelaDias ?? []).filter(
    (d) => Number.isInteger(d) && d >= 1 && d <= 7,
  )
  if (dias.length > 0) config.janela_dias = [...new Set(dias)].sort((a, b) => a - b)

  const seg: Record<string, unknown> = {}
  const listas: [keyof NonNullable<FormularioCampanha['segmentacao']>, string][] = [
    ['etapas', 'etapas'],
    ['temperaturas', 'temperaturas'],
    ['tags', 'tags'],
    ['origens', 'origens'],
  ]
  for (const [chaveForm, chaveConfig] of listas) {
    const bruto = form.segmentacao?.[chaveForm]
    if (!Array.isArray(bruto)) continue
    const limpo = bruto.map((v) => String(v).trim()).filter(Boolean)
    if (limpo.length > 0) seg[chaveConfig] = limpo
  }
  // `sem_corretor: false` é o default da RPC — mandar explicitamente só
  // acrescenta ruído ao jsonb gravado.
  if (form.segmentacao?.semCorretor === true) seg.sem_corretor = true
  const criadoDe = (form.segmentacao?.criadoDe ?? '').trim()
  const criadoAte = (form.segmentacao?.criadoAte ?? '').trim()
  if (criadoDe) seg.criado_de = criadoDe
  if (criadoAte) seg.criado_ate = criadoAte
  if (Object.keys(seg).length > 0) config.segmentacao = seg

  return config
}

/** Corpo completo de `POST /api/whatsapp-oficial/campanhas`. */
export function montarCorpoCampanha(form: FormularioCampanha): Record<string, unknown> {
  const corpo: Record<string, unknown> = {
    canalId: form.canalId,
    nome: form.nome.trim(),
  }
  if (form.templateId) corpo.templateId = form.templateId
  const livre = (form.mensagemLivre ?? '').trim()
  if (livre) corpo.mensagemLivre = livre
  const config = montarConfigCampanha(form)
  if (Object.keys(config).length > 0) corpo.config = config
  return corpo
}

export function criarCampanha(
  form: FormularioCampanha,
): Promise<ApiResultado<{ ok: true; broadcast_id: string; status: string }>> {
  return requisitar('/api/whatsapp-oficial/campanhas', {
    method: 'POST',
    body: montarCorpoCampanha(form),
  })
}

/**
 * Gera o público. `dryRun` é obrigatório e explícito nesta assinatura de
 * propósito: a rota já tem o default seguro, mas um parâmetro opcional aqui
 * deixaria a chamada perigosa a um `?` de distância. Quem materializa precisa
 * escrever `false` com todas as letras.
 */
export function gerarDestinatarios(
  id: string,
  dryRun: boolean,
  limite?: number | null,
): Promise<ApiResultado<GerarDestinatariosResultado>> {
  const body: Record<string, unknown> = { dryRun }
  if (typeof limite === 'number') body.limite = limite
  return requisitar(`/api/whatsapp-oficial/campanhas/${id}/destinatarios`, {
    method: 'POST',
    body,
  })
}

export type AcaoCampanha = 'aprovar' | 'pausar' | 'retomar' | 'cancelar'

export function acaoCampanha(
  id: string,
  acao: AcaoCampanha,
  motivo?: string,
): Promise<ApiResultado<{ ok: true; status?: string; itens_cancelados?: number }>> {
  const body: Record<string, unknown> = {}
  const texto = (motivo ?? '').trim()
  // Só `pausar`/`cancelar` leem `motivo`; mandar para as outras é inofensivo,
  // mas manter o corpo mínimo deixa o log da rota legível.
  if (texto && (acao === 'pausar' || acao === 'cancelar')) body.motivo = texto
  return requisitar(`/api/whatsapp-oficial/campanhas/${id}/${acao}`, { method: 'POST', body })
}
