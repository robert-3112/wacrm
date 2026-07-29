import { NextResponse } from 'next/server'
import { requireGestaoSession, toErrorResponse, BadRequestError } from '@/lib/whatsapp-oficial/api-auth'
import {
  WHATSAPP_OFICIAL_RATE_LIMITS,
  checkRateLimit,
  rateLimitResponse,
} from '@/lib/whatsapp-oficial/rate-limit'
import { validarVariaveisPadrao } from '@/lib/whatsapp-oficial/template-campos'

/**
 * Campanhas (broadcasts) do canal oficial — listar e criar.
 *
 * Duas metades com clientes deliberadamente diferentes:
 *
 * - GET usa o cliente COM SESSÃO. `whatsapp_broadcasts` tem policy de SELECT
 *   só para gestão, então a própria RLS é o filtro de autorização da lista —
 *   um corretor logado enxerga zero linhas em vez de 403. Ler com
 *   `service_role` aqui seria vazar a base inteira de campanhas para qualquer
 *   sessão válida.
 * - POST usa `service_role` porque a tabela não tem policy de INSERT: quem
 *   valida o papel do ator é a RPC `whatsapp_oficial_campanha_criar`
 *   (`whatsapp_campanha_ator_autorizado`, que levanta 42501 quando o ator não
 *   é gestão). A rota não duplica a regra de papel — ver o comentário de
 *   `requireGestaoSession`.
 *
 * Nada aqui envia mensagem: criar uma campanha só grava um rascunho.
 */

const NOME_MAX_LENGTH = 200
const LISTA_MAX_LINHAS = 100

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Espelha o CHECK `whatsapp_broadcasts_status_check`. */
const STATUS_VALIDOS = [
  'rascunho',
  'aguardando_aprovacao',
  'aprovado',
  'enviando',
  'pausado',
  'concluido',
  'cancelado',
] as const

/** Espelha o CHECK `whatsapp_broadcasts_politica_consentimento_valida`. */
const POLITICAS_CONSENTIMENTO = ['exigir_base_legal', 'apenas_optout'] as const

/** Espelha o CHECK `whatsapp_broadcasts_politica_handoff_valida`. */
const POLITICAS_HANDOFF = [
  'sophia_qualifica',
  'humano_direto',
  'sophia_rodizio',
  'personalizado',
] as const

const LISTA_SELECT = `
  id, tenant_id, canal_id, template_id, nome, status, provider,
  politica_consentimento, bases_legais, agendado_para, criado_por,
  aprovado_por, aprovado_em, iniciado_em, concluido_em, pausado_em,
  cancelado_em, destinatarios_gerados_em, dry_run_em,
  total_destinatarios, total_suprimidos, total_enviados, total_entregues,
  total_lidos, total_falhas, created_at
`.trim()

interface CriarCampanhaBody {
  canalId?: unknown
  nome?: unknown
  templateId?: unknown
  mensagemLivre?: unknown
  config?: unknown
}

interface CriarCampanhaResult {
  ok?: boolean
  reason?: string
  broadcast_id?: string
  status?: string
  provider?: string
  canal_status?: string
}

/**
 * Entrada semanticamente inválida responde 422 com um slug estável, e não 400
 * genérico: é o mesmo vocabulário que a RPC devolve em `reason`, então o
 * cliente trata "recusa de negócio" num lugar só, venha ela da validação da
 * rota ou do Postgres.
 */
function unprocessable(slug: string, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ error: slug, ...extra }, { status: 422 })
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { userId, supabaseUser } = await requireGestaoSession()

    const rl = checkRateLimit(
      `whatsapp-oficial-campanhas-list:${userId}`,
      WHATSAPP_OFICIAL_RATE_LIMITS.campanhaWrite,
    )
    if (!rl.success) return rateLimitResponse(rl)

    const params = new URL(request.url).searchParams
    const status = params.get('status')
    const canalId = params.get('canalId')

    if (status && !(STATUS_VALIDOS as readonly string[]).includes(status)) {
      return unprocessable('status_invalido')
    }
    // Um canalId fora do formato uuid faria o PostgREST devolver 22P02 e a rota
    // responder 500 por um erro que é do cliente.
    if (canalId && !UUID_RE.test(canalId)) {
      return unprocessable('canal_invalido')
    }

    let query = supabaseUser
      .from('whatsapp_broadcasts')
      .select(LISTA_SELECT)
      .order('created_at', { ascending: false })
      .limit(LISTA_MAX_LINHAS)

    if (status) query = query.eq('status', status)
    if (canalId) query = query.eq('canal_id', canalId)

    const { data, error } = await query
    if (error) throw error

    return NextResponse.json({ ok: true, campanhas: data ?? [] })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    // Autenticar ANTES de validar o corpo (invertido em relação a
    // `messages/send`): campanha é rota de gestão, então quem não tem sessão
    // não deve nem descobrir qual vocabulário de config a rota aceita.
    const { userId, admin } = await requireGestaoSession()

    const rl = checkRateLimit(
      `whatsapp-oficial-campanhas-criar:${userId}`,
      WHATSAPP_OFICIAL_RATE_LIMITS.campanhaWrite,
    )
    if (!rl.success) return rateLimitResponse(rl)

    const raw = (await request.json().catch(() => null)) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestError('invalid JSON body')
    }
    const body = raw as CriarCampanhaBody

    const canalId = typeof body.canalId === 'string' ? body.canalId.trim() : ''
    if (!canalId) return unprocessable('canal_obrigatorio')
    if (!UUID_RE.test(canalId)) return unprocessable('canal_invalido')

    const nome = typeof body.nome === 'string' ? body.nome.trim() : ''
    if (!nome) return unprocessable('nome_obrigatorio')
    if (nome.length > NOME_MAX_LENGTH) return unprocessable('nome_muito_longo')

    let templateId: string | null = null
    if (body.templateId !== undefined && body.templateId !== null) {
      if (typeof body.templateId !== 'string' || !UUID_RE.test(body.templateId)) {
        return unprocessable('template_invalido')
      }
      templateId = body.templateId
    }

    let mensagemLivre: string | null = null
    if (body.mensagemLivre !== undefined && body.mensagemLivre !== null) {
      if (typeof body.mensagemLivre !== 'string') return unprocessable('mensagem_livre_invalida')
      const trimmed = body.mensagemLivre.trim()
      mensagemLivre = trimmed.length > 0 ? trimmed : null
    }

    let config: Record<string, unknown> = {}
    if (body.config !== undefined && body.config !== null) {
      if (typeof body.config !== 'object' || Array.isArray(body.config)) {
        return unprocessable('config_invalida')
      }
      config = body.config as Record<string, unknown>
    }

    const basesLegais = config.bases_legais
    if (basesLegais !== undefined && basesLegais !== null) {
      if (!Array.isArray(basesLegais) || basesLegais.some((b) => typeof b !== 'string' || !b.trim())) {
        return unprocessable('bases_legais_invalida')
      }
      // Array vazio + politica 'exigir_base_legal' não erra em lugar nenhum: a
      // geração de destinatários simplesmente suprime TODO MUNDO e a campanha
      // parece "sem público elegível". Recusar aqui é o único ponto em que
      // essa pegadinha ainda é visível para quem está criando.
      if (basesLegais.length === 0) return unprocessable('bases_legais_vazia')
    }

    const politicaConsentimento = config.politica_consentimento
    if (
      politicaConsentimento !== undefined &&
      politicaConsentimento !== null &&
      !(POLITICAS_CONSENTIMENTO as readonly unknown[]).includes(politicaConsentimento)
    ) {
      return unprocessable('politica_consentimento_invalida')
    }

    // A RPC também recusa janela pela metade ('janela_incompleta'), mas parar
    // aqui poupa a viagem ao banco e devolve o mesmo slug. Valor presente e
    // não-textual (`''`, número) cai no mesmo balde de propósito: no Postgres
    // ele viraria 22007 no cast para `time`, ou seja, 500 por erro do cliente.
    const janelaInicio = config.janela_inicio
    const janelaFim = config.janela_fim
    if (
      (janelaInicio !== undefined && janelaInicio !== null) ||
      (janelaFim !== undefined && janelaFim !== null)
    ) {
      const inicioOk = typeof janelaInicio === 'string' && janelaInicio.trim().length > 0
      const fimOk = typeof janelaFim === 'string' && janelaFim.trim().length > 0
      if (!inicioOk || !fimOk) return unprocessable('janela_incompleta')
    }

    const janelaDias = config.janela_dias
    if (janelaDias !== undefined && janelaDias !== null) {
      if (!Array.isArray(janelaDias)) return unprocessable('janela_dias_invalida')
      // Mesma pegadinha de `bases_legais`: lista VAZIA não é "todo dia serve".
      // A RPC trata `[]` como vazia, então nenhum dia fica liberado e a campanha
      // nunca envia — sem erro em lugar nenhum. Quem quer o default omite a chave.
      if (janelaDias.length === 0) return unprocessable('janela_dias_vazia')
      // 1..7 = seg..dom (ISO), igual ao plantão do CRM.
      if (
        janelaDias.some(
          (dia) => typeof dia !== 'number' || !Number.isInteger(dia) || dia < 1 || dia > 7,
        )
      ) {
        return unprocessable('janela_dias_invalida')
      }
    }

    const politicaHandoff = config.politica_handoff
    if (
      politicaHandoff !== undefined &&
      politicaHandoff !== null &&
      !(POLITICAS_HANDOFF as readonly unknown[]).includes(politicaHandoff)
    ) {
      return unprocessable('politica_handoff_invalida')
    }

    // `variaveis_padrao` é WRITE-ONCE (não há RPC de edição de campanha nem
    // policy de UPDATE em `whatsapp_broadcasts`) e é copiado para CADA
    // destinatário na materialização. Forma errada aqui não erra em lugar
    // nenhum: a RPC faz um `coalesce` cru da chave, o adapter faz um cast, e o
    // defeito só aparece job a job no worker — depois de já existirem as linhas
    // de recipients, messages e outbox. Esta rota confere a FORMA e o TETO; o
    // mínimo ("faltou valor") é do banco, que é a única autoridade que
    // sobrevive a uma UI trocada.
    const recusa = validarVariaveisPadrao(config.variaveis_padrao)
    if (recusa) return unprocessable(recusa.slug, recusa.extra)

    const { data, error } = await admin.rpc('whatsapp_oficial_campanha_criar', {
      p_actor_user_id: userId,
      p_canal_id: canalId,
      p_nome: nome,
      p_template_id: templateId,
      p_mensagem_livre: mensagemLivre,
      p_config: config,
    })

    // 42501 (ator sem papel de gestão) vira 403 no `toErrorResponse`; qualquer
    // outro erro de banco vira 500 por lá mesmo.
    if (error) throw error

    const result = (data ?? null) as CriarCampanhaResult | null
    if (!result?.ok) {
      const reason = result?.reason ?? 'campanha_nao_criada'
      const status = reason === 'canal_nao_encontrado' ? 404 : 422
      return NextResponse.json({ error: reason }, { status })
    }

    return NextResponse.json(result, { status: 201 })
  } catch (error) {
    return toErrorResponse(error)
  }
}
