import { beforeEach, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'
import { POST } from './route'
const mocks = vi.hoisted(() => ({ session: vi.fn() }))
vi.mock('@/lib/whatsapp-oficial/api-auth', async (original) => ({
  ...await original<typeof import('@/lib/whatsapp-oficial/api-auth')>(), requireGestaoSession: mocks.session,
}))
const id = '11111111-1111-4111-8111-111111111111'
const rpc = vi.fn()
beforeEach(() => {
  __resetRateLimitForTests(); rpc.mockReset().mockResolvedValue({ data: { ok: true, broadcast_id: id } })
  mocks.session.mockResolvedValue({ userId: id, admin: { rpc } })
})
async function create(config: unknown) {
  return POST(new Request('http://localhost/api/whatsapp-oficial/campanhas', { method: 'POST',
    body: JSON.stringify({ canalId: id, nome: 'Rascunho', config }) }))
}
it.each([{ modo: 'selecionados' }, { modo: 'selecionados', lead_ids: [] }, { lead_ids: [] },
  { lead_ids: ['invalid'] }, { lead_ids: null }, { lead_ids: 'id' }])
  ('recusa público explícito vazio ou inválido: %j', async (segmentacao) => {
    expect((await create({ segmentacao })).status).toBe(422)
    expect(rpc).not.toHaveBeenCalled()
  })
it.each(['2020-01-01T12:00:00Z', '2099-01-01T12:00', '2099-02-31T12:00:00Z', 'invalid', 123])
  ('recusa agendamento passado, sem fuso ou inválido: %s', async (agendado_para) => {
    expect((await create({ agendado_para })).status).toBe(422)
    expect(rpc).not.toHaveBeenCalled()
  })
it('preserva seleção explícita, filtros e agendamento UTC para RPC', async () => {
  const config = { segmentacao: { modo: 'selecionados', lead_ids: [id], etapas: ['novo'] },
    agendado_para: '2099-10-20T17:30:00.000Z' }
  expect((await create(config)).status).toBe(201)
  expect(rpc.mock.calls[0][1].p_config).toEqual(config)
})
it('exige confirmação explícita de escopo no modo segmento', async () => {
  expect((await create({ segmentacao: { modo: 'segmento' } })).status).toBe(422)
  expect(rpc).not.toHaveBeenCalled()
  expect((await create({ segmentacao: { modo: 'segmento', confirmado: true, tags: ['teste'] } })).status).toBe(201)
})
