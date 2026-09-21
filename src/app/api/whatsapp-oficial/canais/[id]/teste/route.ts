import { NextResponse } from 'next/server'
import { BadRequestError, requireGestaoSession, toErrorResponse } from '@/lib/whatsapp-oficial/api-auth'
import { loadManagedChannel, testChannelConnection } from '@/lib/whatsapp-oficial/channel-management'
import { WHATSAPP_OFICIAL_RATE_LIMITS, checkRateLimit, rateLimitResponse } from '@/lib/whatsapp-oficial/rate-limit'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { userId, admin } = await requireGestaoSession()
    const { id } = await context.params
    if (!UUID.test(id)) throw new BadRequestError('canal_invalido')
    const rl = checkRateLimit(`whatsapp-oficial-canais-teste:${userId}`, WHATSAPP_OFICIAL_RATE_LIMITS.templateSync)
    if (!rl.success) return rateLimitResponse(rl)
    const channel = await loadManagedChannel(admin, userId, id)
    const result = await testChannelConnection(admin, channel)
    return NextResponse.json(result, { status: result.ok ? 200 : 422, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return toErrorResponse(error)
  }
}
