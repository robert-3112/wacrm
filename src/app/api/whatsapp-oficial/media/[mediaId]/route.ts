import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/whatsapp-oficial/supabase-admin'
import { decryptToken } from '@/lib/whatsapp-oficial/crypto'
import { downloadMedia, getMediaUrl } from '@/lib/whatsapp-oficial/meta-api'
import {
  WHATSAPP_OFICIAL_RATE_LIMITS,
  checkRateLimit,
  rateLimitResponse,
} from '@/lib/whatsapp-oficial/rate-limit'

/**
 * Media relay for the official channel. ADAPTED from
 * `src/app/api/whatsapp/media/[mediaId]/route.ts` (WACRM original —
 * harvest matrix area 2, classified "Adaptar": `getMediaUrl` +
 * `downloadMedia` port unchanged; auth/tenant resolution is rewritten for
 * the SUNT model).
 *
 * D10 (ADR-WHATSAPP-OFFICIAL-WACRM): the Meta access token is never sent
 * to the browser. Two Supabase clients are used deliberately:
 *   1. A user-scoped client (cookies + anon key) to look up the message —
 *      RLS on `whatsapp_messages` (gestão sees everything; a corretor only
 *      the leads they own) does the authorization check for us, for free.
 *      A `maybeSingle()` miss means "doesn't exist OR you can't see it" —
 *      same 404 either way, no information leak about other tenants'
 *      conversations.
 *   2. A service-role client to resolve the channel + decrypt its token —
 *      `whatsapp_channels` RLS restricts SELECT to gestão, and an
 *      individual corretor legitimately viewing their own conversation's
 *      media must still be able to trigger a Meta download.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> },
): Promise<Response> {
  const { mediaId } = await params
  if (!mediaId) {
    return NextResponse.json({ error: 'Media ID is required' }, { status: 400 })
  }

  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const rl = checkRateLimit(`whatsapp-oficial-media:${user.id}`, WHATSAPP_OFICIAL_RATE_LIMITS.mediaRelay)
  if (!rl.success) return rateLimitResponse(rl)

  const relayPath = `/api/whatsapp-oficial/media/${mediaId}`
  const { data: message, error: messageError } = await supabase
    .from('whatsapp_messages')
    .select('id, conversation_id')
    .eq('media_url', relayPath)
    .maybeSingle()

  if (messageError) {
    console.error('[whatsapp-oficial/media] failed to look up message:', messageError.message)
    return NextResponse.json({ error: 'Failed to fetch media' }, { status: 500 })
  }
  if (!message) {
    // Either the media doesn't exist, or RLS hid it — deliberately identical response.
    return NextResponse.json({ error: 'Media not found' }, { status: 404 })
  }

  const admin = supabaseAdmin()
  const { data: conversation, error: conversationError } = await admin
    .from('whatsapp_conversations')
    .select('canal_id')
    .eq('id', message.conversation_id as string)
    .maybeSingle()
  if (conversationError || !conversation) {
    console.error(
      '[whatsapp-oficial/media] failed to resolve conversation/channel:',
      conversationError?.message,
    )
    return NextResponse.json({ error: 'Failed to fetch media' }, { status: 500 })
  }

  const { data: channel, error: channelError } = await admin
    .from('whatsapp_channels')
    .select('access_token_cifrado')
    .eq('id', conversation.canal_id as string)
    .maybeSingle()
  if (channelError || !channel?.access_token_cifrado) {
    console.error('[whatsapp-oficial/media] channel or token missing:', channelError?.message)
    return NextResponse.json({ error: 'WhatsApp channel not configured' }, { status: 400 })
  }

  try {
    const accessToken = decryptToken(channel.access_token_cifrado as string)
    const mediaInfo = await getMediaUrl({ mediaId, accessToken })
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })
    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType || mediaInfo.mimeType || 'application/octet-stream',
        'Cache-Control': 'private, max-age=86400',
      },
    })
  } catch (error) {
    console.error('[whatsapp-oficial/media] failed to fetch media from Meta:', error)
    return NextResponse.json({ error: 'Failed to fetch media' }, { status: 502 })
  }
}
