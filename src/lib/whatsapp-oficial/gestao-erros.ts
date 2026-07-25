/**
 * Tradução dos slugs de erro das rotas de gestão (templates e campanhas) para
 * frases que um operador entende, e dos vocabulários de status/supressão para
 * rótulos de tela.
 *
 * Por que existe um módulo só para isto: as rotas em
 * `src/app/api/whatsapp-oficial/{templates,campanhas}/**` respondem SEMPRE
 * `{ error: '<slug>' }` — `aprovador_igual_criador`, `sem_base_legal`,
 * `campanha_nao_editavel`. O slug é ótimo contrato de máquina e péssima
 * mensagem de tela: mostrado cru, ele faz o operador abrir chamado para
 * perguntar o que o sistema já sabia responder. A tradução mora aqui, longe
 * dos componentes, porque o MESMO slug aparece em três telas diferentes
 * (catálogo, lista de campanhas, detalhe) e uma cópia por tela divergiria.
 *
 * Regra de fallback: slug desconhecido NUNCA vira "erro inesperado". Ele é
 * devolvido como está — feio, mas verdadeiro e pesquisável no código. Inventar
 * um texto genérico esconderia justamente o caso novo que precisa de tradução.
 */

import type { CampanhaStatus, TemplateStatusAprovacao } from '@/types/whatsapp-oficial'

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

/**
 * Slug -> frase. Cobre os três vocabulários que chegam à tela:
 * o das rotas (validação de entrada), o das RPCs (`reason`) e o de
 * `toErrorResponse` (que responde com a MENSAGEM do erro, não com um slug —
 * daí `Unauthorized`/`Forbidden`/`Not found` estarem nesta mesma tabela).
 */
const MENSAGENS: Record<string, string> = {
  // -- api-auth / toErrorResponse -------------------------------------------
  Unauthorized: 'Sessão expirada. Entre novamente para continuar.',
  Forbidden: 'Seu usuário não tem papel de gestão para executar esta ação.',
  'Not found': 'Registro não encontrado.',
  'Internal server error': 'Erro interno do servidor. Tente de novo em instantes.',
  sem_permissao: 'Seu usuário não tem papel de gestão para executar esta ação.',

  // -- canal ----------------------------------------------------------------
  canal_obrigatorio: 'Escolha um canal antes de continuar.',
  canal_invalido: 'Canal inválido.',
  canal_nao_encontrado: 'Canal não encontrado (ou invisível para o seu usuário).',
  canal_de_outro_tenant: 'Este canal pertence a outra organização.',
  canal_inativo: 'O canal está inativo. Ative o canal antes de enviar.',
  canal_incompativel: 'O canal da campanha não atende este destinatário.',
  channel_lookup_failed: 'Não foi possível ler o canal. Tente de novo.',

  // -- credenciais / Meta ---------------------------------------------------
  credencial_ausente:
    'Canal sem WABA id e/ou access token configurado. Cadastre as credenciais da Meta antes de sincronizar.',
  credencial_invalida:
    'Não foi possível decifrar a credencial do canal. Recadastre o access token.',
  meta_api_error: 'A Meta recusou a chamada de sincronização.',
  meta_api_indisponivel: 'A Meta não respondeu. Tente sincronizar de novo em instantes.',
  provider_sem_template:
    'Só canais meta_cloud têm catálogo de templates aprovado na Meta. Este canal usa outro provider.',

  // -- templates ------------------------------------------------------------
  template_list_failed: 'Não foi possível carregar o catálogo de templates.',
  template_lookup_failed: 'Não foi possível ler o template.',
  template_sync_failed: 'A sincronização falhou. Nenhum template foi alterado.',
  template_sync_rejected: 'A sincronização foi recusada.',
  template_invalido: 'Template inválido.',
  template_nao_aprovado:
    'Este template ainda não está aprovado na Meta — só templates aprovados podem ser enviados.',
  template_de_outro_canal: 'Este template pertence a outro canal.',
  template_enqueue_rejected: 'O envio do template foi recusado.',
  variaveis_insuficientes: 'Faltam valores para as variáveis exigidas pelo template.',
  valores_demais: 'Você informou mais valores do que o template aceita.',
  valor_muito_longo: 'Um dos valores passa do tamanho máximo aceito.',

  // -- conversa / lead ------------------------------------------------------
  conversa_nao_encontrada: 'Conversa não encontrada (ou invisível para o seu usuário).',
  conversa_encerrada: 'A conversa está encerrada. Reabra antes de enviar.',
  lead_optout_ou_inativo: 'O lead pediu para não receber mensagens, ou está inativo.',

  // -- campanha: criação ----------------------------------------------------
  nome_obrigatorio: 'Dê um nome à campanha.',
  nome_muito_longo: 'O nome da campanha passa de 200 caracteres.',
  mensagem_livre_invalida: 'A mensagem livre é inválida.',
  config_invalida: 'A configuração da campanha é inválida.',
  campanha_nao_criada: 'A campanha não foi criada.',
  status_invalido_filtro: 'Filtro de status inválido.',
  bases_legais_invalida: 'Lista de bases legais inválida.',
  bases_legais_vazia:
    'Com a política "exigir base legal", uma lista vazia suprime todo mundo. Escolha ao menos uma base legal.',
  politica_consentimento_invalida: 'Política de consentimento fora do vocabulário aceito.',
  politica_handoff_invalida: 'Política de handoff fora do vocabulário aceito.',
  janela_incompleta: 'A janela de horário precisa de início E fim — ou de nenhum dos dois.',
  janela_dias_vazia:
    'Lista de dias vazia não é "todo dia serve": ela bloqueia todos. Deixe em branco para usar o padrão.',
  janela_dias_invalida: 'Dias da janela inválidos — use inteiros de 1 (segunda) a 7 (domingo).',

  // -- campanha: ciclo de vida ---------------------------------------------
  campanha_nao_encontrada: 'Campanha não encontrada (ou invisível para o seu usuário).',
  campanha_nao_editavel:
    'A campanha já saiu do rascunho. Só rascunho e aguardando aprovação aceitam gerar público.',
  status_invalido: 'A campanha não está num status que permita esta ação.',
  aprovador_igual_criador:
    'Quem criou a campanha não pode aprová-la. Peça a outra pessoa da gestão para aprovar (regra dos quatro olhos).',
  destinatarios_nao_gerados: 'Gere o público da campanha antes de aprovar.',
  sem_destinatario_elegivel:
    'O público gerado não tem nenhum destinatário elegível — todos foram suprimidos.',
  sem_aprovador:
    'A campanha perdeu a aprovação. Ela precisa ser aprovada de novo antes de retomar.',
  campanha_nao_aprovada: 'A campanha não foi aprovada.',
  campanha_nao_pausada: 'A campanha não foi pausada.',
  campanha_nao_retomada: 'A campanha não foi retomada.',
  campanha_nao_cancelada: 'A campanha não foi cancelada.',
  limite_invalido: 'O limite precisa ser um número inteiro maior que zero.',
  motivo_invalido: 'Motivo inválido.',
  destinatarios_nao_gerados_resposta: 'O público não foi gerado.',
}

/** Status HTTP -> frase, para quando a resposta não trouxe slug nenhum. */
const POR_STATUS: Record<number, string> = {
  401: 'Sessão expirada. Entre novamente para continuar.',
  403: 'Seu usuário não tem papel de gestão para executar esta ação.',
  404: 'Registro não encontrado.',
  429: 'Muitas requisições seguidas. Aguarde um instante e tente de novo.',
  500: 'Erro interno do servidor. Tente de novo em instantes.',
  502: 'Serviço externo indisponível. Tente de novo em instantes.',
  503: 'Serviço indisponível no momento.',
}

/**
 * Traduz um slug de erro. `status` só é usado quando o slug é vazio/ausente —
 * um slug conhecido sempre ganha do genérico por status, porque ele é mais
 * específico (`aprovador_igual_criador` diz muito mais que "conflito").
 */
export function traduzirErro(slug: string | null | undefined, status?: number): string {
  const chave = (slug ?? '').trim()
  if (chave && MENSAGENS[chave]) return MENSAGENS[chave]
  if (chave) return chave
  if (status && POR_STATUS[status]) return POR_STATUS[status]
  return 'Não foi possível concluir a ação.'
}

// ---------------------------------------------------------------------------
// Motivos de supressão
// ---------------------------------------------------------------------------

/**
 * Ordem DETERMINÍSTICA em que a RPC aplica a supressão (ver o comentário da
 * `whatsapp_oficial_campanha_gerar_destinatarios`: telefone_invalido >
 * lead_inativo > ... > duplicado). A tela lista nesta mesma ordem quando há
 * empate de contagem, para o operador reconhecer a cascata que o banco aplicou
 * em vez de ver os motivos embaralhados a cada abertura.
 */
export const MOTIVOS_SUPRESSAO_ORDEM = [
  'telefone_invalido',
  'lead_inativo',
  'optout_lead',
  'optout_conversa',
  'consentimento_revogado',
  'sem_base_legal',
  'ja_contatado_ops',
  'cooldown',
  'canal_incompativel',
  'duplicado',
] as const

export type MotivoSupressao = (typeof MOTIVOS_SUPRESSAO_ORDEM)[number]

interface MotivoTexto {
  rotulo: string
  descricao: string
}

const MOTIVOS_SUPRESSAO: Record<MotivoSupressao, MotivoTexto> = {
  telefone_invalido: {
    rotulo: 'Telefone inválido',
    descricao: 'O número do lead não passa na normalização — não dá para montar um destino.',
  },
  lead_inativo: {
    rotulo: 'Lead inativo',
    descricao: 'O lead está marcado como inativo/saído no CRM.',
  },
  optout_lead: {
    rotulo: 'Opt-out do lead',
    descricao: 'O lead pediu para não receber mensagens.',
  },
  optout_conversa: {
    rotulo: 'Opt-out na conversa',
    descricao: 'A conversa deste lead no canal oficial tem opt-out registrado.',
  },
  consentimento_revogado: {
    rotulo: 'Consentimento revogado',
    descricao: 'O consentimento que autorizava o contato foi revogado.',
  },
  sem_base_legal: {
    rotulo: 'Sem base legal',
    descricao:
      'A política da campanha exige base legal e este lead não tem nenhuma das bases aceitas.',
  },
  ja_contatado_ops: {
    rotulo: 'Já contatado (ops)',
    descricao: 'Já houve um primeiro contato registrado por outro disparo operacional.',
  },
  cooldown: {
    rotulo: 'Em cooldown',
    descricao: 'O lead recebeu mensagem há menos tempo que o cooldown configurado na campanha.',
  },
  canal_incompativel: {
    rotulo: 'Canal incompatível',
    descricao: 'O lead não pode ser atendido pelo canal escolhido para esta campanha.',
  },
  duplicado: {
    rotulo: 'Duplicado',
    descricao:
      'Outro lead com o mesmo telefone canônico já entrou no público — só o primeiro sobrevive.',
  },
}

function isMotivoConhecido(slug: string): slug is MotivoSupressao {
  return slug in MOTIVOS_SUPRESSAO
}

/** Rótulo curto de um motivo de supressão. Motivo novo (a RPC inventa o
 *  vocabulário) volta como está, para não sumir da tela. */
export function rotuloMotivoSupressao(slug: string): string {
  return isMotivoConhecido(slug) ? MOTIVOS_SUPRESSAO[slug].rotulo : slug
}

/** Explicação de uma linha. Vazia para motivo desconhecido — melhor não dizer
 *  nada do que inventar a regra que suprimiu alguém. */
export function descricaoMotivoSupressao(slug: string): string {
  return isMotivoConhecido(slug) ? MOTIVOS_SUPRESSAO[slug].descricao : ''
}

// ---------------------------------------------------------------------------
// Rótulos de status
// ---------------------------------------------------------------------------

const STATUS_TEMPLATE: Record<TemplateStatusAprovacao, string> = {
  rascunho: 'Rascunho',
  pendente: 'Em análise',
  aprovado: 'Aprovado',
  rejeitado: 'Rejeitado',
  pausado: 'Pausado',
  desabilitado: 'Desabilitado',
  em_apelacao: 'Em apelação',
  exclusao_pendente: 'Exclusão pendente',
}

export function rotuloStatusTemplate(status: string): string {
  return STATUS_TEMPLATE[status as TemplateStatusAprovacao] ?? status
}

/** Só `aprovado` pode ser enviado — é a regra que a RPC de enfileiramento
 *  aplica (`template_nao_aprovado`). A tela repete a mesma regra em vez de
 *  deduzi-la de "não é rejeitado". */
export function templatePodeEnviar(status: string): boolean {
  return status === 'aprovado'
}

/** Status que exigem atenção do operador: o template está no catálogo mas
 *  quebrado/bloqueado do lado da Meta. */
export function templateEmAlerta(status: string): boolean {
  return status === 'rejeitado' || status === 'pausado' || status === 'desabilitado'
}

const STATUS_CAMPANHA: Record<CampanhaStatus, string> = {
  rascunho: 'Rascunho',
  aguardando_aprovacao: 'Aguardando aprovação',
  aprovado: 'Aprovada',
  enviando: 'Enfileirando',
  pausado: 'Pausada',
  concluido: 'Concluída',
  cancelado: 'Cancelada',
}

export function rotuloStatusCampanha(status: string): string {
  return STATUS_CAMPANHA[status as CampanhaStatus] ?? status
}

const STATUS_DESTINATARIO: Record<string, string> = {
  pendente: 'Pendente',
  enfileirado: 'Enfileirado',
  enviado: 'Enfileirado no provedor',
  entregue: 'Entregue',
  lido: 'Lido',
  falhou: 'Falhou',
  suprimido: 'Suprimido',
  cancelado: 'Cancelado',
  desconhecido: 'Desconhecido',
}

export function rotuloStatusDestinatario(status: string): string {
  return STATUS_DESTINATARIO[status] ?? status
}
