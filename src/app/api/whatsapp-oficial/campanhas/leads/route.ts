import { NextResponse } from 'next/server'
import { BadRequestError, requireGestaoSession, toErrorResponse } from '@/lib/whatsapp-oficial/api-auth'
import { buildContactSearchFilter } from '@/lib/whatsapp-oficial/contatos-data'
import { checkRateLimit, rateLimitResponse, WHATSAPP_OFICIAL_RATE_LIMITS } from '@/lib/whatsapp-oficial/rate-limit'

/** Seleção de público usa o CRM central e respeita a RLS da sessão. */
export async function GET(request: Request): Promise<Response> {
  try {
    const { userId, supabaseUser } = await requireGestaoSession()
    const limit = checkRateLimit(`whatsapp-campanha-leads:${userId}`, WHATSAPP_OFICIAL_RATE_LIMITS.gestaoList)
    if (!limit.success) return rateLimitResponse(limit)
    const q = (new URL(request.url).searchParams.get('q') ?? '').trim()
    const filter = buildContactSearchFilter(q)
    if (q.length < 2 || q.length > 80 || !filter) {
      throw new BadRequestError('Digite entre 2 e 80 caracteres para buscar um contato.')
    }
    const { data, error } = await supabaseUser.from('leads')
      .select('id,nome,name,whatsapp,phone')
      .or(filter).order('nome', { ascending: true }).order('id', { ascending: true }).limit(21)
    if (error) return NextResponse.json({ error: 'Não foi possível buscar os contatos.' }, { status: 500 })
    const rows = data ?? []
    return NextResponse.json({
      leads: rows.slice(0, 20).map((row) => ({ id: row.id,
        nome: row.nome?.trim() || row.name?.trim() || 'Sem nome',
        telefone: row.whatsapp?.trim() || row.phone?.trim() || null })),
      truncado: rows.length > 20,
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return toErrorResponse(error)
  }
}
