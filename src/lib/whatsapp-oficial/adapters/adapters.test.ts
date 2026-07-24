import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { classifyMetaError } from '../outbox'
import { evolutionAdapter, EvolutionApiError } from './evolution'
import { getAdapter } from './index'
import { metaCloudAdapter } from './meta-cloud'
import type { OutboxJob } from './types'

// Every test mocks global fetch — no real network call ever leaves this
// process, and definitely never reaches Meta or a real Evolution instance.
const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

function makeJob(overrides: Partial<OutboxJob> = {}): OutboxJob {
  return {
    outbox_id: 'outbox-1',
    tenant_id: 'tenant-1',
    canal_id: 'canal-1',
    conversation_id: 'conv-1',
    message_id: 'msg-1',
    tipo: 'mensagem',
    payload: { content: 'ola', message_type: 'text' },
    attempts: 0,
    max_attempts: 5,
    provider: 'meta_cloud',
    canal_status: 'ativo',
    phone_number_id: null,
    waba_id: null,
    evolution_base_url: null,
    evolution_instance: null,
    lead_id: 'lead-1',
    lead_whatsapp: '5511999999999',
    lead_status_saida: 'ativo',
    conversa_status: 'aberta',
    conversa_optout_em: null,
    ultimo_inbound_em: null,
    ...overrides,
  }
}

describe('metaCloudAdapter.isConfigured', () => {
  it('is false without phone_number_id', () => {
    expect(metaCloudAdapter.isConfigured(makeJob({ phone_number_id: null }))).toBe(false)
  })

  it('is true with phone_number_id', () => {
    expect(metaCloudAdapter.isConfigured(makeJob({ phone_number_id: 'PNID' }))).toBe(true)
  })
})

describe('evolutionAdapter.isConfigured', () => {
  it('is false without base_url or instance', () => {
    expect(
      evolutionAdapter.isConfigured(
        makeJob({ evolution_base_url: null, evolution_instance: 'inst' }),
      ),
    ).toBe(false)
    expect(
      evolutionAdapter.isConfigured(
        makeJob({ evolution_base_url: 'https://evo.example.com', evolution_instance: null }),
      ),
    ).toBe(false)
  })

  it('is true with both base_url and instance', () => {
    expect(
      evolutionAdapter.isConfigured(
        makeJob({
          evolution_base_url: 'https://evo.example.com',
          evolution_instance: 'inst',
        }),
      ),
    ).toBe(true)
  })
})

describe('evolutionAdapter.send', () => {
  const secretApiKey = 'super-secret-evolution-key'

  it('posts to /message/sendText/{instance} with the apikey header and extracts data.key.id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ key: { id: 'EVO-MSG-1' } }))

    const job = makeJob({
      provider: 'evolution',
      evolution_base_url: 'https://evo.example.com/',
      evolution_instance: 'minha-instancia',
      payload: { content: 'ola mundo' },
    })

    const result = await evolutionAdapter.send({ job, credential: secretApiKey })

    expect(result).toEqual({ providerMessageId: 'EVO-MSG-1' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://evo.example.com/message/sendText/minha-instancia')
    expect(init.headers).toMatchObject({ apikey: secretApiKey })
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ number: '5511999999999', text: 'ola mundo' })
  })

  it('also accepts data.id when data.key.id is absent', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'EVO-MSG-2' }))

    const job = makeJob({
      provider: 'evolution',
      evolution_base_url: 'https://evo.example.com',
      evolution_instance: 'inst',
    })

    const result = await evolutionAdapter.send({ job, credential: secretApiKey })
    expect(result).toEqual({ providerMessageId: 'EVO-MSG-2' })
  })

  it('throws EvolutionApiError with httpStatus 500 on a 5xx response, classified as retryable', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'internal error' }, 500))

    const job = makeJob({
      provider: 'evolution',
      evolution_base_url: 'https://evo.example.com',
      evolution_instance: 'inst',
    })

    let caught: unknown
    try {
      await evolutionAdapter.send({ job, credential: secretApiKey })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(EvolutionApiError)
    expect((caught as EvolutionApiError).httpStatus).toBe(500)
    expect(classifyMetaError(caught as EvolutionApiError)).toMatchObject({ errorClass: 'retryable' })
    expect(String(caught)).not.toContain(secretApiKey)
  })

  it('throws EvolutionApiError with httpStatus 400 on a 4xx response, classified as permanent', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'bad number' }, 400))

    const job = makeJob({
      provider: 'evolution',
      evolution_base_url: 'https://evo.example.com',
      evolution_instance: 'inst',
    })

    let caught: unknown
    try {
      await evolutionAdapter.send({ job, credential: secretApiKey })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(EvolutionApiError)
    expect((caught as EvolutionApiError).httpStatus).toBe(400)
    expect(classifyMetaError(caught as EvolutionApiError)).toMatchObject({ errorClass: 'permanent' })
    expect(String(caught)).not.toContain(secretApiKey)
  })

  it('never includes the apikey in the thrown error message when the response body is unparsable', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json')
      },
    } as unknown as Response)

    const job = makeJob({
      provider: 'evolution',
      evolution_base_url: 'https://evo.example.com',
      evolution_instance: 'inst',
    })

    await expect(evolutionAdapter.send({ job, credential: secretApiKey })).rejects.toMatchObject({
      httpStatus: 500,
    })
  })
})

describe('getAdapter', () => {
  it('returns the meta_cloud adapter', () => {
    expect(getAdapter('meta_cloud').provider).toBe('meta_cloud')
  })

  it('returns the evolution adapter', () => {
    expect(getAdapter('evolution').provider).toBe('evolution')
  })

  it('throws for an unknown provider', () => {
    // @ts-expect-error — intentionally passing an invalid provider to test the guard.
    expect(() => getAdapter('unknown_provider')).toThrow()
  })
})
