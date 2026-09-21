import {
  ApiV1Error,
  apiV1BadRequest,
  apiV1NotFound,
  apiV1Ok,
  requireApiKeyWithScope,
  toApiV1Response,
} from '@/lib/whatsapp-oficial/api-key-auth'
import { isUuid } from '../../serialize'
import { readBoundedJson } from '@/lib/whatsapp-oficial/bounded-json'

interface ClaimResult {
  ok?: boolean
  reason?: string
  claim_id?: string
  claim_token?: string
}

/** One durable claim per inbound message, before calling the Sophia LLM. */
export async function POST(request: Request): Promise<Response> {
  try {
    const ctx = await requireApiKeyWithScope(request, 'sophia:process')
    const body = await readBoundedJson(request, 512)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw apiV1BadRequest('message_id is required')
    }
    const values = body as Record<string, unknown>
    if (Object.keys(values).length !== 1 ||
        typeof values.message_id !== 'string' || !isUuid(values.message_id)) {
      throw apiV1BadRequest('message_id must be a UUID')
    }

    // The RPC revalidates key scope and the tenant against the inbound row.
    // A webhook replay receives no token and therefore cannot run W01 again.
    const { data, error } = await ctx.admin.rpc('whatsapp_sophia_claim_inbound', {
      p_message_id: values.message_id,
      p_api_key_id: ctx.apiKeyId,
    })
    if (error) {
      if (error.code === '42501') throw new ApiV1Error('unauthorized', 401)
      console.error('[api/v1/sophia/claims] claim RPC failed:', error.message)
      throw new ApiV1Error('internal', 500)
    }
    const result = (data ?? {}) as ClaimResult
    if (!result.ok) {
      if (result.reason === 'mensagem_nao_encontrada') throw apiV1NotFound('Message not found')
      if (result.reason === 'already_claimed') throw new ApiV1Error('already_claimed', 409)
      if (result.reason === 'parametros_invalidos') throw apiV1BadRequest('Invalid parameters')
      throw new ApiV1Error('not_processable', 409)
    }
    if (typeof result.claim_id !== 'string' || !isUuid(result.claim_id) ||
        typeof result.claim_token !== 'string' ||
        !/^sc_[0-9a-f]{64}$/.test(result.claim_token)) {
      console.error('[api/v1/sophia/claims] claim RPC returned an invalid contract')
      throw new ApiV1Error('internal', 500)
    }
    const response = apiV1Ok({ claim_id: result.claim_id, claim_token: result.claim_token }, 201)
    response.headers.set('Cache-Control', 'no-store')
    return response
  } catch (error) {
    return toApiV1Response(error)
  }
}
