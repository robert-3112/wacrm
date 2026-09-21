import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const mocks = vi.hoisted(() => ({ loadChannelCredential: vi.fn() }))
vi.mock('./channel-credentials', () => ({ loadChannelCredential: mocks.loadChannelCredential }))

import { loadManagedChannel, testChannelConnection } from './channel-management'

const ID = '11111111-1111-4111-8111-111111111111'
const meta = { id: ID, tenant_id: 'sunt', provider: 'meta_cloud', status: 'ativo', phone_number_id: '1234567890', waba_id: '9876543210', evolution_base_url: null, evolution_instance: null } as const

function admin(channel: object | null, allowed: boolean): SupabaseClient {
  return {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: channel, error: null }) }) }) }),
    rpc: async () => ({ data: allowed, error: null }),
  } as unknown as SupabaseClient
}

beforeEach(() => {
  vi.unstubAllGlobals()
  mocks.loadChannelCredential.mockReset().mockResolvedValue('secret-only-on-server')
})

describe('channel-management', () => {
  it('hides a channel from an actor outside its tenant before decrypting', async () => {
    await expect(loadManagedChannel(admin(meta, false), 'other-user', ID)).rejects.toMatchObject({ status: 404 })
    expect(mocks.loadChannelCredential).not.toHaveBeenCalled()
  })

  it('probes Meta by GET, checks the exact ID, and never sends a message', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: meta.phone_number_id, display_phone_number: '+55 47 **** 1266' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: meta.phone_number_id }] }) })
    vi.stubGlobal('fetch', fetchMock)
    const channel = await loadManagedChannel(admin(meta, true), 'owner', ID)
    const result = await testChannelConnection(admin(meta, true), channel)
    expect(result).toMatchObject({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toContain(`/${meta.phone_number_id}?fields=`)
    expect(fetchMock.mock.calls[1][0]).toContain(`/${meta.waba_id}/phone_numbers?fields=id`)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual', cache: 'no-store' })
    expect(result).not.toHaveProperty('credential')
  })

  it('refuses a changed Meta ID even after HTTP 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'different' }) }))
    expect(await testChannelConnection(admin(meta, true), meta)).toMatchObject({ ok: false, reason: 'meta_numero_divergente' })
  })

  it('refuses a phone ID outside the configured WABA', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: meta.phone_number_id }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'someone-else' }] }) }))
    expect(await testChannelConnection(admin(meta, true), meta)).toMatchObject({ ok: false, reason: 'meta_waba_divergente' })
  })

  it('does not fetch a stored Evolution origin outside the server allowlist', async () => {
    vi.stubEnv('EVOLUTION_API_URL', 'https://evo.example.com')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const evolution = { ...meta, provider: 'evolution' as const, phone_number_id: null, evolution_base_url: 'https://localhost/', evolution_instance: 'Equipe' }
    expect(await testChannelConnection(admin(evolution, true), evolution)).toMatchObject({ ok: false, reason: 'evolution_origem_nao_permitida' })
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })
})
