import {
  ApiV1Error,
  apiV1BadRequest,
  apiV1NotFound,
  apiV1Ok,
  requireApiKeyWithScope,
  toApiV1Response,
} from '@/lib/whatsapp-oficial/api-key-auth'
import { isUuid } from '../../../../serialize'
import { readBoundedJson } from '@/lib/whatsapp-oficial/bounded-json'

const TOKEN_RE = /^sc_[0-9a-f]{64}$/

type Params = { params: Promise<{ id: string }> }

/** W01 failed (LLM error, timeout): close the claim so reconciliation does not treat it as interrupted. */
export async function POST(request: Request, { params }: Params): Promise<Response> {
  try {
    const ctx = await requireApiKeyWithScope(request, 'sophia:process')
    const { id } = await params
    if (!isUuid(id)) throw apiV1BadRequest('claim id must be a UUID')
    const body = await readBoundedJson(request, 1024)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw apiV1BadRequest('claim_token is required')
    }
    const values = body as Record<string, unknown>
    if (Object.keys(values).some((key) => key !== 'claim_token' && key !== 'reason')) {
      throw apiV1BadRequest('Only claim_token and reason are supported')
    }
    if (typeof values.claim_token !== 'string' || !TOKEN_RE.test(values.claim_token)) {
      throw apiV1BadRequest("'claim_token' inválido.")
    }
    const reason = typeof values.reason === 'string' ? values.reason.trim() : ''
    if (!reason || reason.length > 200) {
      throw apiV1BadRequest("'reason' deve ter entre 1 e 200 caracteres.")
    }

    const { data, error } = await ctx.admin.rpc('whatsapp_sophia_marcar_falha', {
      p_claim_id: id,
      p_claim_token: values.claim_token,
      p_api_key_id: ctx.apiKeyId,
      p_reason: reason,
    })
    if (error) {
      if (error.code === '42501') throw new ApiV1Error('unauthorized', 401)
      console.error('[api/v1/sophia/claims/failure] RPC failed:', error.message)
      throw new ApiV1Error('internal', 500)
    }
    const result = (data ?? {}) as { ok?: boolean; reason?: string }
    if (result.ok !== true) {
      if (result.reason === 'claim_nao_encontrado') throw apiV1NotFound('Claim not found')
      if (result.reason === 'claim_finalizado') throw new ApiV1Error('claim_finalizado', 409)
      if (result.reason === 'parametros_invalidos') throw apiV1BadRequest('Invalid parameters')
      throw new ApiV1Error('internal', 500)
    }
    return apiV1Ok({ claim_id: id, status: 'failed' })
  } catch (error) {
    return toApiV1Response(error)
  }
}
