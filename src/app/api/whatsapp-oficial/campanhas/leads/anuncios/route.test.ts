import { beforeEach, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'
import { UnauthorizedError } from '@/lib/whatsapp-oficial/api-auth'
import { GET, POST } from './route'

const mocks = vi.hoisted(() => ({ session: vi.fn() }))
vi.mock('@/lib/whatsapp-oficial/api-auth', async (original) => ({
  ...await original<typeof import('@/lib/whatsapp-oficial/api-auth')>(),
  requireGestaoSession: mocks.session,
}))

function setup(result: { data?: unknown; count?: number | null; error?: unknown } = {}, isGestao: unknown = true) {
  const query = {
    select: vi.fn().mockReturnThis(), not: vi.fn().mockReturnThis(), ilike: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(), gte: vi.fn().mockReturnThis(), lte: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ data: [], count: 0, error: null, ...result })),
  }
  const from = vi.fn(() => query)
  const rpc = vi.fn().mockResolvedValue({ data: isGestao, error: null })
  const admin = { from: vi.fn(), rpc: vi.fn() }
  mocks.session.mockResolvedValue({ userId: 'user', supabaseUser: { from, rpc }, admin })
  return { query, from, rpc, admin }
}

const get = (q: string) => new Request(`http://localhost/api/whatsapp-oficial/campanhas/leads/anuncios?${new URLSearchParams({ q })}`)
const post = (body: unknown) => new Request('http://localhost/api/whatsapp-oficial/campanhas/leads/anuncios', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
beforeEach(() => { vi.resetAllMocks(); __resetRateLimitForTests() })

it('autentica e verifica gestão antes de consultar leads', async () => {
  const { from } = setup()
  mocks.session.mockRejectedValue(new UnauthorizedError())
  expect((await GET(get('Anúncio'))).status).toBe(401)
  expect((await POST(post({ anuncio: 'Anúncio' }))).status).toBe(401)
  expect(from).not.toHaveBeenCalled()
  const denied = setup({}, false)
  expect((await GET(get('Anúncio'))).status).toBe(403)
  expect((await POST(post({ anuncio: 'Anúncio' }))).status).toBe(403)
  expect(denied.from).not.toHaveBeenCalled()
  expect(denied.rpc).toHaveBeenCalledWith('crm_is_gestao')
})

it('devolve nomes de anúncio distintos sob RLS, com amostra limitada e sem service role', async () => {
  const { from, query, admin } = setup({ data: [
    { fb_ad_name: 'Campanha A' }, { fb_ad_name: 'Campanha A' }, { fb_ad_name: 'Campanha B' },
  ] })
  const response = await GET(get('Campanha'))
  expect(await response.json()).toEqual({ anuncios: ['Campanha A', 'Campanha B'], truncado: false })
  expect(from).toHaveBeenCalledWith('leads')
  expect(query.select).toHaveBeenCalledWith('fb_ad_name', { count: 'exact' })
  expect(query.limit).toHaveBeenCalledWith(1001)
  expect(admin.from).not.toHaveBeenCalled()
  expect(admin.rpc).not.toHaveBeenCalled()
  expect(response.headers.get('Cache-Control')).toContain('no-store')
})

it('escapa curingas da busca e exige 2..80 caracteres', async () => {
  const { query, from } = setup()
  await GET(get('A_%'))
  expect(query.ilike).toHaveBeenCalledWith('fb_ad_name', '%A\\_\\%%')
  expect((await GET(get('a'))).status).toBe(400)
  expect((await GET(get('a'.repeat(81)))).status).toBe(400)
  expect(from).toHaveBeenCalledTimes(1)
})

it('avisa quando há mais nomes distintos ou quando a amostra foi cortada', async () => {
  setup({ data: Array.from({ length: 31 }, (_, i) => ({ fb_ad_name: `Anúncio ${i}` })) })
  const manyNames = await (await GET(get('Anúncio'))).json()
  expect(manyNames.anuncios).toHaveLength(30)
  expect(manyNames.truncado).toBe(true)
  setup({ data: Array.from({ length: 1001 }, () => ({ fb_ad_name: 'Anúncio único' })) })
  const manyRows = await (await GET(get('Anúncio'))).json()
  expect(manyRows.anuncios).toEqual(['Anúncio único'])
  expect(manyRows.truncado).toBe(true)
  setup({ data: Array.from({ length: 1000 }, () => ({ fb_ad_name: 'Anúncio único' })), count: 1001 })
  const cappedByApi = await (await GET(get('Anúncio'))).json()
  expect(cappedByApi.anuncios).toEqual(['Anúncio único'])
  expect(cappedByApi.truncado).toBe(true)
})

it('seleciona nome exato e intervalo inclusivo de criação, com contagem exata', async () => {
  const row = { id: 'lead-1', nome: ' Ana ', name: null, whatsapp: ' 5511999 ', phone: null }
  const { query, from, admin } = setup({ data: [row], count: 1 })
  const response = await POST(post({ anuncio: 'Ad exato', criadoDe: '2026-09-01T00:00:00Z', criadoAte: '2026-09-28T23:59:59.999999Z' }))
  expect(await response.json()).toEqual({ leads: [{ id: 'lead-1', nome: 'Ana', telefone: '5511999' }], total: 1 })
  expect(from).toHaveBeenCalledWith('leads')
  expect(query.select).toHaveBeenCalledWith('id,nome,name,whatsapp,phone', { count: 'exact' })
  expect(query.eq).toHaveBeenCalledWith('fb_ad_name', 'Ad exato')
  expect(query.gte).toHaveBeenCalledWith('created_at', '2026-09-01T00:00:00Z')
  expect(query.lte).toHaveBeenCalledWith('created_at', '2026-09-28T23:59:59.999999Z')
  expect(query.limit).toHaveBeenCalledWith(501)
  expect(admin.from).not.toHaveBeenCalled()
  expect(admin.rpc).not.toHaveBeenCalled()
  expect(response.headers.get('Cache-Control')).toContain('no-store')
})

it('recusa público acima de 500 com total para refinar, sem expor a lista parcial', async () => {
  setup({ data: [{ id: 'lead-1' }], count: 501 })
  const response = await POST(post({ anuncio: 'Ad exato' }))
  expect(response.status).toBe(422)
  expect(await response.json()).toEqual({ error: 'publico_muito_grande', total: 501 })
})

it.each([
  { anuncio: '' }, { anuncio: 1 }, { anuncio: 'A', criadoDe: '2026-02-30T00:00:00Z' },
  { anuncio: 'A', criadoAte: '2026-09-01' },
  { anuncio: 'A', criadoDe: '2026-09-02T00:00:00Z', criadoAte: '2026-09-01T00:00:00Z' },
  { anuncio: 'A', criadoDe: '2026-09-28T23:59:59.999999Z', criadoAte: '2026-09-28T23:59:59.999Z' },
])('recusa corpo ou data inválida: %j', async (body) => {
  const { from } = setup()
  expect((await POST(post(body))).status).toBe(400)
  expect(from).not.toHaveBeenCalled()
})

it('recusa corpo maior que o limite sem consultar leads', async () => {
  const { from } = setup()
  expect((await POST(post({ anuncio: 'A'.repeat(3000) }))).status).toBe(400)
  expect(from).not.toHaveBeenCalled()
})

it('falha fechado se contagem ou linhas estão incompletas, sem detalhes do banco', async () => {
  setup({ data: [], count: null, error: { message: 'private failure' } })
  const failed = await POST(post({ anuncio: 'Ad exato' }))
  expect(failed.status).toBe(500)
  expect(JSON.stringify(await failed.json())).not.toContain('private')
  setup({ data: [], count: 1 })
  expect((await POST(post({ anuncio: 'Ad exato' }))).status).toBe(500)
})
