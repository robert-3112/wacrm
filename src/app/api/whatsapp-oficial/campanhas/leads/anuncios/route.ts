import { NextResponse } from 'next/server'
import { BadRequestError, ForbiddenError, UnauthorizedError, requireGestaoSession, toErrorResponse } from '@/lib/whatsapp-oficial/api-auth'
import { readBoundedJson } from '@/lib/whatsapp-oficial/bounded-json'
import { isoMicros } from '@/lib/whatsapp-oficial/iso-micros'
import { checkRateLimit, rateLimitResponse, WHATSAPP_OFICIAL_RATE_LIMITS } from '@/lib/whatsapp-oficial/rate-limit'

const MAX_SUGESTOES = 30
const MAX_AMOSTRA = 1000
const MAX_LEADS = 500
const NO_STORE = { 'Cache-Control': 'private, no-store' }

type LeadRow = { id: string; nome: string | null; name: string | null; whatsapp: string | null; phone: string | null }

function serverError(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 500, headers: NO_STORE })
}

async function exigirGestao(supabaseUser: Awaited<ReturnType<typeof requireGestaoSession>>['supabaseUser']): Promise<Response | null> {
  const { data, error } = await supabaseUser.rpc('crm_is_gestao')
  if (error || typeof data !== 'boolean') return serverError('Não foi possível verificar a permissão.')
  if (!data) throw new ForbiddenError('Sem permissão para buscar contatos.')
  return null
}

// Postgres LIKE uses %, _ and backslash as syntax; a search term is always literal.
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

function utcIso(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value)
  if (!match) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === `${match[1]}.${(match[2] ?? '').padEnd(3, '0').slice(0, 3)}Z`
}

/** Suggest exact Meta ad names from CRM leads visible under the caller's RLS. */
export async function GET(request: Request): Promise<Response> {
  try {
    const { userId, supabaseUser } = await requireGestaoSession()
    const limit = checkRateLimit(`whatsapp-campanha-leads-anuncios-list:${userId}`, WHATSAPP_OFICIAL_RATE_LIMITS.gestaoList)
    if (!limit.success) return rateLimitResponse(limit)
    const forbidden = await exigirGestao(supabaseUser)
    if (forbidden) return forbidden

    const q = (new URL(request.url).searchParams.get('q') ?? '').trim()
    if (q.length < 2 || q.length > 80) throw new BadRequestError('Digite entre 2 e 80 caracteres para buscar um anúncio.')

    // PostgREST does not expose DISTINCT here. Bound rows and deduplicate in memory.
    const { data, count, error } = await supabaseUser.from('leads')
      .select('fb_ad_name', { count: 'exact' })
      .not('fb_ad_name', 'is', null)
      .ilike('fb_ad_name', `%${escapeLike(q)}%`)
      .order('fb_ad_name', { ascending: true })
      .limit(MAX_AMOSTRA + 1)
    if (error || !Array.isArray(data) || typeof count !== 'number') return serverError('Não foi possível buscar os anúncios.')

    const nomes = [...new Set(data.map((row) => row.fb_ad_name).filter((name): name is string => typeof name === 'string' && !!name.trim()))]
    return NextResponse.json({ anuncios: nomes.slice(0, MAX_SUGESTOES), truncado: count > data.length || data.length > MAX_AMOSTRA || nomes.length > MAX_SUGESTOES }, { headers: NO_STORE })
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError || error instanceof BadRequestError) return toErrorResponse(error)
    return serverError('Não foi possível buscar os anúncios.')
  }
}

/** Return a candidate list only; campaign recipient generation still applies consent and opt-out rules. */
export async function POST(request: Request): Promise<Response> {
  try {
    const { userId, supabaseUser } = await requireGestaoSession()
    const limit = checkRateLimit(`whatsapp-campanha-leads-anuncios-select:${userId}`, WHATSAPP_OFICIAL_RATE_LIMITS.campanhaWrite)
    if (!limit.success) return rateLimitResponse(limit)
    const forbidden = await exigirGestao(supabaseUser)
    if (forbidden) return forbidden

    let raw: unknown
    try { raw = await readBoundedJson(request, 2048) }
    catch { throw new BadRequestError('Corpo JSON inválido ou grande demais.') }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestError('Corpo JSON inválido.')
    const body = raw as Record<string, unknown>
    const anuncio = body.anuncio
    if (typeof anuncio !== 'string' || !anuncio.trim() || anuncio.length > 500) throw new BadRequestError('Informe um nome de anúncio válido.')
    if (body.criadoDe !== undefined && !utcIso(body.criadoDe)) throw new BadRequestError('Data inicial deve ser ISO UTC.')
    if (body.criadoAte !== undefined && !utcIso(body.criadoAte)) throw new BadRequestError('Data final deve ser ISO UTC.')
    if (typeof body.criadoDe === 'string' && typeof body.criadoAte === 'string' && isoMicros(body.criadoDe) > isoMicros(body.criadoAte)) {
      throw new BadRequestError('Data inicial deve ser anterior à data final.')
    }

    let query = supabaseUser.from('leads')
      .select('id,nome,name,whatsapp,phone', { count: 'exact' })
      .eq('fb_ad_name', anuncio)
      .order('id', { ascending: true })
      .limit(MAX_LEADS + 1)
    if (typeof body.criadoDe === 'string') query = query.gte('created_at', body.criadoDe)
    if (typeof body.criadoAte === 'string') query = query.lte('created_at', body.criadoAte)
    const { data, count, error } = await query
    if (error || !Array.isArray(data) || typeof count !== 'number') return serverError('Não foi possível buscar os contatos.')
    if (count > MAX_LEADS) {
      return NextResponse.json({ error: 'publico_muito_grande', total: count }, { status: 422, headers: NO_STORE })
    }
    // A partial response must never look like a complete campaign audience.
    if (data.length !== count) return serverError('Não foi possível concluir a busca de contatos.')
    const leads = (data as LeadRow[]).map((row) => ({
      id: row.id,
      nome: row.nome?.trim() || row.name?.trim() || 'Sem nome',
      telefone: row.whatsapp?.trim() || row.phone?.trim() || null,
    }))
    return NextResponse.json({ leads, total: count }, { headers: NO_STORE })
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError || error instanceof BadRequestError) return toErrorResponse(error)
    return serverError('Não foi possível buscar os contatos.')
  }
}
