/**
 * Build the per-send Meta `components` array for an APPROVED template,
 * from a `whatsapp_templates.componentes` row.
 *
 * ADAPTED from `src/lib/whatsapp/template-send-builder.ts` (WACRM original
 * — harvest matrix area 2, classified "Adaptar": the shaping logic is
 * good, but it reads a WACRM `message_templates` row with columns split
 * out per-field (`header_type`, `body_text`, `buttons: TemplateButton[]`,
 * ...), account-scoped). The SUNT schema instead stores the whole
 * definition as a single `componentes jsonb` blob per
 * `whatsapp_templates` (tenant-scoped) — a mirror of Meta's own Template
 * GET response shape (`[{type:'HEADER'|'BODY'|'FOOTER'|'BUTTONS', ...}]`,
 * the same shape `src/lib/whatsapp/template-components.ts` builds for
 * template *creation*). This module re-implements the send-time shaping
 * against that array-of-components shape instead of WACRM's per-field row.
 *
 * Fase 7 (template sync engine, per `docs/WHATSAPP-OFFICIAL-ARCHITECTURE.md`
 * "O que ainda não existe") owns writing `componentes` from Meta's sync —
 * this module only consumes it at send time.
 */

/**
 * Um template APROVADO cuja forma este builder não sabe montar, ou um envio sem os
 * valores que o template exige. NÃO é erro transitório: tentar de novo dá o mesmo
 * resultado, sempre.
 *
 * `httpStatus = 422` existe por um motivo mecânico, não decorativo: `extractErrorInfo`
 * (outbox-worker.ts) lê `httpStatus` de qualquer objeto lançado, e `classifyMetaError`
 * (outbox.ts) trata `httpStatus >= 400` como PERMANENTE. Um `Error` pelado — que é o que
 * este arquivo lançava — não tem `httpStatus` nem `code`, então caía no último `return`
 * de `classifyMetaError`: `unknown_error_default_retryable`. Consequência medida numa
 * campanha de 500 destinatários com template de 3 variáveis: 500 jobs × 5 tentativas com
 * backoff de 30s a 6h = 2.500 ciclos de worker ao longo de horas, zero mensagem enviada,
 * e o operador lendo "erro transitório desconhecido" para um defeito determinístico.
 * Com 422 o job morre na primeira tentativa e `last_error_code` vira `http_422`.
 */
export class TemplateBuildError extends Error {
  readonly httpStatus = 422
  constructor(message: string) {
    super(message)
    this.name = 'TemplateBuildError'
  }
}

/**
 * Os quatro tipos de componente que este builder sabe traduzir para o payload de envio.
 * Lista POSITIVA de propósito: formato novo que a Meta lançar amanhã cai fora e é
 * recusado, em vez de ser descartado em silêncio.
 */
const TIPOS_SUPORTADOS = new Set(['HEADER', 'BODY', 'FOOTER', 'BUTTONS'])

export interface MetaTemplateComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS'
  format?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT'
  text?: string
  buttons?: MetaTemplateButton[]
  example?: {
    header_text?: string[]
    header_url?: string[]
    header_handle?: string[]
    body_text?: string[][]
  }
}

export interface MetaTemplateButton {
  type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER' | 'COPY_CODE'
  text: string
  url?: string
  phone_number?: string
  example?: string[]
}

export interface SendTimeParams {
  /** Values for body {{1}}, {{2}}, … indexed by variable position. */
  body?: string[]
  /** Value for a TEXT header's {{1}}, when present. */
  headerText?: string
  /** Override the media link for an IMAGE/VIDEO/DOCUMENT header. */
  headerMediaUrl?: string
  /** Alternative to headerMediaUrl: send by a previously-uploaded Meta media id. */
  headerMediaId?: string
  /** Per-button overrides keyed by the button's index in the BUTTONS component. */
  buttonParams?: Record<number, string>
}

export type MetaSendComponent =
  | { type: 'header'; parameters: MetaSendParameter[] }
  | { type: 'body'; parameters: MetaSendParameter[] }
  | {
      type: 'button'
      sub_type: 'url' | 'quick_reply' | 'copy_code'
      index: string
      parameters: MetaSendParameter[]
    }

type MetaSendParameter =
  | { type: 'text'; text: string }
  | { type: 'image'; image: { link?: string; id?: string } }
  | { type: 'video'; video: { link?: string; id?: string } }
  | { type: 'document'; document: { link?: string; id?: string } }
  | { type: 'coupon_code'; coupon_code: string }
  | { type: 'payload'; payload: string }

/** Extract sorted, deduplicated {{N}} indices — e.g. `[1, 2]` for `"Hi {{1}} {{2}}"`. */
function extractVariableIndices(text: string | undefined): number[] {
  if (!text) return []
  const set = new Set<number>()
  for (const m of text.matchAll(/\{\{(\d+)\}\}/g)) {
    const n = Number(m[1])
    if (Number.isFinite(n) && n >= 1) set.add(n)
  }
  return [...set].sort((a, b) => a - b)
}

function buildHeaderComponent(
  header: MetaTemplateComponent | undefined,
  params: SendTimeParams,
): MetaSendComponent | null {
  if (!header) return null

  if (header.format === 'TEXT' || !header.format) {
    const varCount = extractVariableIndices(header.text).length
    if (varCount === 0) return null
    if (!params.headerText || !params.headerText.trim()) {
      throw new TemplateBuildError('Header text variable {{1}} requires a value — pass headerText.')
    }
    return { type: 'header', parameters: [{ type: 'text', text: params.headerText }] }
  }

  // IMAGE / VIDEO / DOCUMENT — Meta requires the media component on every
  // send even when the media hasn't changed since approval. Prefer the
  // caller's override; fall back to the template's stored sample URL.
  const link = params.headerMediaUrl ?? header.example?.header_url?.[0]
  const id = params.headerMediaId
  if (!link && !id) {
    throw new TemplateBuildError(
      `${header.format} header requires a media link or id at send time — pass headerMediaUrl or headerMediaId.`,
    )
  }
  const media: { link?: string; id?: string } = id ? { id } : { link }
  const parameter: MetaSendParameter =
    header.format === 'IMAGE'
      ? { type: 'image', image: media }
      : header.format === 'VIDEO'
        ? { type: 'video', video: media }
        : { type: 'document', document: media }
  return { type: 'header', parameters: [parameter] }
}

function buildBodyComponent(
  body: MetaTemplateComponent | undefined,
  params: SendTimeParams,
): MetaSendComponent | null {
  if (!body) return null
  const varCount = extractVariableIndices(body.text).length
  const values = params.body ?? []
  if (varCount === 0 && values.length === 0) return null
  if (values.length < varCount) {
    throw new TemplateBuildError(
      `Body has ${varCount} variable(s) but only ${values.length} value(s) were supplied.`,
    )
  }
  return {
    type: 'body',
    parameters: values.slice(0, varCount).map((text) => ({ type: 'text', text: String(text) })),
  }
}

function buttonNeedsSendParam(button: MetaTemplateButton, override: string | undefined): boolean {
  switch (button.type) {
    case 'URL':
      return extractVariableIndices(button.url).length > 0
    case 'COPY_CODE':
      // Always emit a param so the customer gets a real code — either the
      // caller's override or the template's approved example.
      return true
    case 'QUICK_REPLY':
    case 'PHONE_NUMBER':
      return override !== undefined
  }
}

function buildButtonComponent(
  button: MetaTemplateButton,
  index: number,
  override: string | undefined,
): MetaSendComponent | null {
  if (!buttonNeedsSendParam(button, override)) return null

  switch (button.type) {
    case 'URL': {
      if (!override || !override.trim()) {
        throw new TemplateBuildError(
          `URL button #${index + 1} uses {{1}} — requires a buttonParams[${index}] value.`,
        )
      }
      return {
        type: 'button',
        sub_type: 'url',
        index: String(index),
        parameters: [{ type: 'text', text: override }],
      }
    }
    case 'COPY_CODE': {
      const code = override?.trim() || button.example?.[0]
      if (!code) {
        throw new TemplateBuildError(
          `COPY_CODE button #${index + 1} has no code (override or template example).`,
        )
      }
      return {
        type: 'button',
        sub_type: 'copy_code',
        index: String(index),
        parameters: [{ type: 'coupon_code', coupon_code: code }],
      }
    }
    case 'QUICK_REPLY':
      return {
        type: 'button',
        sub_type: 'quick_reply',
        index: String(index),
        parameters: [{ type: 'payload', payload: override! }],
      }
    case 'PHONE_NUMBER':
      // Never accepts send-time params per Meta's spec.
      return null
  }
}

/**
 * Build the full send-time `components` array from a template's stored
 * `componentes` (Meta's definition shape) plus per-send variable values.
 * Returns `[]` for a fully static template (valid Meta request — the
 * template name + language alone are enough).
 */
export function buildSendComponents(
  componentes: MetaTemplateComponent[],
  params: SendTimeParams = {},
): MetaSendComponent[] {
  // `componentes` chega como jsonb do banco, gravado VERBATIM pelo sync. O tipo
  // `MetaTemplateComponent` acima some em runtime — não há zod nem validação no caminho,
  // então a única barreira real é esta.
  if (!Array.isArray(componentes)) {
    throw new TemplateBuildError(
      `Template componentes must be an array (got ${typeof componentes}) — the stored template is malformed.`,
    )
  }

  // Recusa ANTES de montar qualquer coisa. Sem isto, um componente que este builder não
  // conhece era simplesmente ignorado pelos três `find()` abaixo — e o envio saía
  // mutilado em vez de falhar.
  //
  // Medido contra a Graph API real (2026-07-29): o template de carrossel da Meta tem
  // [BODY, BUTTONS, CAROUSEL], nenhum com variável. Os `find()` achavam BODY e BUTTONS,
  // nenhum dos dois exigia parâmetro, o retorno era `[]`, e `meta-api.ts` OMITE a chave
  // `components` quando o array é vazio — o POST saía como `{name, language}` puro, sem
  // os cards que são a razão de existir do template. Numa campanha de 500, isso vira
  // 500 chamadas reais à Meta com payload quebrado, e rajada concentrada de recusa é
  // exatamente o que derruba o quality rating do número.
  //
  // Recusar não implementa carrossel — implementar é grande (card_index, mídia por card,
  // extração de variáveis descendo em cards[].components[], mais UI). Recusar troca
  // "quebra em massa e silenciosa" por "não dá para usar, e diz por quê".
  const naoSuportado = componentes.find(
    (c) => !TIPOS_SUPORTADOS.has(String(c?.type ?? '').toUpperCase()),
  )
  if (naoSuportado) {
    throw new TemplateBuildError(
      `Template component "${naoSuportado.type}" is not supported by this sender ` +
        `(supported: ${[...TIPOS_SUPORTADOS].join(', ')}). ` +
        'Sending it would silently drop that component and deliver a mutilated message.',
    )
  }

  const out: MetaSendComponent[] = []

  const header = componentes.find((c) => c.type === 'HEADER')
  const headerComponent = buildHeaderComponent(header, params)
  if (headerComponent) out.push(headerComponent)

  const body = componentes.find((c) => c.type === 'BODY')
  const bodyComponent = buildBodyComponent(body, params)
  if (bodyComponent) out.push(bodyComponent)

  const buttonsBlock = componentes.find((c) => c.type === 'BUTTONS')
  if (buttonsBlock?.buttons?.length) {
    buttonsBlock.buttons.forEach((btn, i) => {
      const override = params.buttonParams?.[i]
      const component = buildButtonComponent(btn, i, override)
      if (component) out.push(component)
    })
  }

  return out
}
