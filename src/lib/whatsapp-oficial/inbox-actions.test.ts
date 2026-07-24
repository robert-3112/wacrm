import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addInternalNote,
  markConversationRead,
  registerHandoff,
  registerOptout,
  sendTextMessage,
  updateConversationStatus,
} from './inbox-actions'

function mockFetchOnce(status: number, json: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sendTextMessage', () => {
  it('POSTs to the send route and returns the created message on success', async () => {
    const message = { id: 'm1', conversation_id: 'c1', content: 'oi' }
    const fetchMock = mockFetchOnce(201, { ok: true, message })
    const result = await sendTextMessage('c1', 'oi')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/whatsapp-oficial/messages/send',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ conversationId: 'c1', content: 'oi' }),
      }),
    )
    expect(result).toEqual({ ok: true, data: { ok: true, message } })
  })

  it('surfaces the server error message on failure', async () => {
    mockFetchOnce(400, { error: 'content is required' })
    const result = await sendTextMessage('c1', '')
    expect(result).toEqual({ ok: false, error: 'content is required' })
  })

  it('falls back to a generic message when the response has no error field', async () => {
    mockFetchOnce(500, {})
    const result = await sendTextMessage('c1', 'oi')
    expect(result).toEqual({ ok: false, error: 'Falha na requisição (500)' })
  })

  it('surfaces a network failure without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network down')),
    )
    const result = await sendTextMessage('c1', 'oi')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/rede/i)
    }
  })
})

describe('addInternalNote', () => {
  it('POSTs conversationId/conteudo to the notes route', async () => {
    const note = { id: 'n1', conversation_id: 'c1', conteudo: 'ligar depois' }
    const fetchMock = mockFetchOnce(201, { ok: true, note })
    const result = await addInternalNote('c1', 'ligar depois')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/whatsapp-oficial/notes',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ conversationId: 'c1', conteudo: 'ligar depois' }),
      }),
    )
    expect(result).toEqual({ ok: true, data: { ok: true, note } })
  })
})

describe('markConversationRead', () => {
  it('POSTs to the read route with no body payload beyond {}', async () => {
    const fetchMock = mockFetchOnce(200, { ok: true })
    await markConversationRead('c1')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/whatsapp-oficial/conversations/c1/read',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    )
  })
})

describe('updateConversationStatus', () => {
  it('PATCHes the status route', async () => {
    const fetchMock = mockFetchOnce(200, { ok: true, status: 'encerrada' })
    const result = await updateConversationStatus('c1', 'encerrada')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/whatsapp-oficial/conversations/c1/status',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ status: 'encerrada' }),
      }),
    )
    expect(result).toEqual({ ok: true, data: { ok: true, status: 'encerrada' } })
  })
})

describe('registerHandoff', () => {
  it('maps camelCase input to the RPC snake_case body', async () => {
    const fetchMock = mockFetchOnce(200, { ok: true })
    await registerHandoff('c1', {
      empreendimentoInteresseSlug: 'residencial-x',
      intencao: 'comprar',
      regiaoInteresse: 'centro',
      interesse: 'apartamento',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/whatsapp-oficial/conversations/c1/handoff',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          empreendimento_interesse_slug: 'residencial-x',
          intencao: 'comprar',
          regiao_interesse: 'centro',
          interesse: 'apartamento',
        }),
      }),
    )
  })

  it('defaults to an empty payload when no input is given', async () => {
    const fetchMock = mockFetchOnce(200, { ok: true })
    await registerHandoff('c1')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/whatsapp-oficial/conversations/c1/handoff',
      expect.objectContaining({
        body: JSON.stringify({
          empreendimento_interesse_slug: undefined,
          intencao: undefined,
          regiao_interesse: undefined,
          interesse: undefined,
        }),
      }),
    )
  })

  it('surfaces a 422 business-rule rejection as an error result', async () => {
    mockFetchOnce(422, { error: 'lead_ja_qualificado' })
    const result = await registerHandoff('c1')
    expect(result).toEqual({ ok: false, error: 'lead_ja_qualificado' })
  })
})

describe('registerOptout', () => {
  it('POSTs to the optout route', async () => {
    const fetchMock = mockFetchOnce(200, { ok: true })
    const result = await registerOptout('c1')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/whatsapp-oficial/conversations/c1/optout',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(result).toEqual({ ok: true, data: { ok: true } })
  })
})
