import { NextResponse } from 'next/server'
import { BadRequestError, ForbiddenError, UnauthorizedError, requireGestaoSession, toErrorResponse } from '@/lib/whatsapp-oficial/api-auth'
import { readBoundedJson } from '@/lib/whatsapp-oficial/bounded-json'
import { checkRateLimit, rateLimitResponse, WHATSAPP_OFICIAL_RATE_LIMITS } from '@/lib/whatsapp-oficial/rate-limit'

const MAX_TELEFONES = 500
const QUERY_CHUNK = 10
const QUERY_LIMIT = 1000
type LeadRow = { id: string; nome: string | null; name: string | null; whatsapp: string | null }

// BR 10/11 local digits and the same number prefixed with 55 are equivalent.
// In particular, an 8-digit and a 9-digit subscriber number stay different.
function localPhone(value: string): string | null {
  const digits = value.replace(/\D/g, '')
  if (digits.length === 10 || digits.length === 11) return digits
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) return digits.slice(2)
  return null
}

const errorResponse = (message: string) => NextResponse.json({ error: message }, { status: 500 })

/** Resolve CSV phones against only the CRM leads visible through the caller's RLS. */
export async function POST(request: Request): Promise<Response> {
  try {
    const { userId, supabaseUser } = await requireGestaoSession()
    const limit = checkRateLimit(`whatsapp-campanha-leads-resolver:${userId}`, WHATSAPP_OFICIAL_RATE_LIMITS.campanhaWrite)
    if (!limit.success) return rateLimitResponse(limit)

    let body: unknown
    try { body = await readBoundedJson(request, 64_000) }
    catch { throw new BadRequestError('Corpo JSON inválido ou grande demais.') }
    if (!body || typeof body !== 'object' || !('telefones' in body) ||
      !Array.isArray(body.telefones) || body.telefones.length < 1 || body.telefones.length > MAX_TELEFONES ||
      body.telefones.some((phone) => typeof phone !== 'string')) {
      throw new BadRequestError('Informe de 1 a 500 telefones.')
    }

    // `requireGestaoSession` authenticates but leaves role authorization to callers.
    const { data: isGestao, error: roleError } = await supabaseUser.rpc('crm_is_gestao')
    if (roleError || typeof isGestao !== 'boolean') return errorResponse('Não foi possível verificar a permissão.')
    if (!isGestao) throw new ForbiddenError('Sem permissão para buscar contatos.')

    const phones = new Set<string>()
    let invalidos = 0
    let duplicados = 0
    for (const raw of body.telefones as string[]) {
      const phone = raw.length <= 80 ? localPhone(raw) : null
      if (!phone) { invalidos++; continue }
      if (phones.has(phone)) { duplicados++; continue }
      phones.add(phone)
    }
    if (!phones.size) return NextResponse.json({ leads: [], encontrados: 0, ausentes: 0, ambiguos: 0, duplicados, invalidos }, { headers: { 'Cache-Control': 'private, no-store' } })

    const candidates = new Map<string, LeadRow>()
    const suffixes = [...new Set([...phones].map((phone) => phone.slice(-8)))]
    for (let i = 0; i < suffixes.length; i += QUERY_CHUNK) {
      // Wildcards between digits tolerate punctuation in stored phone strings.
      // Only digits from a validated number enter raw PostgREST filter syntax.
      const filter = suffixes.slice(i, i + QUERY_CHUNK).map((suffix) => {
        const pattern = `%${suffix.split('').join('%')}%`
        return `whatsapp.ilike.${pattern}`
      }).join(',')
      const { data, count, error } = await supabaseUser.from('leads')
        .select('id,nome,name,whatsapp', { count: 'exact' })
        .or(filter).order('id', { ascending: true }).limit(QUERY_LIMIT)
      // A partial candidate set could turn an ambiguous number into a false exact match.
      if (error || !Array.isArray(data) || count === null || count !== data.length) {
        return errorResponse('Não foi possível concluir a busca de contatos.')
      }
      for (const row of data as LeadRow[]) candidates.set(row.id, row)
    }

    const matches = new Map<string, Map<string, { row: LeadRow; telefone: string }>>()
    for (const phone of phones) matches.set(phone, new Map())
    for (const row of candidates.values()) {
      // A campanha envia exclusivamente `leads.whatsapp`; o campo `phone`
      // pode ser diferente e nunca deve identificar um destinatário aqui.
      for (const raw of [row.whatsapp]) {
        if (typeof raw !== 'string') continue
        const phone = localPhone(raw)
        if (phone && matches.has(phone)) matches.get(phone)!.set(row.id, { row, telefone: raw.trim() })
      }
    }

    const leads = new Map<string, { id: string; nome: string; telefone: string | null }>()
    let encontrados = 0
    let ausentes = 0
    let ambiguos = 0
    for (const rows of matches.values()) {
      if (rows.size === 0) { ausentes++; continue }
      if (rows.size > 1) { ambiguos++; continue }
      encontrados++
      const { row, telefone } = rows.values().next().value!
      leads.set(row.id, { id: row.id, nome: row.nome?.trim() || row.name?.trim() || 'Sem nome', telefone })
    }
    return NextResponse.json({ leads: [...leads.values()], encontrados, ausentes, ambiguos, duplicados, invalidos }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    // Do not log unexpected errors: a query error can contain a phone filter.
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError || error instanceof BadRequestError) {
      return toErrorResponse(error)
    }
    return errorResponse('Não foi possível concluir a busca de contatos.')
  }
}
