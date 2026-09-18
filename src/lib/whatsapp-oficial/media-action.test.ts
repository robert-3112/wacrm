import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendInboxMedia } from './media-action'

afterEach(() => vi.unstubAllGlobals())

describe('sendInboxMedia', () => {
  it('sends multipart media with the conversation and stable request ID', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true, message: { id: 'msg-1' }, replayed: false,
    }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const file = new File(['%PDF-1.7'], 'planta.pdf', { type: 'application/pdf' })
    const result = await sendInboxMedia('conv-1', 'request-1', file, 'Planta')
    expect(result.ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/whatsapp-oficial/messages/media')
    expect(init.headers).toEqual({
      'x-conversation-id': 'conv-1', 'x-client-request-id': 'request-1',
    })
    expect(init.body).toBeInstanceOf(FormData)
    expect((init.body as FormData).get('file')).toBeInstanceOf(File)
    expect((init.body as FormData).get('caption')).toBe('Planta')
  })

  it('returns a retryable user-facing error after a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const result = await sendInboxMedia('conv-1', 'request-1',
      new File(['%PDF-1.7'], 'planta.pdf', { type: 'application/pdf' }), '')
    expect(result).toEqual({ ok: false, error: expect.stringContaining('rede') })
  })
})
