/**
 * GET /api/v1/health — sonda de credencial da API externa.
 *
 * Não exige escopo nenhum, mas EXIGE uma chave válida: é o endpoint que o integrador chama
 * primeiro para descobrir se a credencial funciona e o que ela pode fazer, antes de escrever
 * uma linha de código contra as rotas de verdade. Sem chave é 401 igual a todas as outras — um
 * health check aberto viraria um "existe alguém aqui?" para qualquer varredura.
 *
 * De quebra exercita a pilha inteira de autenticação (header → RPC → tenant → escopos), então
 * um 200 aqui já prova que o encanamento do qual todas as outras rotas dependem está de pé.
 */

import { requireApiKey, apiV1Ok, toApiV1Response } from '@/lib/whatsapp-oficial/api-key-auth'

export async function GET(request: Request): Promise<Response> {
  try {
    const ctx = await requireApiKey(request)
    return apiV1Ok({
      ok: true,
      tenant: ctx.tenantId,
      escopos: ctx.escopos,
    })
  } catch (error) {
    return toApiV1Response(error)
  }
}
