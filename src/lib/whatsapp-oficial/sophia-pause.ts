import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isPostgrestPermissionError, type ConversationAccessRow } from './api-auth'

/** What a human send reports back so the UI can warn about AI replies already on their way. */
export interface SophiaHumanPause {
  sophia_pausada: boolean
  in_flight_replies: number
}

// Only a missing column proves this database cannot have Sophia enabled.
const NOT_DEPLOYED = new Set(['42703', 'PGRST204'])

function notDeployed(error: { code?: string } | null | undefined): boolean {
  return typeof error?.code === 'string' && NOT_DEPLOYED.has(error.code)
}

function refuse(status: number): NextResponse {
  return NextResponse.json(
    { error: 'Não foi possível pausar a Sophia; a mensagem não foi enviada. Tente novamente.' },
    { status },
  )
}

/**
 * A human writing to the lead takes over: pause Sophia (cancels queued AI replies
 * and bumps the generation) BEFORE the human message is queued. Fails closed:
 * returns a Response to send back instead of queueing. The only exception is the
 * DB contract not being deployed yet, where there is no Sophia to pause.
 */
export async function pauseSophiaForHumanSend(
  admin: SupabaseClient,
  conversation: Pick<ConversationAccessRow, 'id' | 'tenant_id'>,
  userId: string,
): Promise<SophiaHumanPause | NextResponse> {
  const idle: SophiaHumanPause = { sophia_pausada: false, in_flight_replies: 0 }
  const { data: state, error: stateError } = await admin
    .from('whatsapp_conversations')
    .select('sophia_ativa')
    .eq('id', conversation.id)
    .eq('tenant_id', conversation.tenant_id)
    .maybeSingle()
  if (stateError) {
    if (notDeployed(stateError)) return idle
    console.error('[whatsapp-oficial/sophia-pause] state read failed:', stateError.message)
    return refuse(500)
  }
  if (typeof state?.sophia_ativa !== 'boolean') return refuse(409)

  const { data, error } = await admin.rpc('whatsapp_sophia_definir_estado', {
    p_conversation_id: conversation.id,
    p_actor_user_id: userId,
    p_ativa: false,
  })
  if (error) {
    if (isPostgrestPermissionError(error)) return refuse(403)
    console.error('[whatsapp-oficial/sophia-pause] pause RPC failed:', error.message)
    return refuse(500)
  }
  const result = data as { ok?: boolean; reason?: string; sophia_ativa?: boolean; in_flight_replies?: unknown } | null
  // Evolution has no Meta Sophia contract. An active/unknown state never bypasses the pause.
  if (state.sophia_ativa === false && result?.ok === false && result.reason === 'canal_nao_meta') return idle
  if (result?.ok !== true || result.sophia_ativa !== false) {
    console.error('[whatsapp-oficial/sophia-pause] pause refused:', result?.reason)
    return refuse(409)
  }
  const inFlight = Number(result.in_flight_replies)
  return { sophia_pausada: true, in_flight_replies: Number.isInteger(inFlight) && inFlight > 0 ? inFlight : 0 }
}
