import { NextResponse } from 'next/server'
import { requireGestaoSession, toErrorResponse, NotFoundError } from '@/lib/whatsapp-oficial/api-auth'
import {
  WHATSAPP_OFICIAL_RATE_LIMITS,
  checkRateLimit,
  rateLimitResponse,
} from '@/lib/whatsapp-oficial/rate-limit'

/**
 * DESATIVA uma inscrição de outbound webhook. Não apaga.
 *
 * O verbo é DELETE porque é o que o cliente espera para "remover a inscrição",
 * mas o efeito é `ativo = false` + `desativado_em = now()`. A linha continua
 * lá: ela é a única resposta para "para onde este tenant estava mandando dado,
 * e até quando?". O banco reforça isso — `whatsapp_webhook_deliveries` tem FK
 * sem CASCADE para cá, então um DELETE de verdade seria barrado por qualquer
 * entrega já registrada.
 *
 * A RPC também mata as entregas ainda em aberto dessa inscrição. Sem isso elas
 * ficariam eternamente 'pendente' (o claim filtra por inscrição ativa) e a
 * fila mentiria sobre o próprio tamanho.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface DesativarResult {
  ok?: boolean
  reason?: string
  webhook_id?: string
  already_inactive?: boolean
  entregas_canceladas?: number
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params
    const { userId, admin } = await requireGestaoSession()

    const rl = checkRateLimit(
      `whatsapp-oficial-webhooks-desativar:${userId}`,
      WHATSAPP_OFICIAL_RATE_LIMITS.campanhaWrite,
    )
    if (!rl.success) return rateLimitResponse(rl)

    // Sem isto o PostgREST devolveria 22P02 e a rota responderia 500 por um
    // erro que é do cliente.
    if (!UUID_RE.test(id)) throw new NotFoundError('Webhook não encontrado')

    const { data, error } = await admin.rpc('whatsapp_oficial_webhook_desativar', {
      p_actor_user_id: userId,
      p_webhook_id: id,
    })

    // 42501 (ator sem papel de gestão, ou de outro tenant) vira 403 no `toErrorResponse`.
    if (error) throw error

    const result = (data ?? null) as DesativarResult | null
    if (!result?.ok) {
      const reason = result?.reason ?? 'webhook_nao_desativado'
      return NextResponse.json(
        { error: reason },
        { status: reason === 'webhook_nao_encontrado' ? 404 : 422 },
      )
    }

    return NextResponse.json(result)
  } catch (error) {
    return toErrorResponse(error)
  }
}
