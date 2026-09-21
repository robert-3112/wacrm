import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { pauseSophiaForHumanSend } from './sophia-pause'

const CONV = { id: 'conv-1', tenant_id: 'sunt' }

function makeAdmin(state: { data?: unknown; error?: unknown }, rpcResult: { data?: unknown; error?: unknown } = {}) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data: state.data ?? null, error: state.error ?? null })),
  }
  return {
    from: vi.fn(() => query),
    rpc: vi.fn(async () => ({ data: rpcResult.data ?? null, error: rpcResult.error ?? null })),
  }
}

const run = (admin: ReturnType<typeof makeAdmin>) =>
  pauseSophiaForHumanSend(admin as unknown as SupabaseClient, CONV, 'user-1')

describe('pauseSophiaForHumanSend', () => {
  it('pauses an active Sophia with the real actor and reports replies in flight', async () => {
    const admin = makeAdmin({ data: { sophia_ativa: true } },
      { data: { ok: true, sophia_ativa: false, cancelled_replies: 2, in_flight_replies: 1 } })
    expect(await run(admin)).toEqual({ sophia_pausada: true, in_flight_replies: 1 })
    expect(admin.rpc).toHaveBeenCalledWith('whatsapp_sophia_definir_estado', {
      p_conversation_id: 'conv-1', p_actor_user_id: 'user-1', p_ativa: false,
    })
  })

  it('does not call the RPC when Sophia is already off', async () => {
    const admin = makeAdmin({ data: { sophia_ativa: false } })
    expect(await run(admin)).toEqual({ sophia_pausada: false, in_flight_replies: 0 })
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it.each([
    [{ error: { code: 'XX000', message: 'db down' } }, 500],
    [{ error: { code: '42501', message: 'sem_permissao' } }, 403],
    [{ data: { ok: false, reason: 'conversa_nao_encontrada' } }, 409],
  ])('fails closed when the pause fails (%j)', async (rpcResult, status) => {
    const admin = makeAdmin({ data: { sophia_ativa: true } }, rpcResult)
    const result = await run(admin)
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(status)
    expect((await (result as Response).json()).error).toMatch(/não foi enviada/)
  })

  it('fails closed when the state cannot be read', async () => {
    const admin = makeAdmin({ error: { code: 'XX000', message: 'db down' } })
    expect(((await run(admin)) as Response).status).toBe(500)
  })

  it('lets the send proceed while the contract is not deployed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const missingFn = makeAdmin({ data: { sophia_ativa: true } },
      { error: { code: 'PGRST202', message: 'Could not find the function' } })
    expect(await run(missingFn)).toEqual({ sophia_pausada: false, in_flight_replies: 0 })
    expect(warn).toHaveBeenCalled()
    const missingColumn = makeAdmin({ error: { code: '42703', message: 'column does not exist' } })
    expect(await run(missingColumn)).toEqual({ sophia_pausada: false, in_flight_replies: 0 })
    expect(missingColumn.rpc).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
