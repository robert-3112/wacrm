import { NextResponse } from 'next/server'
import { BadRequestError, requireGestaoSession, toErrorResponse } from '@/lib/whatsapp-oficial/api-auth'
import { encryptToken } from '@/lib/whatsapp-oficial/crypto'
import { WHATSAPP_OFICIAL_RATE_LIMITS, checkRateLimit, rateLimitResponse } from '@/lib/whatsapp-oficial/rate-limit'

const META_ID = /^[0-9]{1,32}$/
const INSTANCE = /^[^\s/?#]{1,100}$/u

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function invalid(reason: string): NextResponse {
  return NextResponse.json({ error: reason }, { status: 422 })
}

/** Register only. Every new channel starts inactive; this route never sends. */
export async function POST(request: Request): Promise<Response> {
  try {
    const { userId, admin } = await requireGestaoSession()
    const rl = checkRateLimit(`whatsapp-oficial-canais-criar:${userId}`, WHATSAPP_OFICIAL_RATE_LIMITS.campanhaWrite)
    if (!rl.success) return rateLimitResponse(rl)

    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestError('JSON inválido')
    const nome = text(body.nome)
    const numero = text(body.numeroDisplay)
    const provider = text(body.provider)
    const credential = text(body.credential)
    if (!nome || nome.length > 100) return invalid('nome_invalido')
    if (numero.length > 40) return invalid('numero_invalido')
    if (provider !== 'meta_cloud' && provider !== 'evolution') return invalid('provider_invalido')
    if (!credential || credential.length > 4096) return invalid('credencial_invalida')

    let phoneNumberId: string | null = null
    let wabaId: string | null = null
    let evolutionBaseUrl: string | null = null
    let evolutionInstance: string | null = null
    if (provider === 'meta_cloud') {
      phoneNumberId = text(body.phoneNumberId)
      wabaId = text(body.wabaId)
      if (!META_ID.test(phoneNumberId) || !META_ID.test(wabaId)) return invalid('campos_meta_invalidos')
      if (body.evolutionInstance !== undefined) return invalid('campos_meta_invalidos')
    } else {
      evolutionInstance = text(body.evolutionInstance)
      if (!INSTANCE.test(evolutionInstance)) return invalid('campos_evolution_invalidos')
      if (body.phoneNumberId !== undefined || body.wabaId !== undefined) return invalid('campos_evolution_invalidos')
      const configured = process.env.EVOLUTION_API_URL?.trim()
      if (!configured) return NextResponse.json({ error: 'evolution_nao_configurada_no_servidor' }, { status: 503 })
      try {
        const url = new URL(configured)
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
          return NextResponse.json({ error: 'evolution_nao_configurada_no_servidor' }, { status: 503 })
        }
        evolutionBaseUrl = url.origin
      } catch {
        return NextResponse.json({ error: 'evolution_nao_configurada_no_servidor' }, { status: 503 })
      }
    }

    let encrypted: string
    try {
      encrypted = encryptToken(credential)
    } catch {
      return NextResponse.json({ error: 'criptografia_nao_configurada' }, { status: 503 })
    }
    const { data, error } = await admin.rpc('whatsapp_oficial_canal_criar', {
      p_actor_user_id: userId,
      p_nome: nome,
      p_provider: provider,
      p_numero_display: numero || null,
      p_phone_number_id: phoneNumberId,
      p_waba_id: wabaId,
      p_evolution_base_url: evolutionBaseUrl,
      p_evolution_instance: evolutionInstance,
      p_credencial_cifrada: encrypted,
    })
    if (error) throw error
    const result = data as { ok?: boolean; reason?: string; canal_id?: string; status?: string } | null
    if (!result?.ok) {
      return NextResponse.json(
        { error: result?.reason ?? 'canal_nao_criado' },
        { status: result?.reason === 'canal_ja_cadastrado' ? 409 : 422 },
      )
    }
    return NextResponse.json({ ok: true, canal_id: result.canal_id, status: result.status }, { status: 201 })
  } catch (error) {
    return toErrorResponse(error)
  }
}
