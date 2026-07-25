import { NextResponse } from 'next/server'
import {
  requireGestaoSession,
  toErrorResponse,
  isPostgrestPermissionError,
  BadRequestError,
} from '@/lib/whatsapp-oficial/api-auth'
import {
  WHATSAPP_OFICIAL_RATE_LIMITS,
  checkRateLimit,
  rateLimitResponse,
} from '@/lib/whatsapp-oficial/rate-limit'
import { decryptToken } from '@/lib/whatsapp-oficial/crypto'
import {
  META_TEMPLATE_PAGE_CAP,
  META_TEMPLATE_PAGE_SIZE,
  MetaTemplateFetchError,
  fetchMetaTemplates,
  toSuntTemplatePayload,
  type SuntTemplatePayload,
} from '@/lib/whatsapp-oficial/meta-templates'

/**
 * Sincroniza o catálogo de templates de UM canal `meta_cloud` contra a Meta.
 *
 * O token do canal é decifrado aqui e vive só nesta stack frame: ele vai para
 * o header `Authorization` de `fetchMetaTemplates` e para lugar nenhum mais —
 * nunca para o corpo da resposta, nunca para uma mensagem de erro, nunca para
 * o log. Toda mensagem de terceiro que esta rota repassa passa antes por
 * {@link redigirToken}, porque os cursores `paging.next` da Graph API carregam
 * `access_token=` na própria query string: um erro que ecoe a URL da página
 * seguinte vazaria a credencial do canal para a tela.
 *
 * Sem commit parcial: `fetchMetaTemplates` aborta o catálogo inteiro em
 * qualquer página não-2xx, e só então a RPC é chamada — meio catálogo gravado
 * faria o operador ler "template sumiu da Meta" onde houve só uma falha de
 * rede.
 *
 * Gate de papel em DUAS camadas, e as duas importam:
 *
 *  1. O pré-check de RLS abaixo (`whatsapp_channels_select_gestao`, que é
 *     `tenant_id` + `crm_is_gestao()`) barra ANTES de decifrar o token e antes
 *     de gastar a cota da Business Management API do WABA. Ele não é
 *     redundante com a camada 2: é o único que impede um chamador sem papel de
 *     provocar a decifra da credencial e 20 requisições à Meta.
 *  2. `whatsapp_oficial_sync_templates` recebe `p_actor_user_id` e é a
 *     AUTORIDADE de papel: só owner/admin/gestor passam por
 *     `whatsapp_campanha_ator_autorizado`; qualquer outro leva 42501. Isso
 *     fecha a fresta que a camada 1 deixa: `crm_is_gestao()` inclui `lider`,
 *     então um líder ENXERGA o canal pela RLS e chega até aqui — quem o recusa
 *     é o Postgres, e a rota traduz esse 42501 para 403 (não 500).
 *
 * A versão de 4 argumentos da RPC foi dropada em produção: chamar sem
 * `p_actor_user_id` devolve "function does not exist".
 */

const SYNC_PAGE_LIMIT = META_TEMPLATE_PAGE_CAP * META_TEMPLATE_PAGE_SIZE

interface SyncBody {
  canalId?: unknown
}

interface CanalRow {
  id: string
  tenant_id: string
  provider: string
  waba_id: string | null
  access_token_cifrado: string | null
}

interface SyncRpcResult {
  ok?: boolean
  reason?: string
  total?: number
  inseridos?: number
  atualizados?: number
  inalterados?: number
  truncado?: boolean
  erros?: unknown[]
}

/** Substitui o token por `[REDACTED]` em qualquer texto que possa sair daqui. */
function redigirToken(texto: string, token: string): string {
  if (!token) return texto
  return texto.split(token).join('[REDACTED]')
}

/** Recusa de negócio da RPC -> HTTP. `canal_de_outro_tenant` é 403 (o canal
 *  existe, o chamador é que não manda nele), o resto é entrada inválida. */
function statusParaReason(reason: string | undefined): number {
  if (reason === 'canal_nao_encontrado') return 404
  if (reason === 'canal_de_outro_tenant') return 403
  return 422
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json().catch(() => null)) as SyncBody | null
    const canalId = typeof body?.canalId === 'string' ? body.canalId.trim() : ''
    if (!canalId) throw new BadRequestError('canalId is required')

    const { userId, supabaseUser, admin } = await requireGestaoSession()

    // Antes de qualquer I/O caro: um sync pode disparar 20 requisições à Meta,
    // e a Business Management API tem cota POR WABA — um loop travado aqui
    // derrubaria também as chamadas legítimas do canal.
    const rl = checkRateLimit(
      `whatsapp-oficial-template-sync:${userId}`,
      WHATSAPP_OFICIAL_RATE_LIMITS.templateSync,
    )
    if (!rl.success) return rateLimitResponse(rl)

    // Gate de papel (ver docblock): a RLS de `whatsapp_channels` só devolve
    // linha para gestão do tenant. Miss = 404, indistinguível de canal
    // inexistente — um corretor não descobre por aqui quais canais existem.
    const { data: canalVisivel, error: rlsError } = await supabaseUser
      .from('whatsapp_channels')
      .select('id')
      .eq('id', canalId)
      .maybeSingle()

    if (rlsError) {
      console.error(
        '[whatsapp-oficial/templates/sync] failed to check channel visibility:',
        rlsError.message,
      )
      return NextResponse.json({ error: 'channel_lookup_failed' }, { status: 500 })
    }
    if (!canalVisivel) {
      return NextResponse.json({ error: 'canal_nao_encontrado' }, { status: 404 })
    }

    const { data: canalData, error: canalError } = await admin
      .from('whatsapp_channels')
      .select('id, tenant_id, provider, waba_id, access_token_cifrado')
      .eq('id', canalId)
      .maybeSingle()

    if (canalError) {
      console.error(
        '[whatsapp-oficial/templates/sync] failed to read channel:',
        canalError.message,
      )
      return NextResponse.json({ error: 'channel_lookup_failed' }, { status: 500 })
    }

    const canal = canalData as CanalRow | null
    if (!canal) {
      return NextResponse.json({ error: 'canal_nao_encontrado' }, { status: 404 })
    }
    if (canal.provider !== 'meta_cloud') {
      return NextResponse.json(
        {
          error: 'provider_sem_template',
          detalhe:
            `Canal usa provider '${canal.provider}'. Só canais meta_cloud têm ` +
            'catálogo de templates aprovado na Meta para sincronizar.',
        },
        { status: 422 },
      )
    }
    if (!canal.waba_id || !canal.access_token_cifrado) {
      return NextResponse.json(
        {
          error: 'credencial_ausente',
          detalhe:
            'Canal sem WABA id e/ou access token configurado. Cadastre as credenciais ' +
            'da Meta no canal antes de sincronizar os templates.',
        },
        { status: 422 },
      )
    }

    let accessToken: string
    try {
      accessToken = decryptToken(canal.access_token_cifrado)
    } catch (err) {
      // Só o NOME do erro vai para o log: as mensagens de decriptação falam de
      // tamanho de buffer, mas o hábito de não logar nada derivado da
      // credencial é o que impede um vazamento quando alguém mexer aqui.
      console.error(
        '[whatsapp-oficial/templates/sync] failed to decrypt channel token:',
        err instanceof Error ? err.name : 'unknown error',
      )
      return NextResponse.json({ error: 'credencial_invalida' }, { status: 500 })
    }

    let fetched
    try {
      fetched = await fetchMetaTemplates({ wabaId: canal.waba_id, accessToken })
    } catch (err) {
      const detalhe = redigirToken(
        err instanceof Error ? err.message : 'erro desconhecido',
        accessToken,
      )
      if (err instanceof MetaTemplateFetchError) {
        return NextResponse.json(
          { error: 'meta_api_error', detalhe, meta_status: err.httpStatus },
          { status: 502 },
        )
      }
      console.error('[whatsapp-oficial/templates/sync] Meta fetch failed:', detalhe)
      return NextResponse.json({ error: 'meta_api_indisponivel' }, { status: 502 })
    }

    // `toSuntTemplatePayload` devolve null para template sem nome ou sem idioma
    // (a chave natural do catálogo). Contamos em vez de descartar em silêncio —
    // total != inseridos+atualizados+inalterados sem explicação vira chamado.
    const templates: SuntTemplatePayload[] = []
    let ignorados = 0
    for (const bruto of fetched.templates) {
      const payload = toSuntTemplatePayload(bruto)
      if (payload) templates.push(payload)
      else ignorados++
    }

    const { data, error } = await admin.rpc('whatsapp_oficial_sync_templates', {
      p_actor_user_id: userId,
      p_tenant_id: canal.tenant_id,
      p_canal_id: canal.id,
      p_templates: templates,
      p_truncado: fetched.truncated,
    })

    if (error) {
      // Duas traduções diferentes de propósito, e nenhuma delas é `throw error`
      // como nas rotas de campanha: `toErrorResponse` loga o erro CRU, e esta é
      // a única rota do subsistema com um token de canal em texto claro na
      // stack frame — tudo que vem do Postgres passa por `redigirToken` antes
      // de qualquer log.
      const detalhe = redigirToken(error.message, accessToken)
      // 42501 = a RPC recusou o ATOR (papel insuficiente). Sem esta linha um
      // `lider`, que passa pela RLS de canais via `crm_is_gestao()` e portanto
      // chega até aqui, leria "erro do servidor" em vez de "você não pode".
      if (isPostgrestPermissionError(error)) {
        console.error('[whatsapp-oficial/templates/sync] sync RPC denied:', detalhe)
        return NextResponse.json({ error: 'sem_permissao' }, { status: 403 })
      }
      console.error('[whatsapp-oficial/templates/sync] sync RPC failed:', detalhe)
      return NextResponse.json({ error: 'template_sync_failed' }, { status: 500 })
    }

    const result = (data ?? {}) as SyncRpcResult
    if (!result.ok) {
      return NextResponse.json(
        { error: result.reason ?? 'template_sync_rejected' },
        { status: statusParaReason(result.reason) },
      )
    }

    const truncado = Boolean(result.truncado ?? fetched.truncated)

    return NextResponse.json({
      ok: true,
      total: result.total ?? templates.length,
      inseridos: result.inseridos ?? 0,
      atualizados: result.atualizados ?? 0,
      inalterados: result.inalterados ?? 0,
      ignorados,
      truncado,
      erros: result.erros ?? [],
      ...(truncado
        ? {
            aviso:
              `A Meta ainda tinha mais páginas depois do teto de ${SYNC_PAGE_LIMIT} ` +
              `templates (${META_TEMPLATE_PAGE_CAP} páginas × ${META_TEMPLATE_PAGE_SIZE}). ` +
              'O que passou desse teto NÃO foi sincronizado e pode aparecer desatualizado ' +
              'ou ausente no catálogo.',
          }
        : {}),
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
