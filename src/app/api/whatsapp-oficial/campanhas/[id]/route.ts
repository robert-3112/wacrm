import { NextResponse } from 'next/server'
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

/**
 * Detalhe de uma campanha + agregado dos destinatários.
 *
 * TUDO aqui é lido com o cliente COM SESSÃO. `whatsapp_broadcasts` e
 * `whatsapp_broadcast_recipients` só têm policy de SELECT para gestão, então a
 * RLS já é a autorização: se ela esconde a linha, `maybeSingle()` devolve null
 * e a rota responde 404 — mesmo 404 de um id inexistente, sem revelar que a
 * campanha existe para outra pessoa.
 *
 * O agregado é feito em JS (e não por RPC) porque `motivo_supressao` é
 * vocabulário aberto — a RPC de geração inventa o motivo. Ler as linhas com o
 * cliente do usuário mantém o agregado sob a mesma RLS do resto.
 */

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

const PAGINA_DESTINATARIOS = 1000
/** Teto de linhas lidas para o agregado. A campanha do bolsão pode ter ~12k
 *  destinatários; acima disso o agregado responde `truncado: true` em vez de
 *  varrer a tabela inteira a cada abertura de tela. */
const MAX_LINHAS_DESTINATARIOS = 20_000

interface DestinatarioAgregadoRow {
  status: string | null
  motivo_supressao: string | null
}

interface DestinatariosAgregado {
  total: number
  truncado: boolean
  por_status: Record<string, number>
  por_motivo_supressao: Record<string, number>
}

/**
 * Espia UMA linha logo depois do cursor, só para saber se o teto cortou algo.
 *
 * Existe porque "o total bateu no teto" e "havia mais gente" são coisas
 * diferentes: com exatamente MAX_LINHAS_DESTINATARIOS destinatários o agregado
 * está COMPLETO, e avisar `truncado: true` mandaria o operador procurar
 * destinatários não contabilizados que não existem. Mesmo critério do
 * `fetchMetaTemplates`, que só marca `truncated` quando ainda havia página
 * seguinte.
 */
async function existeLinhaAlemDoTeto(
  client: SupabaseClient,
  broadcastId: string,
  offset: number,
): Promise<boolean> {
  const { data, error } = await client
    .from('whatsapp_broadcast_recipients')
    .select('id')
    .eq('broadcast_id', broadcastId)
    .order('id', { ascending: true })
    .range(offset, offset)

  if (error) throw error
  return ((data ?? []) as unknown[]).length > 0
}

async function agregarDestinatarios(
  client: SupabaseClient,
  broadcastId: string,
): Promise<DestinatariosAgregado> {
  const porStatus: Record<string, number> = {}
  const porMotivo: Record<string, number> = {}
  let total = 0
  let truncado = false
  let offset = 0
  // O tamanho de página efetivo sai da PRIMEIRA resposta, não da constante: o
  // PostgREST tem um teto próprio (`db-max-rows`) que pode ser menor que
  // PAGINA_DESTINATARIOS. Parar em "veio menos que PAGINA_DESTINATARIOS"
  // contaria errado nesse caso — parar em "veio menos que a primeira página"
  // funciona com qualquer teto.
  let paginaEfetiva: number | null = null

  for (;;) {
    const { data, error } = await client
      .from('whatsapp_broadcast_recipients')
      .select('status, motivo_supressao')
      .eq('broadcast_id', broadcastId)
      // ORDER BY estável e ÚNICO em toda página. Sem ele o Postgres não promete
      // ordem nenhuma entre uma consulta e a seguinte: o `/campanhas/dispatch`
      // marcando `enfileirado_em` no meio da paginação faz linha reaparecer numa
      // página posterior (contada duas vezes) ou escapar para trás do cursor
      // (nunca contada), e o agregado sai errado sem erro nenhum. Numa campanha
      // do bolsão (~12k destinatários, várias páginas) isso é a regra, não a
      // exceção. `id` porque `created_at` empata em lote gerado na mesma tx.
      .order('id', { ascending: true })
      .range(offset, offset + PAGINA_DESTINATARIOS - 1)

    if (error) throw error

    const rows = (data ?? []) as DestinatarioAgregadoRow[]
    for (const row of rows) {
      const status = row.status ?? 'desconhecido'
      porStatus[status] = (porStatus[status] ?? 0) + 1
      if (row.motivo_supressao) {
        porMotivo[row.motivo_supressao] = (porMotivo[row.motivo_supressao] ?? 0) + 1
      }
    }
    total += rows.length
    if (paginaEfetiva === null) paginaEfetiva = rows.length

    if (rows.length === 0 || paginaEfetiva === 0 || rows.length < paginaEfetiva) break

    offset += rows.length
    if (offset >= MAX_LINHAS_DESTINATARIOS) {
      // Bater no teto não é o mesmo que ter sido cortado: a linha extra é quem
      // decide. A consulta a mais só acontece na campanha gigante que chegou
      // até aqui.
      truncado = await existeLinhaAlemDoTeto(client, broadcastId, offset)
      break
    }
  }

  return { total, truncado, por_status: porStatus, por_motivo_supressao: porMotivo }
}

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
    const { userId, supabaseUser } = await requireGestaoSession()

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

    const destinatarios = await agregarDestinatarios(supabaseUser, id)

    const linha = campanha as unknown as {
      template_id: string | null
      variaveis_padrao: VariaveisPadrao | null
    }
    const exigencias = await resolverExigencias(
      supabaseUser,
      linha.template_id,
      linha.variaveis_padrao,
    )

    return NextResponse.json({ ok: true, campanha, destinatarios, exigencias })
  } catch (error) {
    return toErrorResponse(error)
  }
}
