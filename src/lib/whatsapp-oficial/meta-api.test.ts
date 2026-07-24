import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MetaApiError,
  downloadMedia,
  getMediaUrl,
  sendMediaMessage,
  sendTemplateMessage,
  sendTextMessage,
} from './meta-api'

// Every test mocks global fetch — no real network call ever leaves this
// process, and definitely never reaches graph.facebook.com.
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

describe('sendTextMessage', () => {
  it('posts the expected payload and returns the Meta message id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ messages: [{ id: 'wamid.TEXT1' }] }))

    const result = await sendTextMessage({
      phoneNumberId: 'PNID',
      accessToken: 'tok',
      to: '5511999999999',
      text: 'ola',
    })

    expect(result).toEqual({ messageId: 'wamid.TEXT1' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://graph.facebook.com/v24.0/PNID/messages')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok' })
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({
      messaging_product: 'whatsapp',
      to: '5511999999999',
      type: 'text',
      text: { body: 'ola' },
    })
  })

  it('throws MetaApiError with code/httpStatus preserved on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: 'Invalid parameter', code: 100 } }, 400),
    )

    await expect(
      sendTextMessage({ phoneNumberId: 'PNID', accessToken: 'tok', to: '551199', text: 'x' }),
    ).rejects.toMatchObject({
      name: 'MetaApiError',
      message: 'Invalid parameter',
      code: 100,
      httpStatus: 400,
    })
  })
})

describe('sendMediaMessage — audio caption/filename rule', () => {
  it('sends only { link } for audio — no caption, no filename', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ messages: [{ id: 'wamid.AUDIO1' }] }))

    await sendMediaMessage({
      phoneNumberId: 'PNID',
      accessToken: 'tok',
      to: '5511999999999',
      kind: 'audio',
      link: 'https://example.com/voice.ogg',
      caption: 'should be dropped',
      filename: 'should-also-be-dropped.ogg',
    })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.audio).toEqual({ link: 'https://example.com/voice.ogg' })
  })

  it('keeps caption for image and filename+caption for document', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ messages: [{ id: 'wamid.X' }] }))

    await sendMediaMessage({
      phoneNumberId: 'PNID',
      accessToken: 'tok',
      to: '5511999999999',
      kind: 'image',
      link: 'https://example.com/a.jpg',
      caption: 'a caption',
    })
    let body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.image).toEqual({ link: 'https://example.com/a.jpg', caption: 'a caption' })

    await sendMediaMessage({
      phoneNumberId: 'PNID',
      accessToken: 'tok',
      to: '5511999999999',
      kind: 'document',
      link: 'https://example.com/a.pdf',
      caption: 'doc caption',
      filename: 'contrato.pdf',
    })
    body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)
    expect(body.document).toEqual({
      link: 'https://example.com/a.pdf',
      caption: 'doc caption',
      filename: 'contrato.pdf',
    })
  })

  it('throws without calling fetch when link is missing', async () => {
    await expect(
      sendMediaMessage({
        phoneNumberId: 'PNID',
        accessToken: 'tok',
        to: '551199',
        kind: 'image',
        link: '',
      }),
    ).rejects.toThrow('requires a link')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('sendTemplateMessage', () => {
  it('sends a body-only legacy payload when no componentes are supplied', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ messages: [{ id: 'wamid.T1' }] }))

    await sendTemplateMessage({
      phoneNumberId: 'PNID',
      accessToken: 'tok',
      to: '5511999999999',
      templateName: 'boas_vindas',
      language: 'pt_BR',
      params: ['Maria', '#123'],
    })

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.template).toMatchObject({
      name: 'boas_vindas',
      language: { code: 'pt_BR' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'Maria' },
            { type: 'text', text: '#123' },
          ],
        },
      ],
    })
  })

  it('builds header + body components from componentes + messageParams', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ messages: [{ id: 'wamid.T2' }] }))

    await sendTemplateMessage({
      phoneNumberId: 'PNID',
      accessToken: 'tok',
      to: '5511999999999',
      templateName: 'promo_imagem',
      componentes: [
        { type: 'HEADER', format: 'IMAGE', example: { header_url: ['https://example.com/promo.jpg'] } },
        { type: 'BODY', text: 'Oi {{1}}, aproveite {{2}}!' },
      ],
      messageParams: { body: ['Maria', '20% off'] },
    })

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.template.components).toEqual([
      { type: 'header', parameters: [{ type: 'image', image: { link: 'https://example.com/promo.jpg' } }] },
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Maria' },
          { type: 'text', text: '20% off' },
        ],
      },
    ])
  })
})

describe('getMediaUrl / downloadMedia', () => {
  it('resolves the CDN url + mime type', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ url: 'https://cdn.example/media.jpg', mime_type: 'image/jpeg' }),
    )
    const result = await getMediaUrl({ mediaId: 'MID', accessToken: 'tok' })
    expect(result).toEqual({ url: 'https://cdn.example/media.jpg', mimeType: 'image/jpeg' })
  })

  it('downloads bytes with the same bearer token', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    } as unknown as Response)

    const result = await downloadMedia({ downloadUrl: 'https://cdn.example/media.jpg', accessToken: 'tok' })
    expect(result.contentType).toBe('image/jpeg')
    expect(Array.from(result.buffer)).toEqual([1, 2, 3])
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
  })

  it('throws MetaApiError (not a bare Error) on a failed download', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 } as Response)
    await expect(
      downloadMedia({ downloadUrl: 'https://cdn.example/gone.jpg', accessToken: 'tok' }),
    ).rejects.toBeInstanceOf(MetaApiError)
  })
})
