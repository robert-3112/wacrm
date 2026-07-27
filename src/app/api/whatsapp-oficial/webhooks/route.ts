import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { requireGestaoSession, toErrorResponse, BadRequestError } from '@/lib/whatsapp-oficial/api-auth'
import {
  WHATSAPP_OFICIAL_RATE_LIMITS,
  checkRateLimit,
  rateLimitResponse,
} from '@/lib/whatsapp-oficial/rate-limit'
import { encryptToken } from '@/lib/whatsapp-oficial/crypto'
import { WEBHOOK_EVENTOS, isWebhookEvento } from '@/lib/whatsapp-oficial/outbound-webhooks'

/**
 * Inscrições de outbound webhook — listar e inscrever.
 *
 * Duas metades com clientes deliberadamente diferentes, mesma escolha das
 * rotas de campanha:
 *
 * - GET usa o cliente COM SESSÃO. `whatsapp_outbound_webhooks` tem policy de
 *   SELECT só para gestão do próprio tenant, então a RLS já É o filtro de
 *   autorização da lista — um corretor logado vê zero linhas em vez de 403.
 *   Ler com `service_role` aqui entregaria os endpoints de todo mundo para
 *   qualquer sessão válida.
 * - POST usa `service_role` porque a tabela não tem policy de INSERT: quem
 *   valida o papel do ator é a RPC `whatsapp_oficial_webhook_inscrever`
 *   (owner/admin/gestor, checado contra `app_roles`). A rota não repete a
 *   regra de papel — ver o comentário de `requireGestaoSession`.
 *
 * O SEGREDO É GERADO AQUI e devolvido UMA ÚNICA VEZ, em texto plano, no corpo
 * da resposta de criação. Depois disso só existe cifrado (AES-256-GCM, o mesmo
 * `encryptToken` dos tokens da Meta) e não há rota que o mostre de novo —
 * mesmo contrato de `whatsapp_oficial_criar_api_key`. Quem perder reinscreve o
 * endpoint. A alternativa (deixar o operador escolher o segredo) traz segredo
 * fraco e reaproveitado de outro sistema.
 *
 * Nada aqui envia mensagem de WhatsApp. Webhook de saída fala com sistema.
 */

const LISTA_MAX_LINHAS = 100

/** Sem `segredo_cifrado`: a policy de SELECT o exporia para a gestão, e não há motivo. */
const LISTA_SELECT = `
  id, tenant_id, url, eventos, ativo, criado_por, created_at, desativado_em
`.trim()

/** 32 bytes em hex — mesma ordem de grandeza dos segredos de webhook de Stripe/GitHub. */
const SEGREDO_BYTES = 32

interface InscreverBody {
  url?: unknown
  eventos?: unknown
  tenantId?: unknown
}

interface InscreverResult {
  ok?: boolean
  reason?: string
  webhook_id?: string
  tenant_id?: string
  url?: string
  eventos?: string[]
}

function unprocessable(slug: string): NextResponse {
  return NextResponse.json({ error: slug }, { status: 422 })
}

export async function GET(): Promise<Response> {
  try {
    const { userId, supabaseUser } = await requireGestaoSession()

    const rl = checkRateLimit(
      `whatsapp-oficial-webhooks-list:${userId}`,
      WHATSAPP_OFICIAL_RATE_LIMITS.campanhaWrite,
    )
    if (!rl.success) return rateLimitResponse(rl)

    const { data, error } = await supabaseUser
      .from('whatsapp_outbound_webhooks')
      .select(LISTA_SELECT)
      .order('created_at', { ascending: false })
      .limit(LISTA_MAX_LINHAS)

    if (error) throw error

    return NextResponse.json({
      ok: true,
      webhooks: data ?? [],
      eventos_disponiveis: WEBHOOK_EVENTOS,
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    // Autenticar ANTES de ler o corpo: quem não tem sessão não precisa
    // descobrir qual vocabulário de evento a rota aceita.
    const { userId, admin } = await requireGestaoSession()

    const rl = checkRateLimit(
      `whatsapp-oficial-webhooks-inscrever:${userId}`,
      WHATSAPP_OFICIAL_RATE_LIMITS.campanhaWrite,
    )
    if (!rl.success) return rateLimitResponse(rl)

    const raw = (await request.json().catch(() => null)) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestError('invalid JSON body')
    }
    const body = raw as InscreverBody

    const url = typeof body.url === 'string' ? body.url.trim() : ''
    if (!url) return unprocessable('url_obrigatoria')
    // A RPC recusa esquema fora de http/https também; parar aqui devolve o
    // mesmo slug sem ida ao banco. Endereço interno é PERMITIDO de propósito
    // (o n8n do VPS mora na rede interna) — quem inscreve é owner/admin/gestor.
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return unprocessable('url_invalida')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return unprocessable('url_invalida')
    }

    if (!Array.isArray(body.eventos)) return unprocessable('eventos_invalidos')
    // Lista vazia NÃO é "todos os eventos": seria uma inscrição que nunca
    // dispara, e ninguém descobre um webhook mudo olhando para ele. O CHECK do
    // banco também recusa; aqui o operador recebe o motivo direto.
    if (body.eventos.length === 0) return unprocessable('eventos_obrigatorios')
    if (!body.eventos.every(isWebhookEvento)) {
      return NextResponse.json(
        { error: 'evento_invalido', eventos_disponiveis: WEBHOOK_EVENTOS },
        { status: 422 },
      )
    }
    const eventos = Array.from(new Set(body.eventos))

    let tenantId: string | null = null
    if (body.tenantId !== undefined && body.tenantId !== null) {
      if (typeof body.tenantId !== 'string' || !body.tenantId.trim()) {
        return unprocessable('tenant_invalido')
      }
      tenantId = body.tenantId.trim()
    }

    const segredo = randomBytes(SEGREDO_BYTES).toString('hex')
    let segredoCifrado: string
    try {
      segredoCifrado = encryptToken(segredo)
    } catch {
      // ENCRYPTION_KEY ausente/curta. Sem ela não dá para guardar o segredo, e
      // gravar em claro está fora de questão — 503, não 500: é configuração
      // faltando, não bug.
      return NextResponse.json({ error: 'criptografia_nao_configurada' }, { status: 503 })
    }

    const { data, error } = await admin.rpc('whatsapp_oficial_webhook_inscrever', {
      p_actor_user_id: userId,
      p_url: url,
      p_eventos: eventos,
      p_segredo_cifrado: segredoCifrado,
      p_tenant_id: tenantId,
    })

    // 42501 (ator sem papel de gestão, ou agindo em tenant alheio) vira 403 no
    // `toErrorResponse`; qualquer outro erro de banco vira 500 por lá.
    if (error) throw error

    const result = (data ?? null) as InscreverResult | null
    if (!result?.ok) {
      const reason = result?.reason ?? 'webhook_nao_inscrito'
      const status = reason === 'url_ja_inscrita' ? 409 : 422
      return NextResponse.json({ error: reason }, { status })
    }

    return NextResponse.json(
      {
        ok: true,
        webhook_id: result.webhook_id,
        tenant_id: result.tenant_id,
        url: result.url,
        eventos: result.eventos,
        // Única vez que o segredo aparece. Guardado só cifrado no banco.
        segredo,
        aviso:
          'Guarde o segredo agora: ele não pode ser exibido de novo. Use-o para conferir o ' +
          'header x-sunt-signature (HMAC-SHA256 de "<x-sunt-timestamp>.<corpo cru>").',
      },
      { status: 201 },
    )
  } catch (error) {
    return toErrorResponse(error)
  }
}
