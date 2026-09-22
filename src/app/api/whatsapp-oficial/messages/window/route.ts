import { NextResponse } from 'next/server'
import { BadRequestError, requireConversationAccess, toErrorResponse } from '@/lib/whatsapp-oficial/api-auth'
import { readConversationWindow } from '@/lib/whatsapp-oficial/conversation-window'
import { checkRateLimit, rateLimitResponse, WHATSAPP_OFICIAL_RATE_LIMITS } from '@/lib/whatsapp-oficial/rate-limit'

export async function GET(request: Request): Promise<Response> {
  try {
    const id = new URL(request.url).searchParams.get('conversationId') ?? ''
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new BadRequestError('Conversa inválida')
    }
    const { userId, conversation, admin } = await requireConversationAccess(id)
    const limit = checkRateLimit(`whatsapp-window:${userId}`, WHATSAPP_OFICIAL_RATE_LIMITS.gestaoList)
    if (!limit.success) return rateLimitResponse(limit)
    return NextResponse.json(await readConversationWindow(admin, conversation), {
      headers: { 'Cache-Control': 'private, no-store' },
    })
  } catch (error) { return toErrorResponse(error) }
}
