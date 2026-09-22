import { beforeEach, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'
import { UnauthorizedError } from '@/lib/whatsapp-oficial/api-auth'
import { GET } from './route'

const mocks = vi.hoisted(() => ({ session: vi.fn() }))
vi.mock('@/lib/whatsapp-oficial/api-auth', async (original) => ({
  ...await original<typeof import('@/lib/whatsapp-oficial/api-auth')>(),
  requireGestaoSession: mocks.session,
}))

function setup(data: unknown[] = [], error: unknown = null) {
  const query = { select: vi.fn().mockReturnThis(), or: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue({ data, error }) }
  const from = vi.fn(() => query)
  const admin = { from: vi.fn(), rpc: vi.fn() }
  mocks.session.mockResolvedValue({ userId: 'user', supabaseUser: { from }, admin })
  return { query, from, admin }
}
const request = (q: string) => new Request(`http://localhost/api/whatsapp-oficial/campanhas/leads?${new URLSearchParams({ q })}`)
beforeEach(() => { vi.resetAllMocks(); __resetRateLimitForTests() })

it('autentica antes de qualquer busca', async () => {
  const { from } = setup()
  mocks.session.mockRejectedValue(new UnauthorizedError())
  expect((await GET(request('Ana'))).status).toBe(401)
  expect(from).not.toHaveBeenCalled()
})
it('consulta somente leads com sessão/RLS e campos mínimos', async () => {
  const { from, query, admin } = setup([{ id: 'id', nome: 'Nome', name: null, whatsapp: '123', phone: null }])
  const response = await GET(request('Nome'))
  expect(await response.json()).toEqual({ leads: [{ id: 'id', nome: 'Nome', telefone: '123' }], truncado: false })
  expect(from).toHaveBeenCalledWith('leads')
  expect(query.select).toHaveBeenCalledWith('id,nome,name,whatsapp,phone')
  expect(query.limit).toHaveBeenCalledWith(21)
  expect(admin.from).not.toHaveBeenCalled()
  expect(admin.rpc).not.toHaveBeenCalled()
  expect(response.headers.get('Cache-Control')).toContain('no-store')
})
it.each(['', 'a', '().,%_*'])('não amplia busca vazia/inválida: %s', async (q) => {
  const { from } = setup()
  expect((await GET(request(q))).status).toBe(400)
  expect(from).not.toHaveBeenCalled()
})
it('impede injeção na sintaxe do filtro', async () => {
  const { query } = setup()
  await GET(request('Ana),tenant_id.neq.x'))
  expect(query.or.mock.calls[0][0]).not.toContain('tenant_id.neq.x')
  expect(query.or.mock.calls[0][0]).not.toContain('),')
})
it('limita resultados e avisa que é preciso refinar a busca', async () => {
  setup(Array.from({ length: 21 }, (_, i) => ({ id: String(i), nome: 'Contato' })))
  const body = await (await GET(request('Contato'))).json()
  expect(body.leads).toHaveLength(20)
  expect(body.truncado).toBe(true)
})
it('não devolve detalhes do banco em falha de consulta', async () => {
  setup([], { message: 'private query failure' })
  const response = await GET(request('Contato'))
  expect(response.status).toBe(500)
  expect(JSON.stringify(await response.json())).not.toContain('private')
})
