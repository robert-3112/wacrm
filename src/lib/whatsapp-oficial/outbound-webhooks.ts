import crypto from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

import { decryptToken } from './crypto'

/**
 * Outbound webhooks assinados (Sessão 3, Frente B) — o Hub avisando sistemas
 * externos (n8n, principalmente) de que algo aconteceu no canal oficial.
 *
 * ESCRITO DO ZERO. O fork WACRM não tem nada equivalente: `webhook-signature.ts`
 * daqui VERIFICA a assinatura que a Meta manda para o Hub; este módulo faz o
 * caminho oposto e ASSINA o que o Hub manda para fora. Os dois lados usam
 * HMAC-SHA256, e é só isso que têm em comum.
 *
 * ── O QUE VAI NO PAYLOAD (decisão, não detalhe de implementação) ────────────
 * Identificadores e metadados. NUNCA o conteúdo integral da mensagem nem o
 * telefone completo do lead.
 *
 * Motivo: a URL inscrita é um sistema de terceiros fora do nosso controle de
 * acesso — o que sai daqui sai para sempre, sem escopo, sem revogação, sem
 * trilha do lado de lá. Quem precisa do conteúdo busca na `/api/v1` com a
 * chave dele, onde o escopo (`messages:read`) é conferido a cada chamada e a
 * chave pode ser revogada. O guarda técnico está no banco: a RPC
 * `whatsapp_oficial_webhook_enfileirar` recusa payload acima de 8 KB, porque
 * metadado não passa disso e corpo de mensagem passa.
 *
 * ── ASSINATURA ──────────────────────────────────────────────────────────────
 *   x-sunt-signature: sha256=<hex>   HMAC-SHA256 de `${timestamp}.${body}`
 *   x-sunt-timestamp: <epoch em segundos>
 *   x-sunt-event:     <nome do evento>
 *   x-sunt-delivery:  <id da entrega>  (para o integrador deduplicar retry)
 *
 * A assinatura cobre `timestamp.body`, e não só o body, por causa de replay:
 * assinando só o corpo, quem capturasse UMA entrega poderia reenviá-la
 * indefinidamente para o mesmo endpoint com uma assinatura eternamente válida.
 * Com o timestamp dentro do HMAC, mexer nele invalida a assinatura, e o
 * receptor pode recusar tudo que for velho demais (`toleranceSeconds`).
 * Convenção idêntica à do Stripe/Slack, de propósito: é o que qualquer
 * integrador já sabe implementar.
 *
 * `verifyOutboundSignature` é exportada para o integrador ter a referência
 * exata do que precisa reproduzir — e para o teste provar simetria com
 * `signOutboundPayload` em vez de repetir a fórmula em dois lugares.
 *
 * ── O SEGREDO ───────────────────────────────────────────────────────────────
 * Só existe em três lugares: cifrado no banco, em memória durante a assinatura,
 * e uma única vez no retorno da rota que criou a inscrição. Ele NUNCA entra em
 * payload, em header que não seja o digest, em log ou em mensagem de erro —
 * `redigirSegredo` passa em cima de toda string que este módulo devolve, como
 * rede de segurança contra um erro de terceiro que ecoe o que recebeu.
 *
 * ── TRAVAS DE WHATSAPP ──────────────────────────────────────────────────────
 * Não se aplicam. Webhook de saída fala com SISTEMA, não com cliente: não
 * consome janela de 24h, não passa por opt-out, não conta no teto diário e não
 * depende do kill switch de broadcast. O que ele respeita é a inscrição estar
 * ativa — checado no `claim`, no banco.
 */

/**
 * Vocabulário fechado, espelho do CHECK
 * `whatsapp_outbound_webhooks_eventos_validos` (migration
 * 20260726110000). Inscrever-se em algo fora desta lista é recusado pelo banco
 * — um nome errado viraria uma assinatura que nunca dispara, e ninguém
 * descobre um webhook mudo olhando para ele.
 *
 * `ping` NÃO está aqui de propósito: ping não passa pela fila, é disparado
 * direto pela rota `/webhooks/{id}/testar`.
 */
export const WEBHOOK_EVENTOS = [
  'mensagem.recebida',
  'mensagem.status',
  'conversa.aberta',
  'conversa.encerrada',
  'conversa.handoff',
  'conversa.optout',
  'campanha.concluida',
] as const

export type WebhookEvento = (typeof WEBHOOK_EVENTOS)[number]

export const EVENTO_PING = 'ping'

export const SIGNATURE_HEADER = 'x-sunt-signature'
export const TIMESTAMP_HEADER = 'x-sunt-timestamp'
export const EVENT_HEADER = 'x-sunt-event'
export const DELIVERY_HEADER = 'x-sunt-delivery'

/** Um POST de webhook é uma notificação, não um RPC: se o destino demora, é problema dele. */
const DEFAULT_TIMEOUT_MS = 10_000
/** Só lemos a resposta para pôr um trecho no erro. Além disso é banda jogada fora. */
const DEFAULT_MAX_RESPONSE_BYTES = 2_048
/** Janela padrão de aceitação do timestamp no lado de quem recebe. */
const DEFAULT_TOLERANCE_SECONDS = 300

const USER_AGENT = 'SUNT-WhatsApp-Hub/1 (+outbound-webhook)'

export function isWebhookEvento(valor: unknown): valor is WebhookEvento {
  return typeof valor === 'string' && (WEBHOOK_EVENTOS as readonly string[]).includes(valor)
}

// ---------------------------------------------------------------- assinatura

/**
 * `sha256=<hex>` do HMAC-SHA256 de `${timestamp}.${body}` com o segredo da
 * inscrição. O `timestamp` é epoch em SEGUNDOS (não milissegundos) — é o que
 * vai no header, e o que o receptor tem em mãos para recalcular.
 */
export function signOutboundPayload(
  secret: string,
  timestamp: number | string,
  body: string,
): string {
  const digest = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex')
  return `sha256=${digest}`
}

export interface VerifyOutboundSignatureInput {
  secret: string
  body: string
  timestamp: string | number | null | undefined
  signature: string | null | undefined
  /** 0 desliga a checagem de frescor (útil para reprocessar uma entrega antiga). */
  toleranceSeconds?: number
  now?: Date
}

/**
 * Verificação de referência, para o integrador copiar e para o teste provar
 * simetria com {@link signOutboundPayload}.
 *
 * Fail-closed em tudo: segredo vazio, header ausente, prefixo errado,
 * timestamp não numérico e assinatura de tamanho diferente devolvem `false`
 * antes de qualquer comparação. O comparativo final é `timingSafeEqual` — um
 * `===` aqui vaza, byte a byte pelo tempo de resposta, quanto do digest o
 * atacante já acertou.
 */
export function verifyOutboundSignature(input: VerifyOutboundSignatureInput): boolean {
  const {
    secret,
    body,
    timestamp,
    signature,
    toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
    now = new Date(),
  } = input

  if (!secret) return false
  if (typeof signature !== 'string' || !signature.startsWith('sha256=')) return false
  if (timestamp === null || timestamp === undefined || timestamp === '') return false

  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || !Number.isInteger(ts)) return false

  if (toleranceSeconds > 0) {
    const agora = Math.floor(now.getTime() / 1000)
    // Math.abs cobre os dois lados: relógio adiantado do emissor é tão
    // suspeito quanto entrega velha demais.
    if (Math.abs(agora - ts) > toleranceSeconds) return false
  }

  const esperada = signOutboundPayload(secret, ts, body)
  const a = Buffer.from(signature)
  const b = Buffer.from(esperada)
  // timingSafeEqual lança se os tamanhos diferem.
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export interface OutboundEnvelope {
  evento: string
  delivery_id: string | null
  enviado_em: string
  dados: unknown
}

/** O corpo exato que é assinado e enviado. Separado para o teste poder assiná-lo de fora. */
export function buildOutboundEnvelope(input: {
  evento: string
  payload: unknown
  deliveryId?: string | null
  now?: Date
}): OutboundEnvelope {
  return {
    evento: input.evento,
    delivery_id: input.deliveryId ?? null,
    enviado_em: (input.now ?? new Date()).toISOString(),
    dados: input.payload ?? {},
  }
}

export function buildOutboundHeaders(input: {
  secret: string
  evento: string
  body: string
  deliveryId?: string | null
  now?: Date
}): Record<string, string> {
  const timestamp = Math.floor((input.now ?? new Date()).getTime() / 1000)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
    [EVENT_HEADER]: input.evento,
    [TIMESTAMP_HEADER]: String(timestamp),
    [SIGNATURE_HEADER]: signOutboundPayload(input.secret, timestamp, input.body),
  }
  if (input.deliveryId) headers[DELIVERY_HEADER] = input.deliveryId
  return headers
}

// ------------------------------------------------------------------- entrega

/**
 * Surrogate desemparelhado — alto sem baixo em seguida, ou baixo sem alto antes.
 * Uma string JS pode carregar isso (UTF-16 permite), mas ele NÃO é representável
 * em UTF-8: o `JSON.stringify` do supabase-js manda `\ud83d` cru e o Postgres
 * recusa o corpo inteiro. Meio caractere na tela de gestão é preço baratíssimo
 * perto de uma escrita que falha.
 */
const SURROGATE_SOLTO = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/**
 * Rede de segurança: mesmo que um destino mal-educado ecoe o header de
 * assinatura no corpo do erro, o segredo não sai deste módulo dentro de uma
 * string. Custa um `split/join` por entrega com falha.
 */
function redigirSegredo(texto: string, secret: string): string {
  if (!secret) return texto
  return texto.split(secret).join('[redigido]')
}

/**
 * Corta controle/quebra de linha e limita o tamanho — isto vai parar em
 * `whatsapp_webhook_deliveries.last_error_message`, que um humano lê na tela de gestão.
 * Um destino que responda HTML gigante, binário ou cheio de quebra de linha não pode
 * sujar a trilha nem empurrar o começo do erro para fora da tela.
 *
 * O CORTE É POR CODE POINT, não por unidade UTF-16, e este detalhe já custou um
 * defeito: `.slice(0, 200)` conta unidades UTF-16, então um emoji do destino
 * caindo exatamente na borda era partido no meio do par surrogate. A metade que
 * sobrava não é representável em UTF-8; o Postgres recusava o texto,
 * `registrarResultado` lançava, o catch genérico devolvia a linha para
 * 'processando' com `attempts` INALTERADO, o lease expirava, outro tique
 * reivindicava, recebia a MESMA resposta e falhava igual — POST repetido no
 * destino a cada dois minutos, para sempre, sem tentativa contabilizada e sem
 * dead-letter.
 *
 * O `replace` final é cinto e suspensório: pega surrogate solto que tenha vindo
 * do próprio destino, e não do nosso corte. NUL (que o Postgres também recusa em
 * `text`, mesmo sendo UTF-8 válido) já cai na faixa de controle da primeira
 * linha — está coberto por teste para ninguém "otimizar" a faixa e reabrir isso.
 */
function limparTrecho(texto: string, max = 200): string {
  const semControle = texto.replace(/[\u0000-\u001f\u007f]+/g, ' ')
  const normalizado = semControle.replace(/\s+/g, ' ').trim()
  // Array.from itera por CODE POINT; fatiar o array nunca parte um par surrogate.
  const pontos = Array.from(normalizado)
  const cortado = pontos.length > max ? pontos.slice(0, max).join('') : normalizado
  return cortado.replace(SURROGATE_SOLTO, '')
}

/**
 * Lê no máximo `maxBytes` do corpo da resposta e CANCELA o resto.
 *
 * `response.text()` puro é ilimitado: um destino hostil (ou só quebrado) que
 * respondesse um stream infinito seguraria o worker e comeria memória do
 * processo até o container morrer. Aqui a leitura para no teto e o
 * `reader.cancel()` libera a conexão.
 */
async function lerCorpoLimitado(response: Response, maxBytes: number): Promise<string> {
  const stream = response.body
  if (!stream) return ''
  const reader = stream.getReader()
  const pedacos: Uint8Array[] = []
  let total = 0
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength > 0) {
        pedacos.push(value)
        total += value.byteLength
      }
    }
  } catch {
    // Corpo truncado por erro de rede não é o erro que interessa reportar —
    // o status HTTP já foi lido e é ele que classifica a entrega.
  } finally {
    await reader.cancel().catch(() => {})
  }
  if (pedacos.length === 0) return ''
  return Buffer.concat(pedacos.map((p) => Buffer.from(p)))
    .subarray(0, maxBytes)
    .toString('utf8')
}

export interface DeliverWebhookInput {
  url: string
  secret: string
  evento: string
  payload: unknown
  deliveryId?: string | null
  timeoutMs?: number
  maxResponseBytes?: number
  now?: Date
  fetchImpl?: typeof fetch
}

export interface DeliveryAttemptResult {
  ok: boolean
  httpStatus: number | null
  /** Slug curto + trecho, já redigido. `null` quando deu certo. */
  erro: string | null
}

/**
 * Uma tentativa de POST assinado. NUNCA lança: qualquer falha vira
 * `{ ok: false, ... }` para o chamador registrar na fila — um throw aqui
 * deixaria a entrega presa em `processando` até o lease expirar.
 *
 * Não escreve log. A URL de destino pode carregar token no path (é comum em
 * webhook de n8n), então nem ela nem o segredo entram em `console.*` daqui;
 * quem quiser depurar tem a trilha em `whatsapp_webhook_deliveries`, que é
 * protegida por RLS.
 */
export async function deliverWebhook(
  input: DeliverWebhookInput,
): Promise<DeliveryAttemptResult> {
  const {
    url,
    secret,
    evento,
    payload,
    deliveryId = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    now = new Date(),
    fetchImpl = globalThis.fetch,
  } = input

  const body = JSON.stringify(buildOutboundEnvelope({ evento, payload, deliveryId, now }))
  const headers = buildOutboundHeaders({ secret, evento, body, deliveryId, now })

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
      // NÃO seguir redirect: um 302 faria o Hub reenviar o payload ASSINADO
      // para um destino que ninguém inscreveu, escolhido por quem controla o
      // endpoint. Um 3xx vira falha comum (`http_302`), visível na trilha.
      redirect: 'manual',
    })
  } catch (err) {
    const nome = err instanceof Error ? err.name : ''
    // AbortSignal.timeout dispara TimeoutError; um abort externo, AbortError.
    if (nome === 'TimeoutError' || nome === 'AbortError') {
      return { ok: false, httpStatus: null, erro: `timeout_${timeoutMs}ms` }
    }
    const mensagem = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      httpStatus: null,
      erro: redigirSegredo(limparTrecho(`erro_de_rede: ${mensagem}`), secret),
    }
  }

  const trecho = await lerCorpoLimitado(response, maxResponseBytes)

  if (!response.ok) {
    const detalhe = trecho ? `: ${limparTrecho(trecho)}` : ''
    return {
      ok: false,
      httpStatus: response.status,
      erro: redigirSegredo(limparTrecho(`http_${response.status}${detalhe}`, 240), secret),
    }
  }

  return { ok: true, httpStatus: response.status, erro: null }
}

// ------------------------------------------------------------------ segredo

/**
 * A inscrição não tem segredo utilizável. Condição PERMANENTE — só um humano
 * reinscrevendo o endpoint resolve — e deliberadamente distinta de uma falha
 * de LEITURA do banco (essa vira `Error` comum, tratada como transitória, com
 * a entrega devolvida ao lease). Confundir as duas faria um soluço do Supabase
 * matar entregas perfeitamente válidas.
 *
 * Cobre os dois casos irrecuperáveis: coluna nula e ciphertext que não decifra
 * (chave trocada, valor corrompido). Nos dois, assinar é impossível.
 */
export class WebhookSecretMissingError extends Error {
  constructor(message = 'webhook_secret_missing') {
    super(message)
    this.name = 'WebhookSecretMissingError'
  }
}

export async function loadWebhookSecret(
  admin: SupabaseClient,
  webhookId: string,
): Promise<string> {
  const { data, error } = await admin
    .from('whatsapp_outbound_webhooks')
    .select('segredo_cifrado')
    .eq('id', webhookId)
    .maybeSingle()

  if (error) {
    throw new Error(`failed to read webhook secret: ${error.message ?? 'unknown error'}`)
  }

  const cifrado = (data as { segredo_cifrado?: unknown } | null)?.segredo_cifrado
  if (typeof cifrado !== 'string' || cifrado.length === 0) {
    throw new WebhookSecretMissingError()
  }

  try {
    const plano = decryptToken(cifrado)
    if (!plano) throw new WebhookSecretMissingError()
    return plano
  } catch (err) {
    if (err instanceof WebhookSecretMissingError) throw err
    // A mensagem original pode carregar detalhe do ciphertext; não propagar.
    throw new WebhookSecretMissingError('webhook_secret_undecryptable')
  }
}

// -------------------------------------------------------------------- worker

export interface WebhookDeliveryJob {
  delivery_id: string
  tenant_id: string
  webhook_id: string
  evento: string
  payload: unknown
  attempts: number
  max_attempts: number
  url: string
}

export interface WebhookDeliveryOutcome {
  deliveryId: string
  ok: boolean
  httpStatus: number | null
  status: string
  erro?: string
}

export interface ProcessWebhookDeliveriesResult {
  claimed: number
  delivered: number
  retried: number
  deadLettered: number
  /**
   * Reivindicadas que NÃO couberam no lease e ficaram para o próximo tique.
   * Continuam 'processando' até o lease expirar — o claim as recupera sozinho
   * (é o mesmo caminho de um worker que morreu). Número teimosamente > 0 aqui
   * significa lote grande demais para o lease: baixe `limit` ou suba
   * `leaseSeconds`, nesta ordem.
   */
  remaining: number
  outcomes: WebhookDeliveryOutcome[]
}

export interface ProcessWebhookDeliveriesOpts {
  admin: SupabaseClient
  workerId: string
  limit?: number
  leaseSeconds?: number
  timeoutMs?: number
  now?: Date
  fetchImpl?: typeof fetch
  /**
   * Relógio monotônico do orçamento de lease, injetável só para o teste
   * conseguir provar a parada sem esperar segundos de verdade. Distinto de
   * `now`, que é o carimbo ASSINADO na entrega.
   */
  nowMs?: () => number
}

/**
 * Folga entre o fim da última entrega e o vencimento do lease. Cobre o
 * `registrarResultado` que ainda vai rodar, o jitter da rede até o Supabase e a
 * diferença de relógio entre o processo e o banco. Dois segundos é generoso
 * para uma chamada de RPC e barato: no pior caso o lote entrega uma a menos.
 */
const LEASE_MARGEM_MS = 2_000

/**
 * Teto que `whatsapp_oficial_webhook_claim` aplica em `p_lease_seconds` (o banco
 * faz `least(greatest(coalesce(p_lease_seconds,120),30),3600)`). O orçamento tem
 * que usar o lease REAL, não o pedido: pedir 5000 e receber 3600 do banco, e
 * então orçar 5000, estouraria exatamente o prazo que esta conta existe para
 * respeitar. O piso de 30s do banco não precisa ser espelhado — orçar MENOS que
 * o lease real só desperdiça uma entrega, nunca duplica.
 */
const LEASE_MAX_SEGUNDOS_NO_BANCO = 3_600

/** Mensagem fixa, ASCII puro e curta. Ver `registrarComSegundaChance`. */
const ERRO_AO_REGISTRAR = 'erro_ao_registrar'

function resultadoVazio(): ProcessWebhookDeliveriesResult {
  return { claimed: 0, delivered: 0, retried: 0, deadLettered: 0, remaining: 0, outcomes: [] }
}

/**
 * Drena um lote da fila: `whatsapp_oficial_webhook_claim` reivindica, cada
 * entrega é assinada e enviada, e o resultado volta por
 * `whatsapp_oficial_webhook_registrar_resultado` (que é quem incrementa
 * tentativa, agenda o backoff e decide dead-letter — a política de retry mora
 * no banco, não aqui).
 *
 * UMA ENTREGA QUE FALHA NÃO IMPEDE AS OUTRAS. Cada job roda no próprio
 * try/catch: destino fora do ar, segredo ilegível ou exceção inesperada só
 * afetam aquela linha. Um laço que aborta no primeiro erro deixaria toda a
 * fila parada atrás do endpoint mais quebrado — que é justamente o endpoint
 * que mais gera falha.
 *
 * O segredo é carregado no máximo uma vez por inscrição por lote (cache local,
 * descartado ao fim da função): dez entregas para o mesmo n8n não precisam de
 * dez leituras + dez decifragens.
 *
 * Cada entrega é assinada com o RELÓGIO DO MOMENTO, não com o horário em que o
 * lote começou. Um lote de 100 entregas com destinos lentos leva minutos; se
 * todas carregassem o timestamp inicial, as últimas chegariam ao receptor já
 * fora da janela de frescor dele e seriam recusadas por "replay" — uma falha
 * que só aparece em produção, sob carga, e parece problema do integrador.
 * `opts.now` fixo existe para o teste conseguir um resultado determinístico.
 *
 * O LAÇO OLHA O RELÓGIO ANTES DE CADA ENTREGA. O lease é o que impede dois
 * workers de processarem a mesma linha, e ele é uma promessa com prazo: 20
 * entregas sequenciais de até 10s cada são 200s, contra um lease padrão de 120s.
 * Sem esta checagem, a partir da décima segunda entrega o worker está POSTando
 * uma linha que outro tique já reivindicou — POST duplicado no destino e
 * `attempts` incrementado duas vezes por ciclo real, o que leva a entrega ao
 * dead-letter em duas ou três tentativas em vez das cinco contratadas. Quando o
 * orçamento acaba o lote para e o que sobrou volta pelo próprio lease, contado
 * em `remaining` — subir o lease às cegas trocaria a duplicata por uma fila que
 * demora mais para se recuperar de um worker morto.
 */
export async function processWebhookDeliveryBatch(
  opts: ProcessWebhookDeliveriesOpts,
): Promise<ProcessWebhookDeliveriesResult> {
  const {
    admin,
    workerId,
    limit = 10,
    leaseSeconds = 120,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    now: horaFixa,
    fetchImpl,
    nowMs = () => Date.now(),
  } = opts

  // Marcado ANTES do claim de propósito: o banco carimba `claimed_at` no meio da
  // RPC, então nosso início nunca é posterior ao dele. Errar para o lado
  // conservador é o que faz a folga ser real e não teórica.
  const inicioLote = nowMs()

  const { data, error } = await admin.rpc('whatsapp_oficial_webhook_claim', {
    p_worker_id: workerId,
    p_limit: limit,
    p_lease_seconds: leaseSeconds,
  })
  if (error) throw error

  const claim = data as { ok?: boolean; claimed?: WebhookDeliveryJob[] } | null
  if (!claim || claim.ok !== true) return resultadoVazio()

  const jobs = claim.claimed ?? []
  const resultado = resultadoVazio()
  resultado.claimed = jobs.length

  const leaseEfetivo = Math.min(leaseSeconds, LEASE_MAX_SEGUNDOS_NO_BANCO)
  const prazoLote = inicioLote + leaseEfetivo * 1000 - LEASE_MARGEM_MS
  const segredos = new Map<string, string>()

  for (const [indice, job] of jobs.entries()) {
    // A PRIMEIRA sempre roda, mesmo com o orçamento já estourado: um lease curto
    // demais para uma única entrega faria todo tique reivindicar e desistir, e a
    // fila nunca andaria — pior do que a duplicata que esta checagem evita.
    if (indice > 0 && nowMs() + timeoutMs > prazoLote) {
      resultado.remaining = jobs.length - indice
      break
    }
    try {
      let secret = segredos.get(job.webhook_id)
      if (secret === undefined) {
        secret = await loadWebhookSecret(admin, job.webhook_id)
        segredos.set(job.webhook_id, secret)
      }

      const tentativa = await deliverWebhook({
        url: job.url,
        secret,
        evento: job.evento,
        payload: job.payload,
        deliveryId: job.delivery_id,
        timeoutMs,
        now: horaFixa ?? new Date(),
        fetchImpl,
      })

      const status = await registrarComSegundaChance(
        admin,
        workerId,
        job.delivery_id,
        tentativa,
      )
      contabilizar(resultado, status)
      resultado.outcomes.push({
        deliveryId: job.delivery_id,
        ok: tentativa.ok,
        httpStatus: tentativa.httpStatus,
        status,
        ...(tentativa.erro ? { erro: tentativa.erro } : {}),
      })
    } catch (err) {
      if (err instanceof WebhookSecretMissingError) {
        // Sem segredo não há como assinar. Reporta como falha e deixa o banco
        // consumir o orçamento de tentativas até o dead-letter — não inventa
        // uma entrega sem assinatura, que é o que um receptor correto recusa.
        const status = await registrarComSegundaChance(admin, workerId, job.delivery_id, {
          ok: false,
          httpStatus: null,
          erro: 'segredo_indisponivel',
        }).catch(() => ERRO_AO_REGISTRAR)
        contabilizar(resultado, status)
        resultado.outcomes.push({
          deliveryId: job.delivery_id,
          ok: false,
          httpStatus: null,
          status,
          erro: 'segredo_indisponivel',
        })
        continue
      }
      // Erro transitório (leitura do banco, bug inesperado): NÃO registra
      // resultado. A linha fica 'processando' e volta pelo lease — melhor
      // reentregar depois do que queimar tentativa por um soluço nosso.
      console.error(
        '[whatsapp-oficial/outbound-webhooks] erro inesperado na entrega',
        job.delivery_id,
        err instanceof Error ? err.message : String(err),
      )
      resultado.outcomes.push({
        deliveryId: job.delivery_id,
        ok: false,
        httpStatus: null,
        status: 'erro_inesperado',
      })
    }
  }

  return resultado
}

function contabilizar(resultado: ProcessWebhookDeliveriesResult, status: string): void {
  if (status === 'entregue') resultado.delivered += 1
  else if (status === 'falhou') resultado.retried += 1
  else if (status === 'morto') resultado.deadLettered += 1
}

/**
 * TETO PARA A ENTREGA QUE NÃO CONSEGUE NEM SER REGISTRADA.
 *
 * O catch genérico do lote existe para não queimar tentativa por soluço nosso: a
 * linha fica 'processando', o lease expira e outro tique reentrega. Isso é certo
 * quando a falha é transitória e ERRADO quando ela é determinística — uma
 * resposta do destino que o Postgres recusa (surrogate solto, NUL) faz a mesma
 * entrega girar para sempre, POSTando no destino a cada expiração de lease, sem
 * tentativa contabilizada, sem dead-letter e sem trilha.
 *
 * A saída escolhida é SEGUNDA CHANCE COM MENSAGEM FIXA, e não uma coluna nova de
 * contagem de recuperações: a segunda chamada troca o único conteúdo variável
 * (`p_erro`) por um literal ASCII curto. Se ela passa, a causa era o texto e a
 * entrega volta a andar (tentativa contada, backoff, dead-letter na hora certa).
 * Se ela também falha, o banco está mesmo indisponível e o comportamento antigo
 * — devolver pelo lease sem contar tentativa — continua valendo, que é o que se
 * quer numa queda do Supabase. Uma coluna de contagem exigiria migration e
 * mesmo assim não distinguiria as duas causas.
 *
 * Contar duas vezes a mesma tentativa não é risco aqui: `registrar_resultado`
 * limpa `claimed_by` ao fechar, e a fence de `p_worker_id` faz a segunda chamada
 * voltar `lease_perdido` sem tocar em nada caso a primeira tenha, na verdade,
 * chegado ao banco (falha só na volta da resposta).
 */
async function registrarComSegundaChance(
  admin: SupabaseClient,
  workerId: string,
  deliveryId: string,
  tentativa: DeliveryAttemptResult,
): Promise<string> {
  try {
    return await registrarResultado(admin, workerId, deliveryId, tentativa)
  } catch (err) {
    console.error(
      '[whatsapp-oficial/outbound-webhooks] registrar_resultado falhou, tentando mensagem segura',
      deliveryId,
      err instanceof Error ? err.message : String(err),
    )
    return await registrarResultado(admin, workerId, deliveryId, {
      ok: false,
      httpStatus: tentativa.httpStatus,
      erro: ERRO_AO_REGISTRAR,
    })
  }
}

async function registrarResultado(
  admin: SupabaseClient,
  workerId: string,
  deliveryId: string,
  tentativa: DeliveryAttemptResult,
): Promise<string> {
  const { data, error } = await admin.rpc('whatsapp_oficial_webhook_registrar_resultado', {
    p_delivery_id: deliveryId,
    p_ok: tentativa.ok,
    p_http_status: tentativa.httpStatus,
    p_erro: tentativa.erro,
    // Fence token: sem ele a RPC fecha a entrega por id, e dois tiques com leases
    // diferentes roubam a linha um do outro — quem chega por último conta a
    // tentativa. Com ele, quem perdeu o lease recebe 'lease_perdido' e não escreve.
    p_worker_id: workerId,
  })
  if (error) throw error
  const r = (data ?? null) as { ok?: boolean; status?: string; reason?: string } | null
  // Recusa explícita da RPC (lease_perdido, entrega_nao_encontrada) vira status
  // visível no tique. Não é sucesso e não conta em delivered/retried/dead.
  if (r?.ok === false) return r.reason ?? 'recusado'
  return r?.status ?? 'desconhecido'
}
