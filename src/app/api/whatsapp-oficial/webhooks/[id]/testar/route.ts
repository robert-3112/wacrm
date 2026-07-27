import { NextResponse } from 'next/server'
import { requireGestaoSession, toErrorResponse, NotFoundError } from '@/lib/whatsapp-oficial/api-auth'
import {
  WHATSAPP_OFICIAL_RATE_LIMITS,
  checkRateLimit,
  rateLimitResponse,
} from '@/lib/whatsapp-oficial/rate-limit'
import {
  EVENTO_PING,
  WebhookSecretMissingError,
  deliverWebhook,
  loadWebhookSecret,
} from '@/lib/whatsapp-oficial/outbound-webhooks'

/**
 * Dispara um `ping` ASSINADO para a URL inscrita e devolve o que o destino
 * respondeu. É a ÚNICA rota deste subsistema que faz request externo por ação
 * humana — todo o resto passa pela fila e pelo worker.
 *
 * Por que ela existe: sem um botão de teste, o operador só descobre que errou
 * a URL (ou que o n8n exige um header a mais) quando um evento de verdade se
 * perde na fila e vira dead-letter horas depois.
 *
 * AUTORIZAÇÃO PELA RLS, sem RPC nova. A leitura do webhook é feita com o
 * cliente COM SESSÃO, e a policy de SELECT de `whatsapp_outbound_webhooks` já
 * exige `crm_is_admin_gestor()` no tenant dono da linha. Se a leitura devolveu
 * a linha, o chamador é gestão daquele tenant — mesma prova de acesso que
 * `requireConversationAccess` usa para o inbox. Linha invisível e linha
 * inexistente dão 404 igual, de propósito.
 *
 * O `ping` NÃO passa pela fila e NÃO é um evento inscritível: quem chamou está
 * olhando para a resposta agora, então enfileirar só atrasaria o diagnóstico.
 * Por isso ele também não aparece em `WEBHOOK_EVENTOS`.
 *
 * A resposta devolve `ok:false` com HTTP 200 quando o DESTINO falha: o request
 * de diagnóstico funcionou, quem não respondeu foi o outro lado. Erro do lado
 * de cá (sem segredo, sem chave de criptografia) é 503.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Mais curto que o do worker: aqui tem um humano esperando a tela responder. */
const TIMEOUT_MS = 8_000

interface WebhookRow {
  id: string
  tenant_id: string
  url: string
  ativo: boolean
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params
    const { userId, supabaseUser, admin } = await requireGestaoSession()

    // Orçamento apertado de propósito — reusa o bucket do sync de templates,
    // que existe pela mesma razão: é o outro botão desta área que dispara
    // request externo. 6/min é folgado para um humano clicando "testar" e
    // impede que a rota vire um relay de tráfego para terceiros.
    const rl = checkRateLimit(
      `whatsapp-oficial-webhooks-testar:${userId}`,
      WHATSAPP_OFICIAL_RATE_LIMITS.templateSync,
    )
    if (!rl.success) return rateLimitResponse(rl)

    if (!UUID_RE.test(id)) throw new NotFoundError('Webhook não encontrado')

    const { data, error } = await supabaseUser
      .from('whatsapp_outbound_webhooks')
      .select('id, tenant_id, url, ativo')
      .eq('id', id)
      .maybeSingle()

    if (error) {
      console.error('[whatsapp-oficial/webhooks/testar] falha ao ler a inscrição:', error.message)
      throw new NotFoundError('Webhook não encontrado')
    }
    if (!data) throw new NotFoundError('Webhook não encontrado')

    const webhook = data as WebhookRow
    if (!webhook.ativo) {
      return NextResponse.json({ error: 'webhook_inativo' }, { status: 409 })
    }

    let segredo: string
    try {
      segredo = await loadWebhookSecret(admin, webhook.id)
    } catch (err) {
      if (err instanceof WebhookSecretMissingError) {
        // Cobre os dois casos de configuração: coluna sem segredo e segredo que
        // não decifra (ENCRYPTION_KEY ausente ou trocada). Nenhum é bug de
        // código, e nenhum é recuperável sozinho — por isso 503, e não 500.
        return NextResponse.json({ error: 'webhook_sem_segredo_utilizavel' }, { status: 503 })
      }
      throw err
    }

    const tentativa = await deliverWebhook({
      url: webhook.url,
      secret: segredo,
      evento: EVENTO_PING,
      // Só identificadores: um ping não tem por que carregar dado de lead.
      payload: {
        teste: true,
        webhook_id: webhook.id,
        tenant_id: webhook.tenant_id,
        solicitado_por: userId,
      },
      timeoutMs: TIMEOUT_MS,
    })

    // `tentativa.erro` já sai redigido de `deliverWebhook`; o segredo nunca
    // entra na resposta, nem quando o destino ecoa o que recebeu.
    return NextResponse.json({
      ok: tentativa.ok,
      evento: EVENTO_PING,
      http_status: tentativa.httpStatus,
      ...(tentativa.erro ? { erro: tentativa.erro } : {}),
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
