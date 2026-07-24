/**
 * Meta WhatsApp Cloud API client for the official channel (SUNT WhatsApp Hub).
 *
 * `sendTextMessage`, `sendMediaMessage`, `getMediaUrl`, `downloadMedia` are
 * REUSED near-1:1 from `src/lib/whatsapp/meta-api.ts` (WACRM original —
 * harvest matrix area 2, classified "Reutilizar": pure functions, named
 * params, no coupling to any account/tenant schema). `sendTemplateMessage`
 * is ADAPTED — it now builds components from `./template-send-builder.ts`
 * (which reads a `whatsapp_templates.componentes` row instead of WACRM's
 * account-scoped `message_templates`).
 *
 * REWRITTEN: error handling. WACRM's `throwMetaError()` only extracts
 * `error.message` and throws a generic `Error` — `code`/`error_subcode`
 * are discarded, so nothing downstream can tell a rate-limit (retry) from
 * an invalid-parameter (permanent) failure. The harvest matrix (areas 1 &
 * 2) flagged this explicitly as a gap with nothing to port ("reescrever").
 * `MetaApiError` below preserves `code`/`errorSubcode`/`httpStatus` so
 * `./outbox.ts`'s `classifyMetaError` has something to classify.
 *
 * Named params throughout (not positional) — same rationale the WACRM
 * header comment gives: a typo surfaces as a TypeScript error, not a
 * runtime argument-swap bug.
 */

const configuredVersion = process.env.META_GRAPH_API_VERSION?.trim()
const META_API_VERSION =
  configuredVersion && /^v\d+\.\d+$/.test(configuredVersion) ? configuredVersion : 'v24.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

export interface MetaSendResult {
  messageId: string
}

interface MetaErrorEnvelope {
  error?: {
    message?: string
    type?: string
    code?: number
    error_subcode?: number
    fbtrace_id?: string
  }
}

/** Error thrown by every helper below on a non-2xx Meta response. Carries
 *  enough structure for `./outbox.ts` to classify retryable vs permanent. */
export class MetaApiError extends Error {
  readonly httpStatus: number
  readonly code?: number
  readonly errorSubcode?: number
  readonly metaType?: string
  readonly fbtraceId?: string

  constructor(
    message: string,
    opts: { httpStatus: number; code?: number; errorSubcode?: number; metaType?: string; fbtraceId?: string },
  ) {
    super(message)
    this.name = 'MetaApiError'
    this.httpStatus = opts.httpStatus
    this.code = opts.code
    this.errorSubcode = opts.errorSubcode
    this.metaType = opts.metaType
    this.fbtraceId = opts.fbtraceId
  }
}

async function throwMetaError(response: Response, fallback: string): Promise<never> {
  let envelope: MetaErrorEnvelope = {}
  try {
    envelope = (await response.json()) as MetaErrorEnvelope
  } catch {
    // response body wasn't JSON — keep the fallback message.
  }
  throw new MetaApiError(envelope.error?.message ?? fallback, {
    httpStatus: response.status,
    code: envelope.error?.code,
    errorSubcode: envelope.error?.error_subcode,
    metaType: envelope.error?.type,
    fbtraceId: envelope.error?.fbtrace_id,
  })
}

function authHeaders(accessToken: string): HeadersInit {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` }
}

// ============================================================
// Sending
// ============================================================

export interface SendTextMessageArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  text: string
  /** Meta's message id being replied to — renders as a reply/quote. */
  contextMessageId?: string
}

/** Send a free-form WhatsApp text message. Only works inside the 24h customer service window. */
export async function sendTextMessage(args: SendTextMessageArgs): Promise<MetaSendResult> {
  const { phoneNumberId, accessToken, to, text, contextMessageId } = args
  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body: text },
  }
  if (contextMessageId) body.context = { message_id: contextMessageId }

  const response = await fetch(`${META_API_BASE}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(body),
  })
  if (!response.ok) await throwMetaError(response, `Meta API error: ${response.status}`)
  const data = await response.json()
  return { messageId: data.messages[0].id }
}

export type MediaKind = 'image' | 'video' | 'document' | 'audio'

export interface SendMediaMessageArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  kind: MediaKind
  /** Public URL Meta fetches at send time. */
  link: string
  /** Caption — Meta caps at 1024 chars. image/video/document accept it; audio does NOT. */
  caption?: string
  /** Document-only file name. Ignored for image/video/audio. */
  filename?: string
  contextMessageId?: string
}

/**
 * Send an image, video, document, or audio (voice note) via a public URL.
 *
 * Audio is special-cased per Meta's spec: `caption` and `filename` are
 * BOTH rejected on audio (400) — only `{ link }` is sent. WhatsApp
 * auto-renders an OGG/Opus file as a playable voice note.
 */
export async function sendMediaMessage(args: SendMediaMessageArgs): Promise<MetaSendResult> {
  const { phoneNumberId, accessToken, to, kind, link, caption, filename, contextMessageId } = args
  if (!link) throw new Error('sendMediaMessage requires a link.')

  const media: Record<string, unknown> = { link }
  if (caption && kind !== 'audio') media.caption = caption
  if (kind === 'document' && filename) media.filename = filename

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: kind,
    [kind]: media,
  }
  if (contextMessageId) body.context = { message_id: contextMessageId }

  const response = await fetch(`${META_API_BASE}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(body),
  })
  if (!response.ok) await throwMetaError(response, `Meta API error: ${response.status}`)
  const data = await response.json()
  return { messageId: data.messages[0].id }
}

import { buildSendComponents, type MetaTemplateComponent, type SendTimeParams } from './template-send-builder'

export interface SendTemplateMessageArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  templateName: string
  language?: string
  /**
   * The template's `componentes` (from `whatsapp_templates.componentes`).
   * When provided, the full components array (header/body/buttons) is
   * built via `buildSendComponents` — required for media headers and
   * URL-with-variable buttons to actually reach the recipient.
   */
  componentes?: MetaTemplateComponent[]
  /** Per-send variable values — see `SendTimeParams`. */
  messageParams?: SendTimeParams
  /** Legacy/simple path: body-only variables, no template row available. */
  params?: string[]
  contextMessageId?: string
}

/**
 * Send a pre-approved WhatsApp message template. Required outside the 24h
 * customer service window and for any first-touch messaging.
 */
export async function sendTemplateMessage(args: SendTemplateMessageArgs): Promise<MetaSendResult> {
  const {
    phoneNumberId,
    accessToken,
    to,
    templateName,
    language = 'pt_BR',
    componentes,
    messageParams,
    params,
    contextMessageId,
  } = args

  const templatePayload: Record<string, unknown> = {
    name: templateName,
    language: { code: language },
  }

  if (componentes) {
    const components = buildSendComponents(componentes, {
      body: messageParams?.body ?? params,
      headerText: messageParams?.headerText,
      headerMediaUrl: messageParams?.headerMediaUrl,
      headerMediaId: messageParams?.headerMediaId,
      buttonParams: messageParams?.buttonParams,
    })
    if (components.length > 0) templatePayload.components = components
  } else if (params && params.length > 0) {
    // Legacy body-only path — no template row available.
    templatePayload.components = [
      { type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p) })) },
    ]
  }

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: templatePayload,
  }
  if (contextMessageId) body.context = { message_id: contextMessageId }

  const response = await fetch(`${META_API_BASE}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(body),
  })
  if (!response.ok) await throwMetaError(response, `Meta API error: ${response.status}`)
  const data = await response.json()
  return { messageId: data.messages[0].id }
}

// ============================================================
// Media download (relay)
// ============================================================

export interface GetMediaUrlArgs {
  mediaId: string
  accessToken: string
}

/** Resolve a media id to Meta's short-lived, authenticated CDN URL + MIME type. */
export async function getMediaUrl(args: GetMediaUrlArgs): Promise<{ url: string; mimeType: string }> {
  const { mediaId, accessToken } = args
  const response = await fetch(`${META_API_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) await throwMetaError(response, `Media fetch failed: ${response.status}`)
  const data = await response.json()
  if (!data.url) throw new Error('Media URL not found in Meta response')
  return { url: data.url, mimeType: data.mime_type || 'application/octet-stream' }
}

export interface DownloadMediaArgs {
  downloadUrl: string
  accessToken: string
}

/** Fetch the binary bytes for a media URL obtained from `getMediaUrl`. */
export async function downloadMedia(
  args: DownloadMediaArgs,
): Promise<{ buffer: Buffer; contentType: string }> {
  const { downloadUrl, accessToken } = args
  const response = await fetch(downloadUrl, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!response.ok) {
    throw new MetaApiError(`Media download failed: ${response.status}`, { httpStatus: response.status })
  }
  const contentType = response.headers.get('content-type') || 'application/octet-stream'
  const buffer = Buffer.from(await response.arrayBuffer())
  return { buffer, contentType }
}
