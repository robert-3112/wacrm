import { beforeEach, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'
import { UnauthorizedError } from '@/lib/whatsapp-oficial/api-auth'
import { POST } from './route'

const mocks = vi.hoisted(() => ({ session: vi.fn() }))
vi.mock('@/lib/whatsapp-oficial/api-auth', async (original) => ({
  ...await original<typeof import('@/lib/whatsapp-oficial/api-auth')>(),
  requireGestaoSession: mocks.session,
}))

type Row = { id: string; nome: string | null; name: string | null; whatsapp: string | null; phone: string | null }
const row = (id: string, whatsapp: string | null, phone: string | null = null): Row =>
  ({ id, nome: `Lead ${id}`, name: null, whatsapp, phone })

function setup(rows: Row[] = [], options: { count?: number | null; error?: unknown; role?: boolean; roleError?: unknown } = {}) {
  const query = {
    select: vi.fn().mockReturnThis(), or: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockImplementation(async () => ({ data: rows, count: options.count === undefined ? rows.length : options.count, error: options.error ?? null })),
  }
  const from = vi.fn(() => query)
  const rpc = vi.fn().mockResolvedValue({ data: options.role ?? true, error: options.roleError ?? null })
  const admin = { from: vi.fn(), rpc: vi.fn() }
  mocks.session.mockResolvedValue({ userId: 'user', supabaseUser: { from, rpc }, admin })
  return { query, from, rpc, admin }
}
const request = (telefones: unknown) => new Request('http://localhost/api/whatsapp-oficial/campanhas/leads/resolver', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ telefones }),
})
beforeEach(() => { vi.resetAllMocks(); __resetRateLimitForTests() })

it('exige sessão de gestão antes de ler leads', async () => {
  const { from, rpc, admin } = setup()
  mocks.session.mockRejectedValue(new UnauthorizedError())
  expect((await POST(request(['11999999999']))).status).toBe(401)
  expect(rpc).not.toHaveBeenCalled()
  expect(from).not.toHaveBeenCalled()
  expect(admin.from).not.toHaveBeenCalled()
})

it('nega corretor mesmo que sua RLS permita ler alguns leads', async () => {
  const { from } = setup([], { role: false })
  expect((await POST(request(['11999999999']))).status).toBe(403)
  expect(from).not.toHaveBeenCalled()
})

it('faz correspondência exata de local e 55, sem inventar nono dígito', async () => {
  const { query, from, admin } = setup([
    row('sem-nono', '554799994800'),
    row('com-nono', '5547999994800'),
    row('outro', '554899994800'),
  ])
  const response = await POST(request(['(47) 9999-4800', '+55 47 99999-4800', '47 9999 4800']))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    leads: [{ id: 'sem-nono', nome: 'Lead sem-nono', telefone: '554799994800' },
      { id: 'com-nono', nome: 'Lead com-nono', telefone: '5547999994800' }],
    encontrados: 2, ausentes: 0, ambiguos: 0, duplicados: 1, invalidos: 0,
  })
  expect(from).toHaveBeenCalledWith('leads')
  expect(query.select).toHaveBeenCalledWith('id,nome,name,whatsapp', { count: 'exact' })
  expect(query.limit).toHaveBeenCalledWith(1000)
  expect(query.or.mock.calls[0][0]).toMatch(/^whatsapp\.ilike\.[%\d,]+$/)
  expect(admin.from).not.toHaveBeenCalled()
  expect(response.headers.get('Cache-Control')).toContain('no-store')
})

it('conta ausentes, inválidos e duplicados sem retornar lead ambíguo', async () => {
  setup([row('a', '5511999999999'), row('b', '(11) 99999-9999')])
  const body = await (await POST(request(['11999999999', '5511999999999', '11888888888', 'abc']))).json()
  expect(body).toEqual({ leads: [], encontrados: 0, ausentes: 1, ambiguos: 1, duplicados: 1, invalidos: 1 })
})

it('não seleciona telefone secundário que a campanha não usa para enviar', async () => {
  setup([row('a', '5511999999999', '5511888888888')])
  const body = await (await POST(request(['11999999999', '11888888888']))).json()
  expect(body.leads).toHaveLength(1)
  expect(body.encontrados).toBe(1)
  expect(body.ausentes).toBe(1)
})

it('não usa o campo phone quando whatsapp aponta a outro destinatário', async () => {
  setup([row('a', '5511999999999', '(11) 88888-8888')])
  const body = await (await POST(request(['11888888888']))).json()
  expect(body.leads).toEqual([])
  expect(body.ausentes).toBe(1)
})

it('falha fechado se consulta corta candidatos ou perde a contagem', async () => {
  for (const count of [2, null]) {
    const { admin } = setup([row('a', '5511999999999')], { count })
    const response = await POST(request(['11999999999']))
    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain('5511999999999')
    expect(admin.from).not.toHaveBeenCalled()
    __resetRateLimitForTests()
  }
})

it('rejeita tamanho e formato antes de consultar o CRM', async () => {
  const { from } = setup()
  expect((await POST(request([]))).status).toBe(400)
  expect((await POST(request(Array(501).fill('11999999999')))).status).toBe(400)
  expect((await POST(request([123]))).status).toBe(400)
  expect(from).not.toHaveBeenCalled()
})
