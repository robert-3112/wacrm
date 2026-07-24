/**
 * Client-side read helpers for the official-channel shared inbox (Fase 6).
 *
 * These are the ONLY reads the inbox needs to do directly against Supabase
 * from the browser — `whatsapp_conversations`/`whatsapp_messages`/
 * `whatsapp_internal_notes` all have a `SELECT` RLS policy (gestão sees the
 * whole tenant, a corretor only conversations for leads they own — see
 * `docs/WHATSAPP-OFFICIAL-ARCHITECTURE.md`), so a plain `.select()` with the
 * user's own session is both correct and sufficient; no server route is
 * needed for reading. Every WRITE the inbox performs goes through
 * `src/app/api/whatsapp-oficial/**` instead (see that directory's routes) —
 * these tables have no INSERT/UPDATE/DELETE policy at all (ADR D5/D10).
 *
 * WRITTEN FROM SCRATCH for this mission — adapted in spirit (not code) from
 * `src/lib/inbox/conversations.ts` (WACRM original): same idea of a shared
 * `*_SELECT` constant + a normalize step + client-side filtering over an
 * already-fetched list (harvest matrix area 5 note: the WACRM inbox filters
 * client-side over an array it already loaded, not via server-side query
 * params — the volume here, a single tenant's WhatsApp inbox, is small
 * enough that this remains the right trade-off rather than reimplementing
 * PostgREST embedded-resource filtering for every combination of status +
 * search + tag).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  InboxFilter,
  WhatsAppConversation,
  WhatsAppInternalNote,
  WhatsAppLeadSummary,
  WhatsAppMessage,
} from '@/types/whatsapp-oficial'

/**
 * `leads.nome`/`leads.name` is a legacy dual-column pair elsewhere in the
 * CRM (see `docs/WACRM-HARVEST-MATRIX.md`, and
 * `monitor_leads()`/`whatsapp_oficial_processar_inbound` both writing only
 * `name`). Select both and coalesce here rather than guessing which one a
 * given lead has populated.
 */
export const CONVERSATION_SELECT = `
  id, tenant_id, canal_id, lead_id, wa_contact_name, status, optout_em,
  ultima_mensagem_em, ultima_mensagem_preview, nao_lidas_corretor, created_at,
  lead:leads (
    id, nome, name, whatsapp, phone, etapa, temperatura, urgente,
    empreendimento_interesse_slug, corretor_id, status,
    corretor:corretores ( id, nome )
  )
`.trim()

export const MESSAGE_SELECT = `
  id, tenant_id, conversation_id, wamid, direction, message_type, content,
  media_url, media_mime_type, status, enviado_por, erro_code, erro_detalhe,
  wpp_timestamp, created_at
`.trim()

export const NOTE_SELECT = `id, conversation_id, autor_id, conteudo, created_at`

/** Raw shape PostgREST returns for {@link CONVERSATION_SELECT} before normalizing. */
interface RawLead {
  id: string
  nome: string | null
  name: string | null
  whatsapp: string | null
  phone: string | null
  etapa: string | null
  temperatura: string | null
  urgente: boolean | null
  empreendimento_interesse_slug: string | null
  corretor_id: string | null
  status: string | null
  corretor: { id: string; nome: string | null } | null
}

interface RawConversation extends Omit<WhatsAppConversation, 'lead'> {
  lead: RawLead | RawLead[] | null
}

function firstOrSelf<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value
}

/** Flattens the embedded `lead:leads(..., corretor:corretores(...))` join
 *  and coalesces the legacy `nome`/`name` pair into a single field. Supabase
 *  can return an embedded to-one relation as either an object or a 1-item
 *  array depending on FK introspection — {@link firstOrSelf} normalizes both. */
export function normalizeConversationRow(raw: RawConversation): WhatsAppConversation {
  const rawLead = firstOrSelf(raw.lead)
  let lead: WhatsAppLeadSummary | null = null
  if (rawLead) {
    lead = {
      id: rawLead.id,
      nome: (rawLead.nome?.trim() || rawLead.name?.trim()) ?? null,
      whatsapp: rawLead.whatsapp ?? rawLead.phone ?? null,
      etapa: rawLead.etapa,
      temperatura: rawLead.temperatura,
      urgente: rawLead.urgente ?? false,
      empreendimento_interesse_slug: rawLead.empreendimento_interesse_slug,
      corretor_id: rawLead.corretor_id,
      status: rawLead.status,
      corretor: firstOrSelf(rawLead.corretor as never),
    }
  }
  return { ...raw, lead }
}

export function normalizeConversationRows(rows: RawConversation[]): WhatsAppConversation[] {
  return rows.map(normalizeConversationRow)
}

/** Display name for a conversation's lead — falls back through the WhatsApp
 *  contact name Meta reported, then the raw phone number, matching what an
 *  agent scanning the list actually wants to see even for a brand-new lead
 *  that hasn't been named yet. */
export function leadDisplayName(conversation: WhatsAppConversation): string {
  return (
    conversation.lead?.nome?.trim() ||
    conversation.wa_contact_name?.trim() ||
    conversation.lead?.whatsapp ||
    'Contato sem nome'
  )
}

/** Whether a conversation passes the given {@link InboxFilter} (mission item 1). */
export function matchesInboxFilter(
  conversation: WhatsAppConversation,
  filter: InboxFilter,
): boolean {
  switch (filter) {
    case 'todas':
      return true
    case 'aberta':
    case 'pendente':
    case 'encerrada':
      return conversation.status === filter
    case 'sem_dono':
      return !conversation.lead?.corretor_id
    case 'urgente':
      return conversation.lead?.urgente === true
    default:
      return true
  }
}

/** Case/diacritic-insensitive substring match against the lead's name or phone. */
export function matchesSearch(conversation: WhatsAppConversation, query: string): boolean {
  const q = normalizeSearchable(query)
  if (!q) return true
  const name = normalizeSearchable(leadDisplayName(conversation))
  const phone = normalizeSearchable(conversation.lead?.whatsapp ?? '')
  return name.includes(q) || phone.includes(q)
}

function normalizeSearchable(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

/** Fetch conversations visible to the current session (RLS-scoped),
 *  freshest activity first. `limit` mirrors the WACRM inbox's own trade-off
 *  of loading a bounded recent set and filtering/searching client-side
 *  rather than paginating a live query per filter combination. */
export async function fetchConversations(
  supabase: SupabaseClient,
  limit = 300,
): Promise<{ data: WhatsAppConversation[]; error: string | null }> {
  const { data, error } = await supabase
    .from('whatsapp_conversations')
    .select(CONVERSATION_SELECT)
    .order('ultima_mensagem_em', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) return { data: [], error: error.message }
  return { data: normalizeConversationRows((data ?? []) as unknown as RawConversation[]), error: null }
}

/** Re-fetch a single conversation WITH its lead/corretor join. Used by the
 *  realtime handler: a `postgres_changes` payload only carries the row's own
 *  columns (no join), so an INSERT/UPDATE event re-fetches through here to
 *  get `lead`/`corretor` filled in — same self-heal idea as the WACRM
 *  original's `hydrateConversation` (harvest matrix area 5), simplified
 *  since this inbox does not need the WACRM version's dedup-in-flight
 *  bookkeeping (event volume here is far lower than a multi-account SaaS
 *  inbox). */
export async function fetchConversationById(
  supabase: SupabaseClient,
  id: string,
): Promise<WhatsAppConversation | null> {
  const { data, error } = await supabase
    .from('whatsapp_conversations')
    .select(CONVERSATION_SELECT)
    .eq('id', id)
    .maybeSingle()

  if (error || !data) return null
  return normalizeConversationRow(data as unknown as RawConversation)
}

export async function fetchMessages(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<{ data: WhatsAppMessage[]; error: string | null }> {
  const { data, error } = await supabase
    .from('whatsapp_messages')
    .select(MESSAGE_SELECT)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })

  if (error) return { data: [], error: error.message }
  return { data: (data ?? []) as unknown as WhatsAppMessage[], error: null }
}

export async function fetchInternalNotes(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<{ data: WhatsAppInternalNote[]; error: string | null }> {
  const { data, error } = await supabase
    .from('whatsapp_internal_notes')
    .select(NOTE_SELECT)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })

  if (error) return { data: [], error: error.message }
  return { data: (data ?? []) as unknown as WhatsAppInternalNote[], error: null }
}

/** Resolve a batch of `auth.users.id`s (note authors / message senders) to a
 *  display name via `corretores.user_id`. Gestão accounts without a
 *  `corretores` row (e.g. a pure admin/gestor login) simply have no entry in
 *  the returned map — callers fall back to a generic label ("Equipe"). No
 *  dedicated "profile/display name" table exists for CRM users today; this
 *  is the closest available mapping and is read-only/best-effort. */
export async function fetchAuthorNames(
  supabase: SupabaseClient,
  userIds: string[],
): Promise<Record<string, string>> {
  const ids = Array.from(new Set(userIds.filter(Boolean)))
  if (ids.length === 0) return {}

  const { data, error } = await supabase
    .from('corretores')
    .select('user_id, nome')
    .in('user_id', ids)

  if (error || !data) return {}

  const map: Record<string, string> = {}
  for (const row of data as Array<{ user_id: string | null; nome: string | null }>) {
    if (row.user_id && row.nome) map[row.user_id] = row.nome
  }
  return map
}
