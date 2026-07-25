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
 *      conversation. `whatsapp_conversations` RLS already encodes exactly
 *      the rule we need (gestão sees the whole tenant; a corretor only
 *      conversations for leads they own — ADR D10: "checa RLS de
 *      whatsapp_conversations, só o corretor dono ou gestão"), so this is
 *      the WHOLE authorization check. A `maybeSingle()` miss means "doesn't
 *      exist OR you can't see it" — same 404 either way, no information
 *      leak about other corretors' conversations.
 *   2. Once authorized, the route uses the service-role client
 *      (`supabaseAdmin()`) to perform the actual write — these tables have
 *      no INSERT/UPDATE/DELETE policy at all yet (ADR D5/D10), so a
 *      service-role client is the only way to write regardless of who's
 *      calling.
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
  /** service_role client — bypasses RLS. Use only for the specific write
   *  this route exists to perform, never to read data the authorization
   *  check above didn't already clear. */
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

  return {
    userId: user.id,
    conversation: conversation as ConversationAccessRow,
    supabaseUser,
    admin: supabaseAdmin(),
  }
}
