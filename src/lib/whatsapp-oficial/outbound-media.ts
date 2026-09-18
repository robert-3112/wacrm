/** Narrow formats with a server-side container check before Meta upload. */
const FORMATS = {
  'image/jpeg': { kind: 'image', extensions: ['jpg', 'jpeg'], maxBytes: 5 * 1024 * 1024,
    signature: [0xff, 0xd8, 0xff] },
  'image/png': { kind: 'image', extensions: ['png'], maxBytes: 5 * 1024 * 1024,
    signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  'application/pdf': { kind: 'document', extensions: ['pdf'], maxBytes: 16 * 1024 * 1024,
    signature: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  'audio/mpeg': { kind: 'audio', extensions: ['mp3'], maxBytes: 16 * 1024 * 1024,
    signature: [] },
  'video/mp4': { kind: 'video', extensions: ['mp4'], maxBytes: 16 * 1024 * 1024,
    signature: [] },
} as const

export type OutboundMediaKind = 'image' | 'document' | 'audio' | 'video'

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

/** ID3v2 may precede the first MPEG Layer III frame. Reject a renamed file. */
async function hasMp3Frame(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer())
  let offset = 0
  if (head.length >= 10 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
    if (head[3] < 2 || head[3] > 4 || head[6] > 0x7f || head[7] > 0x7f ||
        head[8] > 0x7f || head[9] > 0x7f) return false
    const tagSize = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9]
    offset = 10 + tagSize + (head[5] & 0x10 ? 10 : 0)
  }
  if (offset + 4 > file.size) return false
  const frame = new Uint8Array(await file.slice(offset, offset + 4).arrayBuffer())
  return frame[0] === 0xff && (frame[1] & 0xe0) === 0xe0 &&
    ((frame[1] >> 3) & 0x03) !== 0x01 && ((frame[1] >> 1) & 0x03) === 0x01 &&
    ((frame[2] >> 4) & 0x0f) > 0 && ((frame[2] >> 4) & 0x0f) < 0x0f &&
    ((frame[2] >> 2) & 0x03) !== 0x03
}

/** Check ISO-BMFF box boundaries and the media boxes; Meta validates codecs. */
async function hasMp4Structure(file: File): Promise<boolean> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const view = new DataView(bytes.buffer)
  let offset = 0
  let first = true
  let ftyp = false
  let moov = false
  let mdat = false
  while (offset + 8 <= bytes.length) {
    let size = view.getUint32(offset)
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8))
    let headerSize = 8
    if (size === 1) {
      if (offset + 16 > bytes.length) return false
      const extended = view.getBigUint64(offset + 8)
      if (extended > BigInt(bytes.length)) return false
      size = Number(extended)
      headerSize = 16
    } else if (size === 0) {
      size = bytes.length - offset
    }
    if (size < headerSize || offset + size > bytes.length) return false
    if (first && (type !== 'ftyp' || size < 16)) return false
    if (type === 'ftyp') ftyp = true
    if (type === 'moov') moov = true
    if (type === 'mdat' && size > headerSize) mdat = true
    first = false
    offset += size
  }
  return offset === bytes.length && ftyp && moov && mdat
}

export async function validateOutboundMedia(file: File, rawCaption: string): Promise<ValidatedOutboundMedia> {
  const caption = rawCaption.trim()
  if (caption.length > 1024) throw new MediaValidationError('Legenda excede 1024 caracteres.')

  const format = FORMATS[file.type as keyof typeof FORMATS]
  if (!format) throw new MediaValidationError('Formato não suportado. Use JPG, PNG, PDF, MP3 ou MP4.')
  if (format.kind === 'audio' && caption) {
    throw new MediaValidationError('Áudio não aceita legenda; envie o texto separadamente.')
  }
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
  if (format.kind === 'audio' && !(await hasMp3Frame(file))) {
    throw new MediaValidationError('Assinatura MP3 inválida ou sem quadro de áudio.')
  }
  if (format.kind === 'video' && !(await hasMp4Structure(file))) {
    throw new MediaValidationError('Estrutura MP4 inválida (ftyp/moov/mdat).')
  }
  return { kind: format.kind, mimeType: file.type as keyof typeof FORMATS, filename, caption }
}
