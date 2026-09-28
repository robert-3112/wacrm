/**
 * Server-side authorization for the official-channel inbox WRITE routes
 * (`src/app/api/whatsapp-oficial/{messages,notes,conversations}/**`).
 *
 * WRITTEN FROM SCRATCH for this mission. Pattern copied from the one
 * pre-existing route in this subsystem that already does exactly this two-
 * client dance — `src/app/api/whatsapp-oficial/media/[mediaId]/route.ts`
 * (Fase 4) — generalized so every Fase 6 write route shares it instead of
 * re-deriving it per route:
 *
 *   1. A user-scoped client (`@/lib/supabase/server`, cookies + anon key) is
 *      used ONLY to check whether the caller can currently SELECT the
 *      conversation. For a broker, the same session also confirms that both
 *      the lead and channel belong to that active broker in the same tenant.
 *      A `maybeSingle()` miss means "doesn't exist OR you can't see it" —
 *      same 404 either way, with no information leak.
 *   2. Writes with existing database RPCs use the authenticated client,
 *      so the database revalidates authorization atomically. Other routes
 *      still use the service-role client (`supabaseAdmin()`) for writes
 *      protected by their own RPC or trigger.
 */

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from './supabase-admin'

export class UnauthorizedError extends Error {
  readonly status = 401 as const
  constructor(message = 'Unauthorized') {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

export class NotFoundError extends Error {
  readonly status = 404 as const
  constructor(message = 'Not found') {
    super(message)
    this.name = 'NotFoundError'
  }
}

export class BadRequestError extends Error {
  readonly status = 400 as const
  constructor(message = 'Bad request') {
    super(message)
    this.name = 'BadRequestError'
  }
}

export class ForbiddenError extends Error {
  readonly status = 403 as const
  constructor(message = 'Forbidden') {
    super(message)
    this.name = 'ForbiddenError'
  }
}

export function toErrorResponse(err: unknown): NextResponse {
  if (
    err instanceof UnauthorizedError ||
    err instanceof NotFoundError ||
    err instanceof BadRequestError ||
    err instanceof ForbiddenError
  ) {
    return NextResponse.json({ error: err.message }, { status: err.status })
  }
  // A RPC devolve 42501 (insufficient_privilege) quando o ator nao tem papel de gestao ou nao
  // pode agir sobre aquele tenant. Ela e a AUTORIDADE — a rota so repassa como 403.
  if (isPostgrestPermissionError(err)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  console.error('[whatsapp-oficial/api-auth] uncategorized error:', err)
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
}

/** PostgREST devolve o SQLSTATE em `code`; 42501 = insufficient_privilege. */
export function isPostgrestPermissionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; message?: unknown }
  if (e.code === '42501') return true
  return typeof e.message === 'string' && /sem_permissao|service_role_required/.test(e.message)
}

export interface GestaoAccessContext {
  /** `auth.uid()` do chamador. Vai para a RPC, que é quem valida o papel de verdade. */
  userId: string
  /** Cliente com a sessão do usuário — leituras continuam sujeitas a RLS. */
  supabaseUser: SupabaseClient
  /** service_role — bypassa RLS. Só para chamar a RPC que fará a checagem de papel. */
  admin: SupabaseClient
}

/**
 * Gate das rotas de gestão que NÃO têm uma conversa contra a qual provar RLS
 * (templates e campanhas).
 *
 * Diferença deliberada em relação a {@link requireConversationAccess}: aqui a
 * rota só prova que existe uma SESSÃO e extrai o `user_id`. Quem decide se
 * aquele usuário é owner/admin/gestor daquele tenant é a própria RPC, no
 * Postgres, via `whatsapp_campanha_ator_autorizado` — mesma escolha de
 * `whatsapp_oficial_enfileirar_mensagem`, que revalida o ator em `app_roles`
 * em vez de confiar num pré-check da aplicação. Duplicar a regra de papel aqui
 * criaria dois lugares para ela divergir; a autoridade fica onde o dado está.
 */
export async function requireGestaoSession(): Promise<GestaoAccessContext> {
  const supabaseUser = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabaseUser.auth.getUser()
  if (authError || !user) {
    throw new UnauthorizedError()
  }
  return { userId: user.id, supabaseUser, admin: supabaseAdmin() }
}

export interface ConversationAccessRow {
  id: string
  tenant_id: string
  canal_id: string
  lead_id: string
  status: string
}

export interface ConversationAccessContext {
  /** `auth.uid()` for the caller. */
  userId: string
  /** The conversation row, confirmed visible to the caller via RLS. */
  conversation: ConversationAccessRow
  /** RLS-scoped client (the caller's own session) — safe for further reads
   *  that should stay authorization-scoped. */
  supabaseUser: SupabaseClient
  /** service_role client — bypasses RLS. Routes that need it must rely on a
   *  database RPC or trigger that rechecks actor, lead and channel at write
   *  time; a preceding SELECT alone is not authorization. */
  admin: SupabaseClient
}

/**
 * Resolve the caller's session and confirm they can see `conversationId`.
 *
 * Throws {@link UnauthorizedError} when there's no session, or
 * {@link NotFoundError} when the conversation doesn't exist or RLS hides it
 * (deliberately indistinguishable, same as the media relay route).
 */
export async function requireConversationAccess(
  conversationId: string,
): Promise<ConversationAccessContext> {
  const supabaseUser = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabaseUser.auth.getUser()
  if (authError || !user) {
    throw new UnauthorizedError()
  }

  const { data: conversation, error } = await supabaseUser
    .from('whatsapp_conversations')
    .select('id, tenant_id, canal_id, lead_id, status')
    .eq('id', conversationId)
    .maybeSingle()

  if (error) {
    console.error('[whatsapp-oficial/api-auth] failed to look up conversation:', error.message)
    throw new NotFoundError()
  }
  if (!conversation) {
    throw new NotFoundError('Conversation not found')
  }

  // A conversation SELECT alone is insufficient on installations that still
  // have the legacy lead-only RLS policy. A broker must own the lead and the
  // channel, or pass the database's narrow shared/default-channel gate.
  // The database write RPC/trigger must independently recheck against races.
  const { data: isGestao, error: roleError } = await supabaseUser.rpc('crm_is_gestao')
  if (roleError) throw new NotFoundError()
  if (isGestao !== true) {
    const { data: brokerId, error: brokerError } = await supabaseUser.rpc('crm_current_corretor_id')
    if (brokerError || !brokerId) throw new NotFoundError()

    const [leadResult, channelResult] = await Promise.all([
      supabaseUser.from('leads').select('id,tenant_id,corretor_id')
        .eq('id', conversation.lead_id).maybeSingle(),
      supabaseUser.from('whatsapp_channels').select('id,tenant_id,corretor_id')
        .eq('id', conversation.canal_id).maybeSingle(),
    ])
    const lead = leadResult.data
    const channel = channelResult.data
    if (leadResult.error || channelResult.error ||
        lead?.id !== conversation.lead_id || lead?.tenant_id !== conversation.tenant_id ||
        lead?.corretor_id !== brokerId) {
      throw new NotFoundError()
    }
    if (channel) {
      if (channel.id !== conversation.canal_id || channel.tenant_id !== conversation.tenant_id ||
          channel.corretor_id !== brokerId) throw new NotFoundError()
    } else {
      // The 1266 default channel is intentionally hidden from a broker's
      // direct channel SELECT. This session-scoped RPC verifies the same lead,
      // active broker, tenant, and (corretor_id IS NULL AND is_default TRUE).
      const { data: sharedAllowed, error: sharedError } = await supabaseUser.rpc(
        'whatsapp_oficial_corretor_pode_ler_conversa', { p_conversation_id: conversation.id },
      )
      if (sharedError || sharedAllowed !== true) throw new NotFoundError()
    }
  }

  return {
    userId: user.id,
    conversation: conversation as ConversationAccessRow,
    supabaseUser,
    admin: supabaseAdmin(),
  }
}
