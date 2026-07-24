/**
 * Types for the official-channel shared inbox (Fase 6 — "SUNT WhatsApp Hub").
 *
 * WRITTEN FROM SCRATCH for this mission — mirrors the schema in
 * `supabase/migrations/20260723190000_whatsapp_oficial_foundation.sql` (SUNT
 * CRM repo, `docs/WHATSAPP-OFFICIAL-ARCHITECTURE.md`). Deliberately NOT the
 * same shape as `src/types/index.ts` (the original WACRM `Conversation`/
 * `Message`/`Contact`): that model is account_id/contact_id-scoped and does
 * not exist in this schema — see ADR-WHATSAPP-OFFICIAL-WACRM D2/D3.
 */

export type WhatsAppConversationStatus = 'aberta' | 'pendente' | 'encerrada'

export type WhatsAppMessageDirection = 'inbound' | 'outbound'

export type WhatsAppMessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'document'
  | 'audio'
  | 'template'
  | 'interactive'
  | 'sticker'
  | 'location'
  | 'contacts'
  | 'unsupported'

export type WhatsAppMessageStatus =
  | 'pendente'
  | 'enviada'
  | 'entregue'
  | 'lida'
  | 'falhou'
  | 'recebida'

/** `leads.etapa` — funnel stage. Kept loose (string) on purpose: the Hub
 *  only displays this value, it never validates/writes it (D3 — funnel
 *  stage ownership stays in the CRM). */
export type LeadEtapa = string

export interface WhatsAppLeadCorretor {
  id: string
  nome: string | null
}

/** Summary of the `public.leads` row a conversation is about — only the
 *  fields the inbox needs (sidebar + list). NOT the full lead record: the
 *  CRM (Lovable app) owns the full lead view (see the "abrir no CRM" link,
 *  mission item 5). */
export interface WhatsAppLeadSummary {
  id: string
  /** `leads.nome`/`leads.name` are a legacy dual pair — see
   *  `docs/WACRM-HARVEST-MATRIX.md` note on `coalesce(nome,name)` used
   *  elsewhere in the CRM. Normalized to a single `nome` by
   *  {@link normalizeConversationRow}. */
  nome: string | null
  whatsapp: string | null
  etapa: LeadEtapa | null
  temperatura: string | null
  urgente: boolean
  empreendimento_interesse_slug: string | null
  corretor_id: string | null
  status: string | null
  corretor: WhatsAppLeadCorretor | null
}

export interface WhatsAppConversation {
  id: string
  tenant_id: string
  canal_id: string
  lead_id: string
  wa_contact_name: string | null
  status: WhatsAppConversationStatus
  optout_em: string | null
  ultima_mensagem_em: string | null
  ultima_mensagem_preview: string | null
  nao_lidas_corretor: number
  created_at: string
  lead: WhatsAppLeadSummary | null
}

export interface WhatsAppMessage {
  id: string
  tenant_id: string
  conversation_id: string
  wamid: string | null
  direction: WhatsAppMessageDirection
  message_type: WhatsAppMessageType
  content: string | null
  media_url: string | null
  media_mime_type: string | null
  status: WhatsAppMessageStatus
  enviado_por: string | null
  erro_code: string | null
  erro_detalhe: string | null
  wpp_timestamp: string | null
  created_at: string
}

export interface WhatsAppInternalNote {
  id: string
  conversation_id: string
  autor_id: string | null
  conteudo: string
  created_at: string
}

/** Inbox list filter — mission item 1 ("aberta / pendente / encerrada /
 *  sem dono / urgente"), plus the implicit "all" default. */
export type InboxFilter = 'todas' | 'aberta' | 'pendente' | 'encerrada' | 'sem_dono' | 'urgente'
