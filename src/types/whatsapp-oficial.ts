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

// ---------------------------------------------------------------------------
// Gestão do canal oficial — canais, templates e campanhas (Sessão 2)
// ---------------------------------------------------------------------------

/**
 * Canal como as telas de gestão o enxergam.
 *
 * É um SUBCONJUNTO de `public.whatsapp_channels`, escolhido a dedo: nada aqui
 * pode chegar perto de `access_token_cifrado`/`evolution_api_key_cifrado`. As
 * telas precisam de nome, provider e status para escolher o canal e para
 * explicar por que uma ação não está disponível (sync só existe em
 * `meta_cloud`; canal `inativo` faz a RPC recusar o envio).
 */
export interface WhatsAppCanal {
  id: string
  nome: string
  provider: string
  status: string
  numero_display: string | null
  is_default: boolean
}

/** Espelha o CHECK de `whatsapp_templates.status_aprovacao` — mesmo
 *  vocabulário que `mapMetaStatusToSunt` produz no sync. */
export type TemplateStatusAprovacao =
  | 'rascunho'
  | 'pendente'
  | 'aprovado'
  | 'rejeitado'
  | 'pausado'
  | 'desabilitado'
  | 'em_apelacao'
  | 'exclusao_pendente'

/** Variáveis exigidas por um botão (a posição no array É a identidade do
 *  botão no envio — ver `template-send-builder`). */
export interface TemplateBotaoVariaveis {
  indice: number
  tipo: string
  variaveis: number[]
}

/** Conteúdo da coluna `whatsapp_templates.variaveis`, recalculada pelo banco
 *  a cada sync. É a fonte que a RPC de enfileiramento confere. */
export interface TemplateVariaveis {
  cabecalho: number[]
  corpo: number[]
  botoes: TemplateBotaoVariaveis[]
}

/**
 * Valores de envio gravados em `whatsapp_broadcasts.variaveis_padrao`, copiados
 * para cada `whatsapp_broadcast_recipients.variaveis` na materialização do
 * público e daí para `payload.messageParams` do job.
 *
 * É EXATAMENTE o `SendTimeParams` de `template-send-builder.ts` — o adapter
 * `meta_cloud` faz um cast direto do jsonb para aquele tipo, sem zod nem
 * validação de campo. Chave fora desta lista é descartada em silêncio: um
 * `{ "nome": "Ana" }` ou `{ "corpo": [...] }` (o vocabulário do PREVIEW, que é
 * outro) atravessa o banco inteiro sem uma reclamação e só aparece no envio
 * como "only 0 value(s) were supplied", apontando para o lugar errado.
 */
export interface VariaveisPadrao {
  /** Valores de `{{1}}, {{2}}, …` do CORPO, por POSIÇÃO (denso, 0-indexado). */
  body?: string[]
  /** Cabeçalho de TEXTO consome UMA string, não array — o builder emite um
   *  parâmetro só por header, mesmo que o texto tenha vários `{{N}}`. */
  headerText?: string
  /** Link da mídia de um header IMAGE/VIDEO/DOCUMENT. */
  headerMediaUrl?: string
  /** Alternativa ao link: id de mídia já subida na Meta. */
  headerMediaId?: string
  /** Por POSIÇÃO do botão (0-based). No jsonb a chave vira string (`"0"`), e o
   *  builder acessa por índice numérico — a coerção do JS resolve. */
  buttonParams?: Record<number, string>
}

/** Uma linha de `GET /api/whatsapp-oficial/templates` (o blob `componentes`
 *  fica de fora de propósito — só o preview precisa dele; a rota devolve no
 *  lugar os dois fatos derivados que a tela precisa saber sobre ele). */
export interface WhatsAppTemplate {
  id: string
  canal_id: string
  meta_template_id: string | null
  nome: string
  idioma: string
  categoria: string | null
  status_aprovacao: TemplateStatusAprovacao
  quality_score: string | null
  corpo_texto: string | null
  cabecalho_texto: string | null
  cabecalho_formato: string | null
  rodape_texto: string | null
  variaveis: TemplateVariaveis | null
  motivo_rejeicao: string | null
  sincronizado_em: string | null
  /**
   * Tipos dos blocos de `componentes`, em MAIÚSCULA e na ordem em que aparecem
   * — derivado pela rota, que não devolve o blob. É o que permite marcar como
   * NÃO SELECIONÁVEL um template cuja forma o envio não sabe montar (CAROUSEL,
   * LIMITED_TIME_OFFER, …) em vez de descobrir isso destinatário a
   * destinatário.
   *
   * `null` significa "o blob não é um array" — template malformado, que o
   * builder recusa inteiro. Não é o mesmo que `[]` (array sem blocos).
   */
  tipos_componentes: string[] | null
  /**
   * O HEADER de mídia tem `example.header_url[0]` preenchido. É o ÚNICO
   * fallback que o builder aceita quando ninguém informa a mídia no envio —
   * medido em produção (2026-07-29), o `image_cta` real NÃO tem, então na
   * prática o link precisa ser digitado.
   */
  cabecalho_midia_exemplo: boolean
}

/** Resposta de `POST /api/whatsapp-oficial/templates/sync`. */
export interface TemplateSyncResultado {
  ok: true
  total: number
  inseridos: number
  atualizados: number
  inalterados: number
  ignorados: number
  truncado: boolean
  erros: unknown[]
  /** Só vem quando `truncado` — texto pronto, montado pela rota. */
  aviso?: string
}

/** Preview textual renderizado — `botoes` vem do bloco BUTTONS do template. */
export interface TemplatePreviewRenderizado {
  cabecalho: string | null
  corpo: string
  rodape: string | null
  botoes: { indice: number; tipo: string; texto: string }[]
}

export interface TemplatePreviewValidacao {
  ok: boolean
  faltando: { onde: 'cabecalho' | 'corpo'; exigidas: number; fornecidas: number }[]
}

/** Resposta de `POST /api/whatsapp-oficial/templates/preview`. */
export interface TemplatePreviewResposta {
  templateId: string
  nome: string
  idioma: string
  statusAprovacao: TemplateStatusAprovacao
  preview: TemplatePreviewRenderizado
  variaveis: TemplateVariaveis
  validacao: TemplatePreviewValidacao
}

/** Espelha o CHECK `whatsapp_broadcasts_status_check`. */
export type CampanhaStatus =
  | 'rascunho'
  | 'aguardando_aprovacao'
  | 'aprovado'
  | 'enviando'
  | 'pausado'
  | 'concluido'
  | 'cancelado'

/** Uma linha de `GET /api/whatsapp-oficial/campanhas` (LISTA_SELECT da rota). */
export interface CampanhaResumo {
  id: string
  tenant_id: string
  canal_id: string
  template_id: string | null
  nome: string
  status: CampanhaStatus
  provider: string | null
  politica_consentimento: string | null
  bases_legais: string[] | null
  agendado_para: string | null
  criado_por: string | null
  aprovado_por: string | null
  aprovado_em: string | null
  iniciado_em: string | null
  concluido_em: string | null
  pausado_em: string | null
  cancelado_em: string | null
  destinatarios_gerados_em: string | null
  dry_run_em: string | null
  total_destinatarios: number | null
  total_suprimidos: number | null
  total_enviados: number | null
  total_entregues: number | null
  total_lidos: number | null
  total_falhas: number | null
  created_at: string
}

/** `whatsapp_broadcasts.dry_run_resultado` — gravado tanto pelo dry-run
 *  quanto pela materialização (as duas passam pelo mesmo cálculo). */
export interface DryRunResultado {
  elegiveis?: number
  suprimidos?: number
  por_motivo?: Record<string, number>
  limite_aplicado?: number | null
  gerado_em?: string
}

/** Detalhe completo (DETALHE_SELECT da rota `[id]`). */
export interface CampanhaDetalhe extends CampanhaResumo {
  mensagem_livre: string | null
  segmentacao: Record<string, unknown> | null
  variaveis_padrao: VariaveisPadrao | null
  cadencia_segundos: number | null
  limite_diario: number | null
  lote_max: number | null
  cooldown_dias: number | null
  janela_inicio: string | null
  janela_fim: string | null
  janela_dias: number[] | null
  empreendimento_id: string | null
  empreendimento_slug: string | null
  perfil_sophia: string | null
  politica_handoff: string | null
  handoff_config: Record<string, unknown> | null
  pausado_por: string | null
  cancelado_por: string | null
  motivo_cancelamento: string | null
  dry_run_resultado: DryRunResultado | null
  ultimo_envio_em: string | null
}

/** Agregado que a rota de detalhe calcula em JS sobre
 *  `whatsapp_broadcast_recipients` (só existe depois de materializar). */
export interface DestinatariosAgregado {
  total: number
  truncado: boolean
  por_status: Record<string, number>
  por_motivo_supressao: Record<string, number>
}

/**
 * O que o template da campanha ainda exige, resolvido NO SERVIDOR na abertura
 * da tela de detalhe.
 *
 * Existe porque `variaveis_padrao` é WRITE-ONCE — não há RPC de edição de
 * campanha nem policy de UPDATE em `whatsapp_broadcasts` — e é copiado para
 * cada destinatário na materialização. Sem isto o operador aprova às cegas uma
 * campanha cujo envio vai falhar com 422 permanente no primeiro disparo, e o
 * único conserto é cancelar e recriar.
 *
 * `null` quando a campanha não tem template (Evolution/mensagem livre) ou
 * quando o template sumiu do catálogo.
 */
export interface CampanhaExigenciasTemplate {
  templateId: string
  nome: string
  /** Rótulos legíveis do que falta. Vazio = a campanha tem tudo que precisa. */
  faltando: string[]
  /** Motivo pelo qual o template inteiro não pode ser enviado (CAROUSEL etc.). */
  naoSuportado: string | null
}

export interface CampanhaDetalheResposta {
  ok: true
  campanha: CampanhaDetalhe
  destinatarios: DestinatariosAgregado
  exigencias: CampanhaExigenciasTemplate | null
}

/** Resposta de `POST /campanhas/[id]/destinatarios`. Os dois modos devolvem
 *  formas diferentes: dry-run traz `a_enfileirar` + `amostra`, a
 *  materialização traz `linhas_gravadas`. */
export interface GerarDestinatariosResultado {
  ok: true
  dry_run: boolean
  elegiveis: number
  suprimidos: number
  por_motivo: Record<string, number>
  a_enfileirar?: number
  linhas_gravadas?: number
  amostra?: { lead_id: string; telefone: string }[]
}

/**
 * Estado das travas de saída, resolvido NO SERVIDOR e passado pronto para a
 * tela. Só booleanos derivados chegam ao cliente — nunca o nome ou o valor
 * cru de uma env var.
 */
export interface TravasSaida {
  /** `WHATSAPP_OUTBOUND_MODE` — 'shadow' significa que nada sai de verdade. */
  modo: 'shadow' | 'live'
  /** `WHATSAPP_BROADCAST_ENABLED` (env do worker). */
  broadcastEnvLigado: boolean
  /** `crm_config.whatsapp_broadcast_enabled` (kill switch no banco).
   *  `null` = não foi possível ler (não assumir "ligado"). */
  broadcastBancoLigado: boolean | null
  /** Envio real habilitado por provider (já combina modo + trava do provider). */
  envioMetaLigado: boolean
  envioEvolutionLigado: boolean
  /** `WHATSAPP_PILOT_MODE` — restringe destinatários reais à allowlist. */
  pilotoLigado: boolean
}
