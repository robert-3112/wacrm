import { NextResponse } from 'next/server'
import {
  requireConversationAccess,
  toErrorResponse,
  BadRequestError,
} from '@/lib/whatsapp-oficial/api-auth'
import {
  WHATSAPP_OFICIAL_RATE_LIMITS,
  checkRateLimit,
  rateLimitResponse,
} from '@/lib/whatsapp-oficial/rate-limit'
import {
  TEMPLATE_MAX_TAMANHO_VALOR,
  TEMPLATE_MAX_VALORES,
} from '@/lib/whatsapp-oficial/meta-templates'

/**
 * Enfileira UM template aprovado numa conversa — o botão "enviar teste" e
 * também o envio 1:1 de template fora da janela de 24h.
 *
 * Nada sai daqui para a Meta. A RPC grava a mensagem + a linha da outbox numa
 * transação só; quem entrega (ou simula, em shadow) é o worker da outbox. Por
 * isso a resposta diz `enfileirado: true` e nunca "enviado": a palavra errada
 * na tela faz o corretor acreditar que o cliente já recebeu.
 *
 * Autorização em duas camadas, igual à rota de mensagem de texto:
 *  1. `requireConversationAccess` prova via RLS que o chamador vê a conversa
 *     (404 indistinguível de "não existe");
 *  2. `whatsapp_oficial_enfileirar_template` revalida ator/tenant/canal no
 *     Postgres e é quem recusa opt-out, canal inativo e template não aprovado.
 *
 * A camada 2 pode recusar o ATOR com 42501, e isso NÃO é caso raro: a policy de
 * `whatsapp_conversations` usa `crm_is_gestao()`, que inclui `lider`, então um
 * líder passa pela camada 1 e só é barrado no Postgres. Por isso o erro da RPC
 * é relançado (`throw error`) e não vira 500 genérico — `toErrorResponse`
 * traduz 42501 para 403.
 */

interface EnviarBody {
  conversationId?: unknown
  templateId?: unknown
  variaveis?: unknown
}

interface EnfileirarRpcResult {
  ok?: boolean
  reason?: string
  message_id?: string
  template_id?: string
  preview?: unknown
  [key: string]: unknown
}

/**
 * 409 = conflito de ESTADO (o pedido está bem formado, o mundo é que não
 * permite agora: opt-out, canal desligado, conversa encerrada, template ainda
 * não aprovado). 422 = a entrada é que está errada e reenviar igual não ajuda.
 */
const REASON_CONFLITO = new Set([
  'lead_optout_ou_inativo',
  'canal_inativo',
  'conversa_encerrada',
  'template_nao_aprovado',
  'template_de_outro_canal',
  'provider_sem_template',
])

function statusParaReason(reason: string | undefined): number {
  // A conversa foi vista pela RLS um instante antes; se a RPC não a acha, ela
  // sumiu no meio do caminho — 404 é mais honesto que "entrada inválida".
  if (reason === 'conversa_nao_encontrada') return 404
  if (reason && REASON_CONFLITO.has(reason)) return 409
  return 422
}

/** `variaveis` segue `SendTimeParams` e é validado pela RPC (que também
 *  recusa contagem insuficiente). Aqui só barramos o que nem é objeto —
 *  passar um array para um jsonb de chaves nomeadas seria erro de chamada. */
function parseVariaveis(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestError('variaveis must be an object')
  }
  return raw as Record<string, unknown>
}

/** Mesmo formato de recusa das rotas de campanha: slug estável + 422. */
function unprocessable(slug: string, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ error: slug, ...extra }, { status: 422 })
}

/**
 * Tetos de ENTRADA, os mesmos que `renderTemplateText` aplica.
 *
 * A RPC só confere a contagem MÍNIMA de variáveis ("faltou valor"), nunca a
 * máxima — e o render dela roda DENTRO da transação, no banco do CRM inteiro.
 * Sem esta barreira, um corretor com uma conversa própria (a autorização que
 * ele legitimamente tem) manda 30 valores em cascata e o custo cai sobre o
 * Postgres compartilhado, não sobre a sessão dele. O banco também ganhou um
 * teto de 4096 chars no render, mas depender só dele deixaria a defesa a uma
 * migration de distância de sumir.
 */
function recusarVariaveisAcimaDoTeto(variaveis: Record<string, unknown>): NextResponse | null {
  const body = variaveis.body
  if (Array.isArray(body)) {
    if (body.length > TEMPLATE_MAX_VALORES) {
      return unprocessable('valores_demais', {
        onde: 'body',
        limite: TEMPLATE_MAX_VALORES,
        recebidos: body.length,
      })
    }
    const posicao = body.findIndex(
      (v) => typeof v === 'string' && v.length > TEMPLATE_MAX_TAMANHO_VALOR,
    )
    if (posicao >= 0) {
      return unprocessable('valor_muito_longo', {
        onde: 'body',
        // 1-indexado para casar com o `{{N}}` que o operador vê na tela.
        indice: posicao + 1,
        limite: TEMPLATE_MAX_TAMANHO_VALOR,
        recebidos: (body[posicao] as string).length,
      })
    }
  }

  const headerText = variaveis.headerText
  if (typeof headerText === 'string' && headerText.length > TEMPLATE_MAX_TAMANHO_VALOR) {
    return unprocessable('valor_muito_longo', {
      onde: 'headerText',
      limite: TEMPLATE_MAX_TAMANHO_VALOR,
      recebidos: headerText.length,
    })
  }

  return null
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json().catch(() => null)) as EnviarBody | null
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : ''
    const templateId = typeof body?.templateId === 'string' ? body.templateId.trim() : ''

    if (!conversationId) throw new BadRequestError('conversationId is required')
    if (!templateId) throw new BadRequestError('templateId is required')
    const variaveis = parseVariaveis(body?.variaveis)

    const { userId, conversation, admin } = await requireConversationAccess(conversationId)

    const rl = checkRateLimit(
      `whatsapp-oficial-template-send:${userId}`,
      WHATSAPP_OFICIAL_RATE_LIMITS.messageSend,
    )
    if (!rl.success) return rateLimitResponse(rl)

    const acimaDoTeto = recusarVariaveisAcimaDoTeto(variaveis)
    if (acimaDoTeto) return acimaDoTeto

    const { data, error } = await admin.rpc('whatsapp_oficial_enfileirar_template', {
      p_conversation_id: conversation.id,
      p_template_id: templateId,
      p_variaveis: variaveis,
      p_actor_user_id: userId,
    })

    // 42501 (ator sem papel para enfileirar neste tenant) vira 403 no
    // `toErrorResponse` — a RPC é a autoridade e a rota só repassa. Qualquer
    // outro erro de banco continua virando 500 por lá mesmo, com o objeto
    // completo indo para o log do servidor em vez de para a tela.
    if (error) throw error

    const result = (data ?? {}) as EnfileirarRpcResult
    if (!result.ok || !result.message_id) {
      // `variaveis_insuficientes` vem com `exigidas`/`fornecidas`; repassamos
      // tudo que não seja o par ok/reason para a tela poder explicar o motivo.
      const detalhes: Record<string, unknown> = {}
      for (const [chave, valor] of Object.entries(result)) {
        if (chave !== 'ok' && chave !== 'reason') detalhes[chave] = valor
      }
      return NextResponse.json(
        { error: result.reason ?? 'template_enqueue_rejected', ...detalhes },
        { status: statusParaReason(result.reason) },
      )
    }

    return NextResponse.json(
      {
        ok: true,
        enfileirado: true,
        messageId: result.message_id,
        templateId: result.template_id ?? templateId,
        preview: result.preview ?? null,
      },
      { status: 201 },
    )
  } catch (error) {
    return toErrorResponse(error)
  }
}
