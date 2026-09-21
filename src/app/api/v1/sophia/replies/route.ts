import {
  ApiV1Error,
  apiV1BadRequest,
  apiV1Ok,
  requireApiKeyWithScope,
  toApiV1Response,
} from '@/lib/whatsapp-oficial/api-key-auth'
import { isUuid } from '../../serialize'
import { readBoundedJson } from '@/lib/whatsapp-oficial/bounded-json'

const TOKEN_RE = /^sc_[0-9a-f]{64}$/

/** Dedicated AI enqueue path. A sophia:process key cannot use generic messages:send. */
export async function POST(request: Request): Promise<Response> {
  try {
    const ctx = await requireApiKeyWithScope(request, 'sophia:process')
    const body = (await readBoundedJson(request, 32 * 1024)) as {
      claimId?: unknown
      claimToken?: unknown
      content?: unknown
    } | null
    const claimId = typeof body?.claimId === 'string' ? body.claimId : ''
    const claimToken = typeof body?.claimToken === 'string' ? body.claimToken : ''
    const content = typeof body?.content === 'string' ? body.content.trim() : ''
    if (!isUuid(claimId)) throw apiV1BadRequest("'claimId' deve ser um UUID.")
    if (!TOKEN_RE.test(claimToken)) throw apiV1BadRequest("'claimToken' inválido.")
    if (!content || content.length > 4096) {
      throw apiV1BadRequest("'content' deve ter entre 1 e 4096 caracteres.")
    }

    const { data, error } = await ctx.admin.rpc('whatsapp_sophia_enfileirar_resposta', {
      p_claim_id: claimId,
      p_claim_token: claimToken,
      p_api_key_id: ctx.apiKeyId,
      p_content: content,
    })
    if (error) {
      if ((error as { code?: string }).code === '42501') {
        throw new ApiV1Error('unauthorized', 401, { message: 'Missing or invalid API key' })
      }
      throw error
    }
    const result = data as {
      ok?: boolean
      reason?: string
      message_id?: string
      conversation_id?: string
      status?: string
      idempotent_replay?: boolean
    }
    if (result?.ok !== true) {
      const reason = result?.reason ?? 'sophia_reply_rejected'
      const conflict = new Set([
        'claim_finalizado', 'sophia_pausada', 'sophia_estado_alterado', 'conversa_bloqueada',
        'canal_inativo_ou_invalido', 'fora_da_janela_24h',
      ])
      throw new ApiV1Error(reason, conflict.has(reason) ? 409 : 422)
    }
    // Same-content retry of an already queued reply: same message_id, nothing new queued.
    const replay = result.idempotent_replay === true
    return apiV1Ok({
      enfileirado: true,
      message_id: result.message_id,
      conversation_id: result.conversation_id,
      status: result.status,
      idempotent_replay: replay,
    }, replay ? 200 : 201)
  } catch (error) {
    return toApiV1Response(error)
  }
}
