/**
 * `meta_cloud` outbound adapter — sends a claimed `whatsapp_outbox` job
 * through the official WhatsApp Cloud API.
 *
 * WRITTEN FROM SCRATCH for the outbox worker (Fase 7). This module is a
 * thin translation layer only: it maps an `OutboxJob` (+ an already
 * decrypted access token, supplied by the caller) onto the existing
 * `sendTextMessage` / `sendMediaMessage` / `sendTemplateMessage` helpers in
 * `../meta-api`. It never decrypts anything itself and never logs the
 * credential — the credential lives only as a local parameter passed
 * straight through to the Meta API client.
 */

import { sendMediaMessage, sendTemplateMessage, sendTextMessage, type MediaKind } from '../meta-api'
import type { MetaTemplateComponent, SendTimeParams } from '../template-send-builder'
import type { AdapterSendResult, OutboundAdapter, OutboxJob } from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.every((item) => typeof item === 'string') ? (value as string[]) : undefined
}

const MEDIA_KINDS: ReadonlySet<string> = new Set(['image', 'video', 'document', 'audio'])

function asMediaKind(value: unknown): MediaKind | undefined {
  return typeof value === 'string' && MEDIA_KINDS.has(value) ? (value as MediaKind) : undefined
}

function isTemplateJob(job: OutboxJob): boolean {
  return job.tipo === 'template' || asString(job.payload.template_name) !== undefined
}

async function send(args: { job: OutboxJob; credential: string }): Promise<AdapterSendResult> {
  const { job, credential } = args
  const to = asString(job.lead_whatsapp)
  if (!to) throw new Error('meta_cloud adapter: missing recipient phone number')

  const phoneNumberId = asString(job.phone_number_id)
  if (!phoneNumberId) throw new Error('meta_cloud adapter: missing phone_number_id')

  if (isTemplateJob(job)) {
    const templateName = asString(job.payload.template_name)
    if (!templateName) throw new Error('meta_cloud adapter: missing template_name in payload')

    const language = asString(job.payload.language)
    const componentes = Array.isArray(job.payload.componentes)
      ? (job.payload.componentes as MetaTemplateComponent[])
      : undefined
    const messageParams = isRecord(job.payload.messageParams)
      ? (job.payload.messageParams as SendTimeParams)
      : undefined
    const params = asStringArray(job.payload.params)

    const result = await sendTemplateMessage({
      phoneNumberId,
      accessToken: credential,
      to,
      templateName,
      language,
      componentes,
      messageParams,
      params,
    })
    return { providerMessageId: result.messageId }
  }

  const mediaUrl = asString(job.payload.media_url) ?? asString(job.payload.link)
  if (mediaUrl) {
    const kind = asMediaKind(job.payload.message_type)
    if (!kind) throw new Error('meta_cloud adapter: missing or invalid message_type for media payload')

    const result = await sendMediaMessage({
      phoneNumberId,
      accessToken: credential,
      to,
      kind,
      link: mediaUrl,
      caption: asString(job.payload.caption),
      filename: asString(job.payload.filename),
    })
    return { providerMessageId: result.messageId }
  }

  const content = asString(job.payload.content)
  if (!content) throw new Error('meta_cloud adapter: missing content in payload')

  const result = await sendTextMessage({
    phoneNumberId,
    accessToken: credential,
    to,
    text: content,
  })
  return { providerMessageId: result.messageId }
}

export const metaCloudAdapter: OutboundAdapter = {
  provider: 'meta_cloud',
  isConfigured(job: OutboxJob): boolean {
    return asString(job.phone_number_id) !== undefined
  },
  send,
}
