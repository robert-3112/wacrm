import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { carregarResumoCampanhas, contadoresCampanha, dataCampanha } from './campanha-evidencia'

const resumo = {
  broadcast_id: 'a', calculado_em: '2026-09-22T15:00:00Z', total: 11, enfileirados: 11,
  por_status: { simulado: 5, enviado: 3, entregue: 2, lido: 1 }, por_motivo_supressao: {}, truncado: false,
}
function client(data: unknown, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error })
  return { rpc } as unknown as Pick<SupabaseClient, 'rpc'>
}
describe('resumo de campanhas', () => {
  it('contadores cumulativos excluem simulado de envio e entrega', () => {
    expect(contadoresCampanha(resumo)).toMatchObject({ total_enviados: 6, total_entregues: 3, total_lidos: 1 })
  })
  it('lista vazia não chama RPC', async () => {
    const admin = client(null)
    expect(await carregarResumoCampanhas(admin, [])).toEqual([])
    expect(admin.rpc).not.toHaveBeenCalled()
  })
  it('agrupa IDs por tenant, sem incluir campanha de outro tenant na chamada', async () => {
    const rpc = vi.fn().mockImplementation(async (_name, args) => ({
      data: args.p_broadcast_ids.map((id: string) => ({ ...resumo, broadcast_id: id })), error: null,
    }))
    const admin = { rpc } as unknown as Pick<SupabaseClient, 'rpc'>
    await carregarResumoCampanhas(admin, [{ id: 'a', tenant_id: 'sunt' }, { id: 'b', tenant_id: 'outro' }])
    expect(rpc.mock.calls.map(c => c[1])).toEqual([
      { p_tenant_id: 'sunt', p_broadcast_ids: ['a'] }, { p_tenant_id: 'outro', p_broadcast_ids: ['b'] },
    ])
  })
  it.each([null, [], [{ ...resumo, broadcast_id: 'invisivel' }], [resumo, resumo],
    [{ ...resumo, total: 99 }], [{ ...resumo, por_status: null }], [{ ...resumo, calculado_em: null }],
  ])('recusa resposta ausente ou inválida sem fabricar zeros: %j', async (data) => {
    await expect(carregarResumoCampanhas(client(data), [{ id: 'a', tenant_id: 'sunt' }])).rejects.toThrow()
  })
  it('propaga falha do banco', async () => {
    await expect(carregarResumoCampanhas(client(null, new Error('unavailable')), [{ id: 'a', tenant_id: 'sunt' }])).rejects.toThrow('unavailable')
  })
  it('mostra fuso explícito e horário Brasília independente do servidor', () => {
    expect(dataCampanha('2026-09-22T15:00:00Z')).toBe('22/09/2026, 12:00:00 (Brasília, America/Sao_Paulo)')
  })
})
