import { describe, expect, it } from 'vitest'
import { validateOutboundMedia } from './outbound-media'

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
})
