/**
 * Cálculo do "quem entra e quem foi suprimido" que a tela de detalhe mostra
 * ANTES de alguém aprovar uma campanha.
 *
 * Existe separado dos componentes porque o número na tela vem de DUAS fontes
 * que nem sempre concordam, e escolher entre elas é regra de negócio, não
 * layout:
 *
 *  - `campanha.dry_run_resultado` — o resumo do último cálculo, gravado tanto
 *    pelo dry-run quanto pela materialização. Existe mesmo quando nenhum
 *    destinatário foi gravado.
 *  - `destinatarios` (agregado da rota sobre `whatsapp_broadcast_recipients`)
 *    — só existe DEPOIS de materializar, e é o que o dispatch vai usar de
 *    verdade.
 *
 * Quando as duas existem, a materializada ganha: ela é o público real. O
 * dry-run pode ter sido rodado antes de uma mudança de segmentação e mostrar
 * um número que já não vale — e é exatamente esse número que faria alguém
 * aprovar a campanha errada.
 */

import { MOTIVOS_SUPRESSAO_ORDEM, rotuloMotivoSupressao } from './gestao-erros'
import type { CampanhaDetalhe, DestinatariosAgregado } from '@/types/whatsapp-oficial'

/** Índice do motivo na cascata da RPC; motivo novo vai para o fim. */
const ORDEM_MOTIVO = new Map<string, number>(
  MOTIVOS_SUPRESSAO_ORDEM.map((motivo, i) => [motivo, i]),
)

export interface LinhaSupressao {
  slug: string
  rotulo: string
  total: number
  /** Fatia deste motivo sobre o total de suprimidos, 0..100. */
  percentual: number
}

/**
 * Transforma `{motivo: qtd}` na lista ordenada que a tela renderiza.
 *
 * Ordena por contagem decrescente e, no empate, pela ordem da cascata do
 * banco. Empate é o caso comum em campanha pequena (três motivos com 1 cada),
 * e sem o segundo critério a ordem viria do `Object.keys` — estável dentro de
 * uma resposta, mas diferente entre duas respostas, fazendo a lista dançar a
 * cada refresh sem nada ter mudado.
 *
 * Chave com contagem 0 é descartada: a RPC não produz zeros, mas um
 * `por_motivo` vindo de um dry-run antigo pode ter, e "0 suprimidos por
 * cooldown" só polui a leitura.
 */
export function resumirSupressoes(
  porMotivo: Record<string, number> | null | undefined,
): LinhaSupressao[] {
  const entradas = Object.entries(porMotivo ?? {}).filter(
    ([, total]) => typeof total === 'number' && Number.isFinite(total) && total > 0,
  )

  const soma = entradas.reduce((acc, [, total]) => acc + total, 0)

  return entradas
    .map(([slug, total]) => ({
      slug,
      rotulo: rotuloMotivoSupressao(slug),
      total,
      // Sem casas decimais: a tela mostra "43%" ao lado do número absoluto,
      // que é quem manda. O percentual é só para bater o olho.
      percentual: soma > 0 ? Math.round((total / soma) * 100) : 0,
    }))
    .sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total
      const oa = ORDEM_MOTIVO.get(a.slug) ?? Number.MAX_SAFE_INTEGER
      const ob = ORDEM_MOTIVO.get(b.slug) ?? Number.MAX_SAFE_INTEGER
      if (oa !== ob) return oa - ob
      return a.slug.localeCompare(b.slug)
    })
}

export type FontePublico = 'materializado' | 'dry_run' | 'nenhuma'

export interface PublicoResolvido {
  /** De onde vieram os números — a tela precisa DIZER isso, porque
   *  "simulado" e "gravado" têm consequências diferentes. */
  fonte: FontePublico
  elegiveis: number
  suprimidos: number
  supressoes: LinhaSupressao[]
  /** Quando o agregado bateu no teto de leitura da rota (campanha do bolsão). */
  truncado: boolean
  /** ISO do momento em que o número foi produzido, quando conhecido. */
  calculadoEm: string | null
  /** Teto aplicado no último cálculo (`limite`), quando houve. */
  limiteAplicado: number | null
}

function numeroOuZero(valor: unknown): number {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : 0
}

/**
 * Decide qual fonte descreve o público da campanha e devolve tudo já pronto
 * para a tela.
 *
 * "Materializado" é reconhecido por `destinatarios_gerados_em` + agregado com
 * linhas — e não só pelo agregado ter `total > 0`: o agregado é lido sob RLS e
 * uma campanha visível cujos destinatários ainda não foram gravados devolve
 * `total: 0`, que é indistinguível de "gerou e todo mundo foi suprimido" se
 * olharmos só o número.
 */
export function resolverPublico(
  campanha: Pick<CampanhaDetalhe, 'destinatarios_gerados_em' | 'dry_run_em' | 'dry_run_resultado'>,
  destinatarios: DestinatariosAgregado | null | undefined,
): PublicoResolvido {
  const agregado = destinatarios ?? null
  const materializou = Boolean(campanha.destinatarios_gerados_em) && (agregado?.total ?? 0) > 0

  if (materializou && agregado) {
    const suprimidos = agregado.por_status.suprimido ?? 0
    return {
      fonte: 'materializado',
      elegiveis: agregado.total - suprimidos,
      suprimidos,
      supressoes: resumirSupressoes(agregado.por_motivo_supressao),
      truncado: agregado.truncado,
      calculadoEm: campanha.destinatarios_gerados_em,
      limiteAplicado: campanha.dry_run_resultado?.limite_aplicado ?? null,
    }
  }

  const dry = campanha.dry_run_resultado
  if (dry && (campanha.dry_run_em || dry.gerado_em)) {
    return {
      fonte: 'dry_run',
      elegiveis: numeroOuZero(dry.elegiveis),
      suprimidos: numeroOuZero(dry.suprimidos),
      supressoes: resumirSupressoes(dry.por_motivo),
      truncado: false,
      calculadoEm: campanha.dry_run_em ?? dry.gerado_em ?? null,
      limiteAplicado: dry.limite_aplicado ?? null,
    }
  }

  return {
    fonte: 'nenhuma',
    elegiveis: 0,
    suprimidos: 0,
    supressoes: [],
    truncado: false,
    calculadoEm: null,
    limiteAplicado: null,
  }
}

/**
 * Se a campanha pode ter o público (re)gerado.
 *
 * Espelha a recusa `campanha_nao_editavel` da RPC — materializar só é aceito
 * em rascunho/aguardando_aprovacao. Repetimos a regra na tela para DESABILITAR
 * o botão em vez de deixar o operador clicar e tomar 409; a autoridade
 * continua sendo o banco.
 */
export function podeGerarPublico(status: string): boolean {
  return status === 'rascunho' || status === 'aguardando_aprovacao'
}

/** Espelha o gate de `whatsapp_oficial_campanha_aprovar`: só faz sentido
 *  aprovar o que ainda não foi aprovado e já tem público gravado. */
export function podeAprovar(
  campanha: Pick<CampanhaDetalhe, 'status' | 'destinatarios_gerados_em'>,
): boolean {
  const statusOk =
    campanha.status === 'rascunho' || campanha.status === 'aguardando_aprovacao'
  return statusOk && Boolean(campanha.destinatarios_gerados_em)
}

export function podePausar(status: string): boolean {
  return status === 'aprovado' || status === 'enviando'
}

export function podeRetomar(status: string): boolean {
  return status === 'pausado'
}

/** Cancelar é o freio definitivo: vale em qualquer estado que ainda possa
 *  produzir envio. Concluída/cancelada já não tem o que cancelar. */
export function podeCancelar(status: string): boolean {
  return status !== 'concluido' && status !== 'cancelado'
}
