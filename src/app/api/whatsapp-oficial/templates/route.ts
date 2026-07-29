import { NextResponse } from 'next/server'
import { requireGestaoSession, toErrorResponse } from '@/lib/whatsapp-oficial/api-auth'
import { resumirComponentes } from '@/lib/whatsapp-oficial/template-campos'

/**
 * Lista o catálogo de templates oficiais visível para quem chamou.
 *
 * A leitura roda com o cliente COM SESSÃO (`supabaseUser`), nunca com
 * `supabaseAdmin()`. Isto é deliberado e é a única coisa que separa esta rota
 * de um vazamento entre tenants: `whatsapp_templates` só tem policy de SELECT
 * para gestão, então a RLS já é a resposta certa para "o que este usuário pode
 * ver". Um `service_role` aqui devolveria o catálogo do tenant inteiro (ou de
 * todos) sem checagem nenhuma — e a rota não tem como recuperar essa decisão
 * depois, porque ela não sabe o papel do chamador.
 *
 * As RPCs de escrita (sync, enfileirar) continuam usando `service_role`, mas
 * lá a autoridade é o Postgres: a função revalida o papel e devolve 42501.
 * Numa leitura de lista não existe RPC para revalidar nada.
 */

/**
 * Campos úteis para a tela de templates.
 *
 * `componentes` é LIDO mas NÃO devolvido: continua fora da resposta de
 * propósito (é um blob grande e o catálogo do canal inteiro vem numa tacada),
 * só que agora dois fatos precisam ser destilados dele antes de descartá-lo —
 * quais TIPOS de bloco o template tem (um CAROUSEL não pode ser escolhido numa
 * campanha: o envio o descartaria em silêncio e entregaria a mensagem
 * mutilada) e se o header de mídia traz `example.header_url`, o único fallback
 * que o envio aceita quando ninguém informa a mídia. Nenhum dos dois está em
 * outra coluna: `variaveis` não fala de tipo de bloco, e `cabecalho_formato`
 * não fala de exemplo.
 */
const TEMPLATE_FIELDS = [
  'id',
  'canal_id',
  'meta_template_id',
  'nome',
  'idioma',
  'categoria',
  'status_aprovacao',
  'quality_score',
  'corpo_texto',
  'cabecalho_texto',
  'cabecalho_formato',
  'rodape_texto',
  'variaveis',
  'motivo_rejeicao',
  'sincronizado_em',
  'componentes',
].join(', ')

export async function GET(request: Request): Promise<Response> {
  try {
    const { supabaseUser } = await requireGestaoSession()

    const { searchParams } = new URL(request.url)
    const canalId = (searchParams.get('canalId') ?? '').trim()
    const status = (searchParams.get('status') ?? '').trim()
    const idioma = (searchParams.get('idioma') ?? '').trim()

    let query = supabaseUser.from('whatsapp_templates').select(TEMPLATE_FIELDS)
    if (canalId) query = query.eq('canal_id', canalId)
    if (status) query = query.eq('status_aprovacao', status)
    if (idioma) query = query.eq('idioma', idioma)

    // Mesma ordenação da chave natural do catálogo (um nome tem uma linha por
    // idioma), para a tela poder agrupar sem reordenar no cliente.
    const { data, error } = await query.order('nome').order('idioma')

    if (error) {
      console.error('[whatsapp-oficial/templates] failed to list templates:', error.message)
      return NextResponse.json({ error: 'template_list_failed' }, { status: 500 })
    }

    const templates = ((data ?? []) as unknown as Record<string, unknown>[]).map((linha) => {
      const { componentes, ...resto } = linha
      const resumo = resumirComponentes(componentes)
      return {
        ...resto,
        tipos_componentes: resumo.tipos,
        cabecalho_midia_exemplo: resumo.cabecalhoMidiaExemplo,
      }
    })

    return NextResponse.json({ templates })
  } catch (error) {
    return toErrorResponse(error)
  }
}
