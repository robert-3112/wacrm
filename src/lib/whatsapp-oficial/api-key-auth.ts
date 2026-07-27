/**
 * Portão de autenticação da API externa `/api/v1` do canal oficial (Sessão 3).
 *
 * É o equivalente máquina-a-máquina de `api-auth.ts`: lá o chamador é uma pessoa com sessão
 * (cookies do Supabase) e a autorização sai da RLS; aqui o chamador é um integrador com
 * `Authorization: Bearer wa_live_…` e a autorização sai da própria chave.
 *
 * Quem manda é o banco. `whatsapp_oficial_autenticar_api_key` (Fase 8) já hasheia a chave,
 * recusa revogada/expirada e carimba `ultimo_uso_em` — nada disso é reimplementado aqui, e é
 * de propósito: duplicar a regra criaria dois lugares para ela divergir.
 *
 * ── Por que não tem `timingSafeEqual` neste arquivo ──────────────────────────────────────
 * Porque não há comparação de segredo em JavaScript no caminho. A chave apresentada é enviada
 * inteira para o Postgres, que faz `where chave_hash = encode(digest(chave,'sha256'),'hex')` —
 * uma igualdade indexada sobre o hash. Um atacante não consegue extrair a chave byte a byte
 * medindo tempo: como o que se compara é o SHA-256 da chave INTEIRA, errar um caractere muda o
 * hash inteiro, então não existe o "prefixo certo demora mais" que o timingSafeEqual previne.
 * Onde existe comparação de segredo em JS neste subsistema — a assinatura do webhook da Meta —
 * o `timingSafeEqual` está lá, em `webhook-signature.ts`. Colocar um aqui só para constar seria
 * teatro: compararia dois valores que já são públicos (o resultado booleano da RPC).
 *
 * ── Contrato de resposta ─────────────────────────────────────────────────────────────────
 *   sucesso  { "data": … }                    e, em listas, "pagination": { next_cursor, has_more }
 *   erro     { "error": "<slug>", "message"?: "<humano>" }
 *
 * Deliberadamente DIFERENTE do envelope do fork em `@/lib/api/v1/respond.ts`
 * (`{error:{code,message}}`), que serve à API antiga sobre `accounts`/`api_keys` — tabelas que
 * nem existem no Supabase da SUNT. Ver o relatório da Sessão 3.
 */

import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from './supabase-admin'
import { checkRateLimit } from '@/lib/rate-limit'

/** Escopos que o CHECK de `whatsapp_api_keys.escopos` aceita. Espelha o banco. */
export const API_V1_SCOPES = [
  'messages:read',
  'messages:send',
  'conversations:read',
  'contacts:read',
  'contacts:write',
  'broadcasts:send',
  'webhooks:manage',
] as const

export type ApiV1Scope = (typeof API_V1_SCOPES)[number]

/**
 * Orçamento de vazão por CHAVE (não por IP — um integrador atrás de um NAT não pode derrubar
 * o vizinho, e trocar de IP não pode comprar cota extra).
 *
 * PENDÊNCIA CONHECIDA: este número mora aqui e não em `rate-limit.ts` /
 * `whatsapp-oficial/rate-limit.ts` porque nenhum dos dois arquivos era desta frente. O balde
 * mais próximo que existia era `RATE_LIMITS.publicApi` (120/min), do fork; o valor abaixo é o
 * mesmo, de propósito, para que consolidar depois seja só apagar a constante daqui. Como todo
 * balde deste projeto, é em memória e por processo: um deploy multi-instância precisa do Redis
 * que já está na stack do Coolify.
 */
export const API_V1_RATE_LIMIT = { limit: 120, windowMs: 60_000 } as const

/**
 * Orçamento de vazão por ORIGEM, cobrado ANTES do orçamento por chave.
 *
 * Sem ele, o teto por chave é teatro contra quem não tem chave: o balde é identificado pelo
 * hash da chave APRESENTADA, então `wa_live_$(openssl rand -hex 24)` a cada volta do laço ganha
 * um balde novo de 120 e nunca toma 429. Cada requisição dessas vira uma RPC de autenticação no
 * Postgres que o Hub COMPARTILHA com o CRM, e cada chave inédita deixa uma entrada no `Map` de
 * baldes (a varredura oportunista só remove as já expiradas). Ou seja: o caminho barato existia
 * exatamente para quem não tem credencial nenhuma.
 *
 * 180/min = 1,5× o teto por chave. Mais generoso que ele porque uma origem legítima pode ter
 * mais de uma chave (ou estar atrás de NAT), e ainda assim baixo o bastante para cortar o laço
 * que troca de chave a cada requisição — o que também limita a 180/min/origem as entradas novas
 * no `Map`.
 *
 * Honestidade sobre o alcance: `x-forwarded-for` é um header, e quem forja a chave forja o
 * header. Isto barra o laço ingênuo e o script fora de controle, e reduz o custo do resto; não
 * substitui um WAF nem o proxy reescrevendo o XFF na borda. Como todo balde deste projeto, é em
 * memória e por processo.
 */
export const API_V1_ORIGIN_RATE_LIMIT = { limit: 180, windowMs: 60_000 } as const

/**
 * Prefixo que `whatsapp_oficial_criar_api_key` emite: `'wa_live_' || 24 bytes em hex`.
 * Exportado porque é público por natureza (aparece na chave e em `whatsapp_api_keys.prefixo`) e
 * porque quem for escrever a UI de emissão precisa dele para validar o que cola na tela.
 */
export const API_KEY_PREFIX = 'wa_live_'

/**
 * Rejeição barata antes de encostar no banco. Não fixa o comprimento exato (48 hex hoje) para
 * não quebrar caso a RPC passe a emitir chaves maiores — só exige a forma: prefixo certo e
 * corpo hexadecimal com entropia plausível.
 */
const API_KEY_SHAPE = new RegExp(`^${API_KEY_PREFIX}[0-9a-f]{16,}$`)

export interface ApiKeyContext {
  /** `whatsapp_api_keys.id` — vai como ator-máquina para a RPC de escrita. */
  apiKeyId: string
  /** Tenant dono da chave. TODA consulta subsequente filtra por ele. */
  tenantId: string
  /** Escopos concedidos. */
  escopos: string[]
  /** service_role — não existe sessão de usuário, então não existe `auth.uid()` para a RLS
   *  casar. É o filtro explícito por `tenantId` que substitui a RLS neste caminho. */
  admin: SupabaseClient
}

/** Erro que vira envelope. `extra` carrega campos de topo (ex.: `required` no 403). */
export class ApiV1Error extends Error {
  readonly slug: string
  readonly status: number
  readonly extra: Record<string, unknown>
  readonly headers?: Record<string, string>

  constructor(
    slug: string,
    status: number,
    options: {
      message?: string
      extra?: Record<string, unknown>
      headers?: Record<string, string>
    } = {},
  ) {
    super(options.message ?? slug)
    this.name = 'ApiV1Error'
    this.slug = slug
    this.status = status
    this.extra = options.extra ?? {}
    this.headers = options.headers
  }
}

/**
 * 401 — sempre a MESMA resposta, seja header ausente, malformado, chave inexistente, revogada
 * ou expirada. Distinguir os casos entregaria de graça um oráculo de "esta chave existe".
 */
function unauthorized(): ApiV1Error {
  return new ApiV1Error('unauthorized', 401, {
    message: 'Missing or invalid API key',
  })
}

export function apiV1NotFound(message = 'Not found'): ApiV1Error {
  return new ApiV1Error('not_found', 404, { message })
}

export function apiV1BadRequest(message: string): ApiV1Error {
  return new ApiV1Error('bad_request', 400, { message })
}

/** Sucesso simples: `{ data }`. */
export function apiV1Ok(data: unknown, status = 200): NextResponse {
  return NextResponse.json({ data }, { status })
}

/** Sucesso paginado: `{ data, pagination: { next_cursor, has_more } }`. */
export function apiV1Page(items: unknown[], nextCursor: string | null): NextResponse {
  return NextResponse.json({
    data: items,
    pagination: { next_cursor: nextCursor, has_more: nextCursor !== null },
  })
}

/** Mapeia qualquer coisa lançada para o envelope de erro. Nada de texto interno no fio. */
export function toApiV1Response(err: unknown): NextResponse {
  if (err instanceof ApiV1Error) {
    const body: Record<string, unknown> = { error: err.slug, ...err.extra }
    if (err.message && err.message !== err.slug) body.message = err.message
    return NextResponse.json(body, { status: err.status, headers: err.headers })
  }
  console.error('[api/v1] erro nao categorizado:', err)
  return NextResponse.json(
    { error: 'internal', message: 'Internal server error' },
    { status: 500 },
  )
}

/** Extrai a chave do header. Tolera espaçamento, exige o esquema `Bearer`. */
function extractBearer(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (!header) return null
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim())
  if (!match) return null
  const value = match[1]
  return API_KEY_SHAPE.test(value) ? value : null
}

interface AutenticarResultado {
  ok?: boolean
  reason?: string
  api_key_id?: string
  tenant_id?: string
  escopos?: unknown
}

/**
 * Identificador do balde de vazão. É o SHA-256 da chave, não a chave: o balde vive num Map em
 * memória por até uma janela inteira, e não há motivo para a credencial em texto plano ficar
 * parada ali (um heap dump entregaria chaves ativas). O hash serve igual como identidade.
 */
function bucketId(chave: string): string {
  return `api-v1-key:${createHash('sha256').update(chave).digest('hex')}`
}

/**
 * Identificador do balde de origem. Mesma extração de IP que o resto do repo já usa
 * (`webhook/route.ts`, `invitations/[token]/peek`): a entrada mais à esquerda do
 * `x-forwarded-for`, que é o cliente original quando há proxy na frente, e `x-real-ip` como
 * segunda opção.
 *
 * Sem IP nenhum (dev sem proxy, chamada interna) cai num balde GLOBAL de última instância, e
 * isso não é só conveniência de desenvolvimento: se o dia em que o proxy parar de mandar o
 * header for justamente o dia do laço, o teto por origem sumiria — o balde global mantém um
 * teto de pé. Ele é compartilhado, então em produção um abusador sem XFF pode gastá-lo para os
 * outros sem XFF; ainda assim é melhor do que não ter teto.
 */
function originBucketId(request: Request): string {
  const xff = request.headers.get('x-forwarded-for')
  const primeiro = xff?.split(',')[0]?.trim()
  if (primeiro) return `api-v1-origin:${primeiro}`
  const xri = request.headers.get('x-real-ip')?.trim()
  if (xri) return `api-v1-origin:${xri}`
  return 'api-v1-origin:sem-ip'
}

/** Monta o 429 com os headers que todo cliente HTTP já sabe ler. */
function rateLimited(rl: ReturnType<typeof checkRateLimit>, message: string): ApiV1Error {
  const retryAfter = Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000))
  return new ApiV1Error('rate_limited', 429, {
    message,
    headers: {
      'Retry-After': String(retryAfter),
      'X-RateLimit-Limit': String(rl.limit),
      'X-RateLimit-Remaining': String(rl.remaining),
      'X-RateLimit-Reset': String(Math.ceil(rl.reset / 1000)),
    },
  })
}

/**
 * Autentica a requisição e devolve o contexto da chave.
 *
 * Ordem deliberada: origem → formato → chave → banco. O teto de vazão vem ANTES da consulta
 * para que chave inválida repetida não vire um martelo grátis contra o Postgres; como a chave
 * ainda não foi resolvida, o balde nesse ponto é derivado da chave apresentada, não do id dela
 * — e é exatamente por isso que o balde de ORIGEM tem de vir antes dele (ver
 * `API_V1_ORIGIN_RATE_LIMIT`). O de origem é também o único que se aplica a quem nem chega a
 * apresentar algo com cara de chave.
 */
export async function requireApiKey(request: Request): Promise<ApiKeyContext> {
  const rlOrigem = checkRateLimit(originBucketId(request), API_V1_ORIGIN_RATE_LIMIT)
  if (!rlOrigem.success) {
    throw rateLimited(rlOrigem, 'Rate limit exceeded for this origin')
  }

  const presented = extractBearer(request)
  if (!presented) throw unauthorized()

  const rl = checkRateLimit(bucketId(presented), API_V1_RATE_LIMIT)
  if (!rl.success) {
    throw rateLimited(rl, 'Rate limit exceeded for this API key')
  }

  const admin = supabaseAdmin()
  const { data, error } = await admin.rpc('whatsapp_oficial_autenticar_api_key', {
    p_chave: presented,
  })

  if (error) {
    // Falha de infraestrutura (service key errada, banco fora) NÃO é credencial ruim. Devolver
    // 401 aqui faria o integrador passar horas trocando uma chave que estava certa.
    console.error('[api/v1] RPC de autenticacao falhou:', error.message)
    throw new ApiV1Error('internal', 500, { message: 'Internal server error' })
  }

  const resultado = (data ?? {}) as AutenticarResultado
  if (resultado.ok !== true) throw unauthorized()

  const tenantId = typeof resultado.tenant_id === 'string' ? resultado.tenant_id.trim() : ''
  const apiKeyId = typeof resultado.api_key_id === 'string' ? resultado.api_key_id : ''
  if (!tenantId || !apiKeyId) {
    // Chave "válida" sem tenant resolvido não pode virar um contexto sem filtro — seria uma
    // chave que enxerga tudo. Fail-closed.
    console.error('[api/v1] autenticacao devolveu ok sem tenant_id/api_key_id')
    throw unauthorized()
  }

  const escopos = Array.isArray(resultado.escopos)
    ? resultado.escopos.filter((s): s is string => typeof s === 'string')
    : []

  return { apiKeyId, tenantId, escopos, admin }
}

/**
 * Exige um escopo. 403 com o escopo faltante no corpo — o integrador precisa saber o que pedir
 * ao emitir a próxima chave, e isso não vaza nada que ele já não saiba sobre a própria chave.
 */
export function requireScope(ctx: ApiKeyContext, required: ApiV1Scope): void {
  if (!ctx.escopos.includes(required)) {
    throw new ApiV1Error('insufficient_scope', 403, {
      message: `This API key is missing the '${required}' scope`,
      extra: { required },
    })
  }
}

/** Atalho: autentica e já exige o escopo da rota. */
export async function requireApiKeyWithScope(
  request: Request,
  scope: ApiV1Scope,
): Promise<ApiKeyContext> {
  const ctx = await requireApiKey(request)
  requireScope(ctx, scope)
  return ctx
}
