import type { WhatsAppMessage } from '@/types/whatsapp-oficial'
import type { ActionResult, SophiaPauseInfo } from './inbox-actions'

export function asyncMediaAvailability(): Promise<boolean> {
  return fetch('/api/whatsapp-oficial/messages/media')
    .then((response) => response.ok ? response.json() : null)
    .then((body) => body?.enabled === true)
    .catch(() => false)
}

export async function sendInboxMedia(
  conversationId: string,
  clientRequestId: string,
  file: File,
  caption: string,
): Promise<ActionResult<{ ok: true; message: WhatsAppMessage; replayed: boolean } & SophiaPauseInfo>> {
  const form = new FormData()
  form.set('file', file)
  form.set('caption', caption)
  try {
    const response = await fetch('/api/whatsapp-oficial/messages/media', {
      method: 'POST',
      headers: { 'x-conversation-id': conversationId, 'x-client-request-id': clientRequestId },
      body: form,
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || body?.ok !== true || !body.message) {
      return { ok: false, error: typeof body?.error === 'string' ? body.error : 'Falha ao enviar mídia.' }
    }
    return { ok: true, data: body }
  } catch {
    return { ok: false, error: 'Falha de rede — tente novamente sem alterar o anexo.' }
  }
}
