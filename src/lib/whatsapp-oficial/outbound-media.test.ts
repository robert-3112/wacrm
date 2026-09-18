import { describe, expect, it } from 'vitest'
import { validateOutboundMedia } from './outbound-media'

function mp4Box(type: string, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(payload.length + 8)
  new DataView(bytes.buffer).setUint32(0, bytes.length)
  bytes.set(new TextEncoder().encode(type), 4)
  bytes.set(payload, 8)
  return bytes
}

function validMp4(): Uint8Array {
  return new Uint8Array([
    ...mp4Box('ftyp', new TextEncoder().encode('isom\u0000\u0000\u0000\u0000isom')),
    ...mp4Box('moov', new Uint8Array([0, 1, 2, 3])),
    ...mp4Box('mdat', new Uint8Array([1, 2, 3, 4])),
  ])
}

describe('validateOutboundMedia', () => {
  it('accepts a JPEG within the Meta image limit', async () => {
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0x00])], 'foto.jpg', { type: 'image/jpeg' })
    await expect(validateOutboundMedia(file, '  Fachada  ')).resolves.toEqual({
      kind: 'image', mimeType: 'image/jpeg', filename: 'foto.jpg', caption: 'Fachada',
    })
  })

  it('accepts a PDF document with no caption', async () => {
    const file = new File(['%PDF-1.7'], 'planta.pdf', { type: 'application/pdf' })
    await expect(validateOutboundMedia(file, '')).resolves.toEqual({
      kind: 'document', mimeType: 'application/pdf', filename: 'planta.pdf', caption: '',
    })
  })

  it('rejects a mismatched MIME and file signature', async () => {
    const file = new File(['<script>'], 'planta.pdf', { type: 'application/pdf' })
    await expect(validateOutboundMedia(file, '')).rejects.toThrow('Assinatura')
  })

  it('rejects unsupported formats and overlong captions', async () => {
    const gif = new File(['GIF89a'], 'foto.gif', { type: 'image/gif' })
    await expect(validateOutboundMedia(gif, '')).rejects.toThrow('Formato')
    const pdf = new File(['%PDF-1.7'], 'planta.pdf', { type: 'application/pdf' })
    await expect(validateOutboundMedia(pdf, 'a'.repeat(1025))).rejects.toThrow('1024')
  })

  it('rejects an image over 5 MB', async () => {
    const bytes = new Uint8Array(5 * 1024 * 1024 + 1)
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const file = new File([bytes], 'foto.png', { type: 'image/png' })
    await expect(validateOutboundMedia(file, '')).rejects.toThrow('5 MB')
  })

  it('accepts an MP3 frame within 16 MB without a caption', async () => {
    const file = new File([new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x00])],
      'audio.mp3', { type: 'audio/mpeg' })
    await expect(validateOutboundMedia(file, '')).resolves.toEqual({
      kind: 'audio', mimeType: 'audio/mpeg', filename: 'audio.mp3', caption: '',
    })
  })

  it('accepts an MP3 frame after a valid ID3v2 header', async () => {
    const file = new File([new Uint8Array([
      0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0xff, 0xfb, 0x90, 0x64,
    ])], 'audio.mp3', { type: 'audio/mpeg' })
    await expect(validateOutboundMedia(file, '')).resolves.toMatchObject({ kind: 'audio' })
  })

  it('rejects an MP3 with no valid MPEG audio frame', async () => {
    const file = new File(['ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000fake'],
      'audio.mp3', { type: 'audio/mpeg' })
    await expect(validateOutboundMedia(file, '')).rejects.toThrow('Assinatura')
  })

  it('rejects a caption on MP3 instead of silently discarding it', async () => {
    const file = new File([new Uint8Array([0xff, 0xfb, 0x90, 0x64])],
      'audio.mp3', { type: 'audio/mpeg' })
    await expect(validateOutboundMedia(file, 'Legenda')).rejects.toThrow('Áudio não aceita legenda')
  })

  it('accepts an MP4 with ftyp, moov and mdat boxes under 16 MB', async () => {
    const file = new File([validMp4()], 'tour.mp4', { type: 'video/mp4' })
    await expect(validateOutboundMedia(file, 'Tour')).resolves.toEqual({
      kind: 'video', mimeType: 'video/mp4', filename: 'tour.mp4', caption: 'Tour',
    })
  })

  it('rejects a truncated or missing MP4 moov box', async () => {
    const truncated = new File([new Uint8Array([
      ...mp4Box('ftyp', new TextEncoder().encode('isom\u0000\u0000\u0000\u0000isom')),
      ...mp4Box('mdat', new Uint8Array([1, 2, 3])),
    ])], 'tour.mp4', { type: 'video/mp4' })
    await expect(validateOutboundMedia(truncated, '')).rejects.toThrow('Estrutura')
  })

  it('rejects audio/video over 16 MB or with a mismatched extension', async () => {
    const bytes = new Uint8Array(16 * 1024 * 1024 + 1)
    bytes.set([0xff, 0xfb, 0x90, 0x64])
    await expect(validateOutboundMedia(
      new File([bytes], 'audio.mp3', { type: 'audio/mpeg' }), '',
    )).rejects.toThrow('16 MB')
    await expect(validateOutboundMedia(
      new File([validMp4()], 'tour.avi', { type: 'video/mp4' }), '',
    )).rejects.toThrow('extensão')
  })
})
