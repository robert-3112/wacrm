/**
 * Catálogo de templates da Meta: busca paginada + tradução para o modelo SUNT.
 *
 * ADAPTADO de `src/app/api/whatsapp/templates/sync/route.ts` (rota do WACRM upstream — harvest
 * matrix área 2). O loop de paginação e o parse dos `components` daquela rota eram funções
 * puras presas dentro do handler; foram EXTRAÍDOS para cá e a rota legada passou a importá-los,
 * em vez de existirem duas cópias divergentes. O que NÃO veio junto é todo o acoplamento ao
 * modelo account-scoped do WACRM (`profiles.account_id` → `whatsapp_config` →
 * `message_templates` com colunas por campo), que não existe no schema SUNT.
 *
 * Três divergências deliberadas em relação à rota legada, cada uma corrigindo um defeito real:
 *
 *  1. **`componentes` é gravado VERBATIM.** A rota legada refatia o template em colunas e
 *     DESCARTA silenciosamente botões de tipo desconhecido (OTP/FLOW/CATALOG/MPM/VOICE_CALL).
 *     Como o envio identifica botão por POSIÇÃO (`index: String(i)` em
 *     `./template-send-builder.ts`), um template com FLOW no meio passaria a disparar o botão
 *     errado. Aqui o array da Meta é preservado inteiro.
 *  2. **Status traduzido para o enum em português** de `whatsapp_templates.status_aprovacao`.
 *     `normalizeStatus` do WACRM devolve os 8 valores MAIÚSCULOS da Meta, que violariam o CHECK
 *     do SUNT. A tradução espelha `public.whatsapp_template_status_meta_to_sunt` no banco.
 *  3. **Versão da Graph API compartilhada** (`metaApiBase()`), em vez de `v21.0` cravado.
 */

import { metaApiBase } from './meta-api'

// ---------------------------------------------------------------------------
// Formato cru da Meta
// ---------------------------------------------------------------------------

export interface MetaTemplateButtonRaw {
  type?: string
  text?: string
  url?: string
  phone_number?: string
  /** A Meta manda ora array, ora escalar. */
  example?: string[] | string
  [key: string]: unknown
}

export interface MetaTemplateComponentRaw {
  type?: string
  format?: string
  text?: string
  buttons?: MetaTemplateButtonRaw[]
  example?: {
    header_text?: string[]
    header_handle?: string[]
    header_url?: string[]
    body_text?: string[][]
  }
  [key: string]: unknown
}

export interface MetaTemplateRaw {
  id?: string
  name?: string
  language?: string
  status?: string
  category?: string
  components?: MetaTemplateComponentRaw[]
  quality_score?: { score?: string } | string
  rejected_reason?: string
}

export const META_TEMPLATE_FIELDS =
  'id,name,language,status,category,components,quality_score'
export const META_TEMPLATE_PAGE_SIZE = 100
/** 20 páginas × 100 = teto de 2000 templates por sync. */
export const META_TEMPLATE_PAGE_CAP = 20

export class MetaTemplateFetchError extends Error {
  readonly httpStatus: number
  constructor(message: string, httpStatus: number) {
    super(message)
    this.name = 'MetaTemplateFetchError'
    this.httpStatus = httpStatus
  }
}

export interface FetchMetaTemplatesArgs {
  wabaId: string
  accessToken: string
  /** Sobrescreve a base da Graph API (usado nos testes). */
  apiBase?: string
  pageSize?: number
  pageCap?: number
  fetchImpl?: typeof fetch
}

export interface FetchMetaTemplatesResult {
  templates: MetaTemplateRaw[]
  /** true quando o cap de páginas foi atingido e AINDA havia próxima página. */
  truncated: boolean
  pages: number
}

/**
 * Percorre `GET /{waba_id}/message_templates` seguindo o cursor `paging.next`.
 *
 * Sem commit parcial, de propósito: qualquer página não-2xx aborta o sync inteiro. Gravar
 * metade do catálogo faria o operador acreditar que templates ausentes foram apagados na Meta.
 */
export async function fetchMetaTemplates(
  args: FetchMetaTemplatesArgs,
): Promise<FetchMetaTemplatesResult> {
  const {
    wabaId,
    accessToken,
    apiBase = metaApiBase(),
    pageSize = META_TEMPLATE_PAGE_SIZE,
    pageCap = META_TEMPLATE_PAGE_CAP,
    fetchImpl = fetch,
  } = args

  if (!wabaId) throw new MetaTemplateFetchError('WABA id ausente', 400)
  if (!accessToken) throw new MetaTemplateFetchError('access token ausente', 400)

  const templates: MetaTemplateRaw[] = []
  let nextUrl: string | null =
    `${apiBase}/${wabaId}/message_templates?limit=${pageSize}&fields=${META_TEMPLATE_FIELDS}`
  let pages = 0

  while (nextUrl && pages < pageCap) {
    pages++
    const res: Response = await fetchImpl(nextUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    if (!res.ok) {
      let msg = `Meta API error: ${res.status}`
      try {
        const body = (await res.json()) as { error?: { message?: string } }
        if (body?.error?.message) msg = body.error.message
      } catch {
        // resposta não era JSON — mantém o fallback
      }
      throw new MetaTemplateFetchError(msg, res.status)
    }

    const body = (await res.json()) as {
      data?: MetaTemplateRaw[]
      paging?: { next?: string }
    }
    if (Array.isArray(body.data)) templates.push(...body.data)
    nextUrl = body.paging?.next ?? null
  }

  return { templates, truncated: pages >= pageCap && nextUrl !== null, pages }
}

// ---------------------------------------------------------------------------
// Tradução Meta -> SUNT
// ---------------------------------------------------------------------------

export type SuntTemplateStatus =
  | 'rascunho'
  | 'pendente'
  | 'aprovado'
  | 'rejeitado'
  | 'pausado'
  | 'desabilitado'
  | 'em_apelacao'
  | 'exclusao_pendente'

const STATUS_META_TO_SUNT: Record<string, SuntTemplateStatus> = {
  APPROVED: 'aprovado',
  REJECTED: 'rejeitado',
  PAUSED: 'pausado',
  DISABLED: 'desabilitado',
  IN_APPEAL: 'em_apelacao',
  PENDING_DELETION: 'exclusao_pendente',
  DRAFT: 'rascunho',
  PENDING: 'pendente',
  PENDING_REVIEW: 'pendente',
}

/**
 * Espelha `public.whatsapp_template_status_meta_to_sunt`. Status desconhecido cai em
 * 'pendente' — NUNCA em 'aprovado': um valor novo da Meta não pode destravar envio sozinho.
 */
export function mapMetaStatusToSunt(status: string | undefined | null): SuntTemplateStatus {
  return STATUS_META_TO_SUNT[(status ?? '').trim().toUpperCase()] ?? 'pendente'
}

export type SuntTemplateCategory = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION'

export function mapMetaCategoryToSunt(
  category: string | undefined | null,
): SuntTemplateCategory | null {
  const upper = (category ?? '').trim().toUpperCase()
  return upper === 'MARKETING' || upper === 'UTILITY' || upper === 'AUTHENTICATION' ? upper : null
}

export function normalizeQualityScore(
  raw: MetaTemplateRaw['quality_score'],
): 'GREEN' | 'YELLOW' | 'RED' | null {
  const score = typeof raw === 'string' ? raw : raw?.score
  const upper = (score ?? '').trim().toUpperCase()
  return upper === 'GREEN' || upper === 'YELLOW' || upper === 'RED' ? upper : null
}

/**
 * Sample values aprovados na Meta. Devolve `null` quando não há nenhum — e o lado do banco
 * trata `null` como "não mexe", nunca como "apaga" (defeito da rota legada, que sobrescreve
 * samples bons com NULL).
 */
export function extractTemplateExamples(
  components: MetaTemplateComponentRaw[] | undefined,
): Record<string, unknown> | null {
  const header = findComponent(components, 'HEADER')
  const body = findComponent(components, 'BODY')
  const out: Record<string, unknown> = {}
  const bodySample = body?.example?.body_text?.[0]
  if (bodySample?.length) out.body = bodySample
  if (header?.example?.header_text?.length) out.header = header.example.header_text
  if (header?.example?.header_handle?.length) out.header_handle = header.example.header_handle
  if (header?.example?.header_url?.length) out.header_url = header.example.header_url
  return Object.keys(out).length ? out : null
}

function findComponent(
  components: MetaTemplateComponentRaw[] | undefined,
  type: string,
): MetaTemplateComponentRaw | undefined {
  return (components ?? []).find((c) => (c.type ?? '').trim().toUpperCase() === type)
}

/** Item do array que a RPC `whatsapp_oficial_sync_templates` consome. */
export interface SuntTemplatePayload {
  meta_template_id: string | null
  nome: string
  idioma: string
  categoria: SuntTemplateCategory | null
  status_aprovacao: SuntTemplateStatus
  quality_score: 'GREEN' | 'YELLOW' | 'RED' | null
  componentes: MetaTemplateComponentRaw[]
  exemplos: Record<string, unknown> | null
  motivo_rejeicao: string | null
}

/**
 * Converte um template cru da Meta no payload da RPC. `componentes` sai VERBATIM — é a única
 * forma de o `template-send-builder` reconstruir o envio com os índices de botão corretos.
 */
export function toSuntTemplatePayload(t: MetaTemplateRaw): SuntTemplatePayload | null {
  const nome = (t.name ?? '').trim()
  const idioma = (t.language ?? '').trim()
  if (!nome || !idioma) return null

  return {
    meta_template_id: (t.id ?? '').trim() || null,
    nome,
    idioma,
    categoria: mapMetaCategoryToSunt(t.category),
    status_aprovacao: mapMetaStatusToSunt(t.status),
    quality_score: normalizeQualityScore(t.quality_score),
    componentes: Array.isArray(t.components) ? t.components : [],
    exemplos: extractTemplateExamples(t.components),
    motivo_rejeicao: (t.rejected_reason ?? '').trim() || null,
  }
}

// ---------------------------------------------------------------------------
// Variáveis e preview
// ---------------------------------------------------------------------------

export interface TemplateButtonVariables {
  indice: number
  tipo: string
  variaveis: number[]
}

export interface TemplateVariables {
  cabecalho: number[]
  corpo: number[]
  botoes: TemplateButtonVariables[]
}

/** Índices `{{N}}` distintos e ordenados. Espelha `whatsapp_template_indices_variaveis`. */
export function extractVariableIndices(text: string | undefined | null): number[] {
  const set = new Set<number>()
  for (const m of (text ?? '').matchAll(/\{\{(\d+)\}\}/g)) {
    const n = Number(m[1])
    if (Number.isFinite(n) && n >= 1) set.add(n)
  }
  return [...set].sort((a, b) => a - b)
}

/**
 * Espelha `public.whatsapp_template_variaveis`. TODO botão entra na lista, inclusive os de tipo
 * desconhecido e os sem variável — omitir um deslocaria o índice posicional dos seguintes.
 */
export function extractTemplateVariables(
  componentes: MetaTemplateComponentRaw[] | undefined,
): TemplateVariables {
  const header = findComponent(componentes, 'HEADER')
  const body = findComponent(componentes, 'BODY')
  const buttonsBlock = findComponent(componentes, 'BUTTONS')

  return {
    cabecalho: extractVariableIndices(header?.text),
    corpo: extractVariableIndices(body?.text),
    botoes: (buttonsBlock?.buttons ?? []).map((b, indice) => ({
      indice,
      tipo: (b.type ?? '').trim().toUpperCase(),
      variaveis: extractVariableIndices(b.url),
    })),
  }
}

export interface TemplatePreview {
  cabecalho: string | null
  corpo: string
  rodape: string | null
  botoes: { indice: number; tipo: string; texto: string }[]
}

/** Teto de valores aceitos num preview/envio. Espelha `whatsapp_template_render` no banco. */
export const TEMPLATE_MAX_VALORES = 40
/** Teto de caracteres por valor. O corpo de um template na Meta vai até 1024. */
export const TEMPLATE_MAX_TAMANHO_VALOR = 1024

/**
 * Substitui `{{1}}..{{N}}` (1-indexado no texto, 0-indexado no array).
 *
 * PASSE ÚNICO, de propósito. A versão anterior fazia um `split/join` por índice, em cascata: o
 * valor colocado no lugar de `{{1}}` voltava a ser varrido na iteração de `{{2}}`. Um valor
 * `"{{2}}{{2}}"` dobrava o texto a cada passo — com 25 valores encadeados, ~33 milhões de
 * tokens e vários GB de alocação, derrubando o processo (instância única no Coolify). Aqui o
 * replace com callback percorre o texto ORIGINAL uma vez só e nunca reexamina o que inseriu,
 * então o crescimento é linear e limitado pelos dois tetos acima.
 *
 * Índice fora da faixa fornecida fica como está (`{{7}}` continua literal), em vez de virar
 * string vazia: some silenciosamente seria pior — o operador não veria que faltou um valor.
 */
export function renderTemplateText(
  texto: string | undefined | null,
  valores: string[] | undefined,
): string {
  const vals = (valores ?? []).slice(0, TEMPLATE_MAX_VALORES)
  return (texto ?? '').replace(/\{\{(\d+)\}\}/g, (match, digitos: string) => {
    const i = Number(digitos)
    if (!Number.isFinite(i) || i < 1 || i > vals.length) return match
    return (vals[i - 1] ?? '').slice(0, TEMPLATE_MAX_TAMANHO_VALOR)
  })
}

export interface TemplatePreviewValues {
  corpo?: string[]
  cabecalho?: string[]
}

/**
 * Preview textual do template já com as variáveis substituídas. É SÓ para a tela — o envio
 * real monta `components` estruturados via `template-send-builder`, nunca texto interpolado.
 */
export function renderTemplatePreview(
  componentes: MetaTemplateComponentRaw[] | undefined,
  valores: TemplatePreviewValues = {},
): TemplatePreview {
  const header = findComponent(componentes, 'HEADER')
  const body = findComponent(componentes, 'BODY')
  const footer = findComponent(componentes, 'FOOTER')
  const buttonsBlock = findComponent(componentes, 'BUTTONS')
  const headerFormat = (header?.format ?? 'TEXT').trim().toUpperCase()

  return {
    cabecalho:
      header && headerFormat === 'TEXT'
        ? renderTemplateText(header.text, valores.cabecalho)
        : header
          ? `[${headerFormat}]`
          : null,
    corpo: renderTemplateText(body?.text, valores.corpo),
    rodape: footer?.text ?? null,
    botoes: (buttonsBlock?.buttons ?? []).map((b, indice) => ({
      indice,
      tipo: (b.type ?? '').trim().toUpperCase(),
      texto: b.text ?? '',
    })),
  }
}

export interface TemplateValuesValidation {
  ok: boolean
  faltando: { onde: 'cabecalho' | 'corpo'; exigidas: number; fornecidas: number }[]
}

/**
 * Confere se os valores cobrem as variáveis exigidas. A RPC de enfileiramento revalida a
 * contagem do corpo no banco — isto aqui é feedback de tela, não a barreira de segurança.
 */
export function validateTemplateValues(
  variaveis: TemplateVariables,
  valores: TemplatePreviewValues,
): TemplateValuesValidation {
  const faltando: TemplateValuesValidation['faltando'] = []
  const corpoExigidas = variaveis.corpo.length
  const corpoFornecidas = valores.corpo?.length ?? 0
  if (corpoFornecidas < corpoExigidas) {
    faltando.push({ onde: 'corpo', exigidas: corpoExigidas, fornecidas: corpoFornecidas })
  }
  const cabExigidas = variaveis.cabecalho.length
  const cabFornecidas = valores.cabecalho?.length ?? 0
  if (cabFornecidas < cabExigidas) {
    faltando.push({ onde: 'cabecalho', exigidas: cabExigidas, fornecidas: cabFornecidas })
  }
  return { ok: faltando.length === 0, faltando }
}
