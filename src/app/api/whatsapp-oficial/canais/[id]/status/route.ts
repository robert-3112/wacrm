import { NextResponse } from 'next/server'
import { BadRequestError, requireGestaoSession, toErrorResponse } from '@/lib/whatsapp-oficial/api-auth'
import { loadManagedChannel, testChannelConnection } from '@/lib/whatsapp-oficial/channel-management'
import { WHATSAPP_OFICIAL_RATE_LIMITS, checkRateLimit, rateLimitResponse } from '@/lib/whatsapp-oficial/rate-limit'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CURRENT = new Set(['ativo', 'inativo', 'pausado'])

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { userId, admin } = await requireGestaoSession()
    const { id } = await context.params
    if (!UUID.test(id)) throw new BadRequestError('canal_invalido')
    const rl = checkRateLimit(`whatsapp-oficial-canais-status:${userId}`, WHATSAPP_OFICIAL_RATE_LIMITS.campanhaWrite)
    if (!rl.success) return rateLimitResponse(rl)
    const body = await request.json().catch(() => null) as { status?: unknown; expectedStatus?: unknown } | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestError('JSON inválido')
    const status = body.status
    const expectedStatus = body.expectedStatus
    if ((status !== 'ativo' && status !== 'pausado') ||
        typeof expectedStatus !== 'string' || !CURRENT.has(expectedStatus)) {
      return NextResponse.json({ error: 'status_invalido' }, { status: 422 })
    }

    // Activating requires a fresh read-only provider probe. The DB RPC locks
    // the row and checks expectedStatus, so a concurrent pause cannot be lost.
    if (status === 'ativo') {
      const channel = await loadManagedChannel(admin, userId, id)
      const probe = await testChannelConnection(admin, channel)
      if (!probe.ok) return NextResponse.json({ error: probe.reason }, { status: 422 })
    }
    const { data, error } = await admin.rpc('whatsapp_oficial_canal_mudar_status', {
      p_actor_user_id: userId,
      p_canal_id: id,
      p_expected_status: expectedStatus,
      p_new_status: status,
    })
    if (error) throw error
    const result = data as { ok?: boolean; reason?: string; status?: string } | null
    if (!result?.ok) {
      const reason = result?.reason ?? 'status_nao_alterado'
      return NextResponse.json({ error: reason }, {
        status: reason === 'canal_nao_encontrado' ? 404 : reason === 'status_alterado' ? 409 : 422,
      })
    }
    return NextResponse.json({ ok: true, status: result.status }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return toErrorResponse(error)
  }
}
