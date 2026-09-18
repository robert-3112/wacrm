/** First outbound-media slice: formats that can be checked cheaply on the server. */
const FORMATS = {
  'image/jpeg': { kind: 'image', extensions: ['jpg', 'jpeg'], maxBytes: 5 * 1024 * 1024,
    signature: [0xff, 0xd8, 0xff] },
  'image/png': { kind: 'image', extensions: ['png'], maxBytes: 5 * 1024 * 1024,
    signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  'application/pdf': { kind: 'document', extensions: ['pdf'], maxBytes: 16 * 1024 * 1024,
    signature: [0x25, 0x50, 0x44, 0x46, 0x2d] },
} as const

export type OutboundMediaKind = 'image' | 'document'

export interface ValidatedOutboundMedia {
  kind: OutboundMediaKind
  mimeType: keyof typeof FORMATS
  filename: string
  caption: string
}

export class MediaValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MediaValidationError'
  }
}

export async function validateOutboundMedia(file: File, rawCaption: string): Promise<ValidatedOutboundMedia> {
  const caption = rawCaption.trim()
  if (caption.length > 1024) throw new MediaValidationError('Legenda excede 1024 caracteres.')

  const format = FORMATS[file.type as keyof typeof FORMATS]
  if (!format) throw new MediaValidationError('Formato não suportado. Use JPG, PNG ou PDF.')
  const filename = file.name.split(/[\\/]/).pop() ?? ''
  const extension = filename.split('.').pop()?.toLowerCase() ?? ''
  if (!filename || filename.length > 120 || /[\u0000-\u001f]/.test(filename) ||
      !(format.extensions as readonly string[]).includes(extension)) {
    throw new MediaValidationError('Nome ou extensão do arquivo inválidos.')
  }
  if (file.size === 0 || file.size > format.maxBytes) {
    const maxMb = format.maxBytes / (1024 * 1024)
    throw new MediaValidationError(`Arquivo vazio ou acima do limite de ${maxMb} MB.`)
  }
  const bytes = new Uint8Array(await file.slice(0, format.signature.length).arrayBuffer())
  if (!format.signature.every((byte, i) => bytes[i] === byte)) {
    throw new MediaValidationError('Assinatura do arquivo não corresponde ao formato informado.')
  }
  return { kind: format.kind, mimeType: file.type as keyof typeof FORMATS, filename, caption }
}
