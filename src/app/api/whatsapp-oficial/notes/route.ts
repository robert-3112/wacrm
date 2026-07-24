import { NextResponse } from 'next/server'
import {
  requireConversationAccess,
  toErrorResponse,
  BadRequestError,
} from '@/lib/whatsapp-oficial/api-auth'
import {
  WHATSAPP_OFICIAL_RATE_LIMITS,
  checkRateLimit,
  rateLimitResponse,
} from '@/lib/whatsapp-oficial/rate-limit'

/**
 * Add an internal note to an official-channel conversation (Fase 6, mission
 * item 4). Internal notes NEVER reach the contact — they only ever live in
 * `whatsapp_internal_notes`, which has no relationship to `whatsapp_messages`
 * and is never included in anything sent to the Meta API.
 *
 * Reading notes does NOT need a route — `whatsapp_internal_notes` has a
 * `SELECT` RLS policy, so the inbox reads them directly via
 * `src/lib/whatsapp-oficial/inbox-data.ts#fetchInternalNotes`. Only the
 * WRITE needs to go through here (no INSERT policy exists — ADR D5/D10).
 */

const MAX_NOTE_LENGTH = 4000

interface CreateNoteBody {
  conversationId?: unknown
  conteudo?: unknown
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json().catch(() => null)) as CreateNoteBody | null
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : ''
    const conteudo = typeof body?.conteudo === 'string' ? body.conteudo.trim() : ''

    if (!conversationId) {
      throw new BadRequestError('conversationId is required')
    }
    if (!conteudo) {
      throw new BadRequestError('conteudo is required')
    }
    if (conteudo.length > MAX_NOTE_LENGTH) {
      throw new BadRequestError(`conteudo exceeds ${MAX_NOTE_LENGTH} characters`)
    }

    const { userId, conversation, admin } = await requireConversationAccess(conversationId)

    const rl = checkRateLimit(
      `whatsapp-oficial-notes:${userId}`,
      WHATSAPP_OFICIAL_RATE_LIMITS.inboxWriteAction,
    )
    if (!rl.success) return rateLimitResponse(rl)

    const { data: note, error } = await admin
      .from('whatsapp_internal_notes')
      .insert({
        tenant_id: conversation.tenant_id,
        conversation_id: conversation.id,
        autor_id: userId,
        conteudo,
      })
      .select('id, conversation_id, autor_id, conteudo, created_at')
      .single()

    if (error || !note) {
      console.error('[whatsapp-oficial/notes] failed to insert note:', error?.message)
      return NextResponse.json({ error: 'Failed to create note' }, { status: 500 })
    }

    return NextResponse.json({ ok: true, note }, { status: 201 })
  } catch (error) {
    return toErrorResponse(error)
  }
}
