import { NextResponse } from 'next/server'
import { requireGestaoSession, toErrorResponse } from '@/lib/whatsapp-oficial/api-auth'
import { checkRateLimit, rateLimitResponse, WHATSAPP_OFICIAL_RATE_LIMITS } from '@/lib/whatsapp-oficial/rate-limit'
import { decryptToken } from '@/lib/whatsapp-oficial/crypto'
import { metaApiBase } from '@/lib/whatsapp-oficial/meta-api'
import { parseTextTemplateInput, textTemplatePayload } from '@/lib/whatsapp-oficial/template-create'
import { readBoundedJson } from '@/lib/whatsapp-oficial/bounded-json'

/** Submit a text template to Meta. It is usable only after Meta approves it and sync imports that status. */
export async function POST(request: Request): Promise<Response> {
  try {
    const { userId, supabaseUser, admin } = await requireGestaoSession()
    const rate = checkRateLimit(`whatsapp-template-create:${userId}`, WHATSAPP_OFICIAL_RATE_LIMITS.templateSync)
    if (!rate.success) return rateLimitResponse(rate)

    let input
    try {
      input = parseTextTemplateInput(await readBoundedJson(request, 8_192))
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Dados inválidos.' }, { status: 400 })
    }

    const { data: visible, error: visibleError } = await supabaseUser
      .from('whatsapp_channels').select('id, tenant_id').eq('id', input.canalId).maybeSingle()
    if (visibleError) return NextResponse.json({ error: 'Não foi possível verificar o canal.' }, { status: 500 })
    if (!visible) return NextResponse.json({ error: 'Canal não encontrado.' }, { status: 404 })

    // A RLS de canais também inclui líder. Submeter à Meta requer gestão explícita.
    const { data: role, error: roleError } = await admin.from('app_roles')
      .select('role').eq('user_id', userId).eq('tenant_id', visible.tenant_id)
      .in('role', ['owner', 'admin', 'gestor']).limit(1).maybeSingle()
    if (roleError) return NextResponse.json({ error: 'Não foi possível verificar a permissão.' }, { status: 500 })
    if (!role) return NextResponse.json({ error: 'Sem permissão para submeter templates.' }, { status: 403 })

    const { data: channel, error: channelError } = await admin.from('whatsapp_channels')
      .select('provider, status, waba_id, access_token_cifrado')
      .eq('id', input.canalId).eq('tenant_id', visible.tenant_id).maybeSingle()
    if (channelError) return NextResponse.json({ error: 'Não foi possível consultar o canal.' }, { status: 500 })
    if (!channel || channel.provider !== 'meta_cloud' || channel.status !== 'ativo') {
      return NextResponse.json({ error: 'O canal Meta precisa estar ativo.' }, { status: 422 })
    }
    if (!channel.waba_id || !/^\d+$/.test(channel.waba_id) || !channel.access_token_cifrado) {
      return NextResponse.json({ error: 'Credencial Meta incompleta no canal.' }, { status: 422 })
    }

    let token: string
    try { token = decryptToken(channel.access_token_cifrado) }
    catch { return NextResponse.json({ error: 'Credencial Meta indisponível.' }, { status: 503 }) }

    let response: Response
    try {
      response = await fetch(`${metaApiBase()}/${channel.waba_id}/message_templates`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(textTemplatePayload(input)),
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      return NextResponse.json({ error: 'A Meta não respondeu. Verifique o catálogo antes de tentar de novo.' }, { status: 502 })
    }
    // Never return the Graph error body: it may contain account or credential details.
    if (!response.ok) {
      return NextResponse.json({ error: 'A Meta recusou o template. Revise conteúdo, categoria e exemplos.', metaStatus: response.status }, { status: 422 })
    }
    let result: { id?: unknown; status?: unknown }
    try { result = await response.json() }
    catch { return NextResponse.json({ error: 'A Meta respondeu sem confirmar o template. Sincronize o catálogo.' }, { status: 502 }) }
    if (typeof result.id !== 'string' || !/^\d+$/.test(result.id)) {
      return NextResponse.json({ error: 'A Meta não confirmou o ID do template. Sincronize o catálogo.' }, { status: 502 })
    }
    return NextResponse.json({ id: result.id, status: typeof result.status === 'string' ? result.status : 'PENDING' }, { status: 202 })
  } catch (error) {
    return toErrorResponse(error)
  }
}
