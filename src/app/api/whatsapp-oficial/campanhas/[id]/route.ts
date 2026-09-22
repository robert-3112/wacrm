import { NextResponse } from 'next/server'
import { carregarResumoCampanhas } from '@/lib/whatsapp-oficial/campanha-evidencia'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireGestaoSession, toErrorResponse, NotFoundError } from '@/lib/whatsapp-oficial/api-auth'
import {
  WHATSAPP_OFICIAL_RATE_LIMITS,
  checkRateLimit,
  rateLimitResponse,
} from '@/lib/whatsapp-oficial/rate-limit'
import {
  faltandoNaCampanha,
  motivoTemplateNaoSuportado,
  resumirComponentes,
} from '@/lib/whatsapp-oficial/template-campos'
import type {
  CampanhaExigenciasTemplate,
  TemplateVariaveis,
  VariaveisPadrao,
} from '@/types/whatsapp-oficial'

/** A sessão autoriza a campanha por RLS antes da RPC agregada de service_role.
 * Campanha invisível e inexistente retornam o mesmo 404, sem chamar a RPC. */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const DETALHE_SELECT = `
  id, tenant_id, canal_id, template_id, nome, status, provider, mensagem_livre,
  segmentacao, variaveis_padrao, politica_consentimento, bases_legais,
  cadencia_segundos, limite_diario, lote_max, cooldown_dias,
  janela_inicio, janela_fim, janela_dias,
  empreendimento_id, empreendimento_slug, perfil_sophia, politica_handoff,
  handoff_config, agendado_para, criado_por, aprovado_por, aprovado_em,
  iniciado_em, concluido_em, pausado_em, pausado_por, cancelado_em,
  cancelado_por, motivo_cancelamento, dry_run_em, dry_run_resultado,
  destinatarios_gerados_em, ultimo_envio_em,
  total_destinatarios, total_suprimidos, total_enviados, total_entregues,
  total_lidos, total_falhas, created_at
`.trim()

interface TemplateDaCampanhaRow {
  id: string
  nome: string | null
  variaveis: TemplateVariaveis | null
  cabecalho_formato: string | null
  cabecalho_texto: string | null
  corpo_texto: string | null
  componentes: unknown
}

/**
 * O que o template da campanha ainda exige — resolvido AQUI, no servidor, e não
 * na tela.
 *
 * A tela de detalhe não tem o catálogo em mãos (ela abre por id de campanha,
 * vinda de qualquer lugar), e a pergunta que ela precisa responder é a mais
 * cara de errar do fluxo: `variaveis_padrao` é WRITE-ONCE e é copiado para cada
 * destinatário na materialização, então aprovar uma campanha com valor faltando
 * é aprovar um envio que morre com 422 PERMANENTE no primeiro disparo, sem
 * conserto que não seja cancelar e recriar.
 *
 * A leitura usa o MESMO cliente com sessão do resto da rota: `whatsapp_templates`
 * só tem policy de SELECT para gestão, e ler o template com `service_role` aqui
 * seria o único ponto do arquivo capaz de vazar catálogo de outro tenant.
 */
async function resolverExigencias(
  client: SupabaseClient,
  templateId: string | null,
  variaveisPadrao: VariaveisPadrao | null,
): Promise<CampanhaExigenciasTemplate | null> {
  if (!templateId) return null

  const { data, error } = await client
    .from('whatsapp_templates')
    .select('id, nome, variaveis, cabecalho_formato, cabecalho_texto, corpo_texto, componentes')
    .eq('id', templateId)
    .maybeSingle()

  if (error) throw error
  // Template sumiu do catálogo (ou a RLS o esconde): não dá para afirmar que
  // falta algo, e inventar um veredito seria pior que não ter nenhum.
  if (!data) return null

  const template = data as unknown as TemplateDaCampanhaRow
  const resumo = resumirComponentes(template.componentes)

  return {
    templateId: template.id,
    nome: template.nome ?? '',
    faltando: faltandoNaCampanha(
      {
        variaveis: template.variaveis,
        cabecalho_formato: template.cabecalho_formato,
        cabecalho_texto: template.cabecalho_texto,
        corpo_texto: template.corpo_texto,
        cabecalho_midia_exemplo: resumo.cabecalhoMidiaExemplo,
      },
      variaveisPadrao,
    ),
    // O FORMATO do cabeçalho entra junto: olhar só os tipos de bloco deixava passar
    // `HEADER/LOCATION`, para o qual esta rota devolveria `faltando: []` e a tela liberaria o
    // botão Aprovar que o banco recusa — exatamente o aviso que este endpoint existe para dar.
    naoSuportado: motivoTemplateNaoSuportado({
      tipos_componentes: resumo.tipos,
      cabecalho_formato: template.cabecalho_formato,
    }),
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params
    const { userId, supabaseUser, admin } = await requireGestaoSession()

    const rl = checkRateLimit(
      `whatsapp-oficial-campanhas-detalhe:${userId}`,
      WHATSAPP_OFICIAL_RATE_LIMITS.campanhaWrite,
    )
    if (!rl.success) return rateLimitResponse(rl)

    // Id fora do formato uuid não é 500 do PostgREST (22P02): nenhuma campanha
    // pode ter esse id, então é o mesmo 404 de "não existe / RLS escondeu".
    if (!UUID_RE.test(id)) throw new NotFoundError('Campanha não encontrada')

    const { data: campanha, error } = await supabaseUser
      .from('whatsapp_broadcasts')
      .select(DETALHE_SELECT)
      .eq('id', id)
      .maybeSingle()

    if (error) throw error
    if (!campanha) throw new NotFoundError('Campanha não encontrada')

    const [comResumo] = await carregarResumoCampanhas(admin, [campanha as unknown as { id: string; tenant_id: string }])
    const destinatarios = comResumo.resumo

    const linha = campanha as unknown as {
      template_id: string | null
      variaveis_padrao: VariaveisPadrao | null
    }
    const exigencias = await resolverExigencias(
      supabaseUser,
      linha.template_id,
      linha.variaveis_padrao,
    )

    return NextResponse.json({ ok: true, campanha: comResumo, destinatarios, exigencias })
  } catch (error) {
    return toErrorResponse(error)
  }
}
