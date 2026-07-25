import { NextResponse } from 'next/server'
import {
  requireGestaoSession,
  toErrorResponse,
  BadRequestError,
  NotFoundError,
} from '@/lib/whatsapp-oficial/api-auth'
import {
  WHATSAPP_OFICIAL_RATE_LIMITS,
  checkRateLimit,
  rateLimitResponse,
} from '@/lib/whatsapp-oficial/rate-limit'
import {
  TEMPLATE_MAX_TAMANHO_VALOR,
  TEMPLATE_MAX_VALORES,
  extractTemplateVariables,
  renderTemplatePreview,
  validateTemplateValues,
  type MetaTemplateComponentRaw,
  type TemplateButtonVariables,
  type TemplatePreviewValues,
  type TemplateVariables,
} from '@/lib/whatsapp-oficial/meta-templates'

/**
 * Preview textual de um template com as variáveis já substituídas.
 *
 * Rota puramente local: nenhuma chamada à Meta, nenhuma escrita. Serve para a
 * tela mostrar como a mensagem vai ficar ANTES de alguém enfileirar.
 *
 * A leitura usa o cliente COM SESSÃO — a RLS de `whatsapp_templates` decide o
 * que o chamador enxerga, e um template invisível responde 404 igualzinho a um
 * template inexistente (mesma escolha de `requireConversationAccess`).
 *
 * `validacao` aqui é feedback de tela, não barreira: quem recusa envio com
 * variável faltando é `whatsapp_oficial_enfileirar_template`, no banco.
 *
 * "Não escreve nada" NÃO quer dizer "de graça": o trabalho desta rota é
 * renderizar texto com valores que o chamador escolhe, e isso é CPU e memória
 * do processo — que é UM só, no Coolify. Daí o rate limit e os tetos de
 * entrada abaixo.
 */

interface PreviewBody {
  templateId?: unknown
  valores?: unknown
}

interface TemplateRow {
  id: string
  nome: string
  idioma: string
  status_aprovacao: string
  componentes: unknown
  variaveis: unknown
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** Aceita só `{corpo?: string[], cabecalho?: string[]}`. Um item não-string não
 *  pode ser "consertado" descartando: isso deslocaria {{2}} para o lugar de
 *  {{1}} e o preview mentiria sobre o que seria enviado. */
function parseValores(raw: unknown): TemplatePreviewValues {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestError('valores must be an object')
  }
  const obj = raw as Record<string, unknown>
  const valores: TemplatePreviewValues = {}
  if (obj.corpo !== undefined) {
    if (!isStringArray(obj.corpo)) throw new BadRequestError('valores.corpo must be string[]')
    valores.corpo = obj.corpo
  }
  if (obj.cabecalho !== undefined) {
    if (!isStringArray(obj.cabecalho)) {
      throw new BadRequestError('valores.cabecalho must be string[]')
    }
    valores.cabecalho = obj.cabecalho
  }
  return valores
}

/**
 * Recusa de entrada com slug estável (mesmo vocabulário das rotas de campanha):
 * o cliente trata "recusa de negócio" num lugar só.
 */
function unprocessable(slug: string, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ error: slug, ...extra }, { status: 422 })
}

/**
 * Tetos de entrada, iguais aos que `renderTemplateText` aplica internamente.
 *
 * Aqui a resposta é 422 em vez de truncar em silêncio de propósito: o render
 * corta valor acima de {@link TEMPLATE_MAX_TAMANHO_VALOR} e ignora o que passa
 * de {@link TEMPLATE_MAX_VALORES}, então um preview "bem-sucedido" com entrada
 * maior mostraria na tela um texto DIFERENTE do que seria enviado — o operador
 * aprovaria uma coisa e o cliente receberia outra.
 *
 * O segundo motivo é de custo: sem teto, um payload de cascata
 * (`{{2}}{{2}}`, `{{3}}{{3}}`, …) transforma um POST barato em trabalho grande
 * de string. O passe único de `renderTemplateText` já matou a explosão
 * exponencial na raiz, mas a rota não terceiriza o teto de ENTRADA para ele:
 * são invariantes de camadas diferentes e a de lá pode mudar.
 */
function recusarValoresAcimaDoTeto(valores: TemplatePreviewValues): NextResponse | null {
  for (const onde of ['corpo', 'cabecalho'] as const) {
    const lista = valores[onde]
    if (!lista) continue
    if (lista.length > TEMPLATE_MAX_VALORES) {
      return unprocessable('valores_demais', {
        onde,
        limite: TEMPLATE_MAX_VALORES,
        recebidos: lista.length,
      })
    }
    const posicao = lista.findIndex((v) => v.length > TEMPLATE_MAX_TAMANHO_VALOR)
    if (posicao >= 0) {
      return unprocessable('valor_muito_longo', {
        onde,
        // 1-indexado para casar com o `{{N}}` que o operador vê na tela.
        indice: posicao + 1,
        limite: TEMPLATE_MAX_TAMANHO_VALOR,
        recebidos: lista[posicao].length,
      })
    }
  }
  return null
}

function toIndices(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
}

function toBotoes(value: unknown): TemplateButtonVariables[] | null {
  if (!Array.isArray(value)) return null
  return value.map((raw, i) => {
    const b = (raw ?? {}) as Record<string, unknown>
    return {
      indice: typeof b.indice === 'number' ? b.indice : i,
      tipo: typeof b.tipo === 'string' ? b.tipo : '',
      variaveis: toIndices(b.variaveis) ?? [],
    }
  })
}

/**
 * A coluna `variaveis` é a fonte única — o banco a recalcula no sync e é ela
 * que a RPC de enfileiramento confere. Só derivamos de `componentes` quando a
 * coluna vem vazia (linha gravada antes da migration que passou a preenchê-la),
 * senão a tela validaria contra uma regra diferente da do envio.
 */
function resolverVariaveis(raw: unknown, componentes: MetaTemplateComponentRaw[]): TemplateVariables {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>
    const cabecalho = toIndices(obj.cabecalho)
    const corpo = toIndices(obj.corpo)
    const botoes = toBotoes(obj.botoes)
    if (cabecalho || corpo || botoes) {
      return { cabecalho: cabecalho ?? [], corpo: corpo ?? [], botoes: botoes ?? [] }
    }
  }
  return extractTemplateVariables(componentes)
}

export async function POST(request: Request): Promise<Response> {
  try {
    // Autenticar ANTES de validar o corpo, igual às rotas de campanha: quem não tem sessão não
    // deve descobrir o vocabulário do payload pela mensagem de erro.
    const { userId, supabaseUser } = await requireGestaoSession()

    const body = (await request.json().catch(() => null)) as PreviewBody | null
    const templateId = typeof body?.templateId === 'string' ? body.templateId.trim() : ''
    if (!templateId) throw new BadRequestError('templateId is required')
    const valores = parseValores(body?.valores)

    // Orçamento `campanhaWrite` (20/min), não `templateSync` (6/min): sync é
    // caro para TERCEIROS (queima a cota do WABA), então merece o orçamento
    // apertado; preview só custa CPU local e é acionado por quem está montando
    // a mensagem — 6/min quebraria um operador ajustando os valores, enquanto
    // 20/min ainda barra um script martelando payloads no tamanho máximo.
    const rl = checkRateLimit(
      `whatsapp-oficial-template-preview:${userId}`,
      WHATSAPP_OFICIAL_RATE_LIMITS.campanhaWrite,
    )
    if (!rl.success) return rateLimitResponse(rl)

    const acimaDoTeto = recusarValoresAcimaDoTeto(valores)
    if (acimaDoTeto) return acimaDoTeto

    const { data, error } = await supabaseUser
      .from('whatsapp_templates')
      .select('id, nome, idioma, status_aprovacao, componentes, variaveis')
      .eq('id', templateId)
      .maybeSingle()

    if (error) {
      console.error('[whatsapp-oficial/templates/preview] failed to read template:', error.message)
      return NextResponse.json({ error: 'template_lookup_failed' }, { status: 500 })
    }
    if (!data) throw new NotFoundError('Template not found')

    const template = data as TemplateRow
    const componentes = (
      Array.isArray(template.componentes) ? template.componentes : []
    ) as MetaTemplateComponentRaw[]
    const variaveis = resolverVariaveis(template.variaveis, componentes)

    return NextResponse.json({
      templateId: template.id,
      nome: template.nome,
      idioma: template.idioma,
      statusAprovacao: template.status_aprovacao,
      preview: renderTemplatePreview(componentes, valores),
      variaveis,
      validacao: validateTemplateValues(variaveis, valores),
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
