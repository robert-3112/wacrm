/**
 * Public, unauthenticated liveness probe for the WhatsApp Hub deployment
 * (Coolify health check / uptime monitors). Deliberately minimalist: the
 * response body is EXACTLY `{ ok, version, timestamp }`.
 *
 * Security requirement (explicit): this endpoint must NEVER leak outbound
 * mode, provider configuration, queue depth, dead-letter counts, or any
 * env var name/value — those live behind the cron-secret-gated
 * `/api/whatsapp-oficial/outbox/metrics` route instead. Keep this route
 * that way on every future edit.
 */

import { NextResponse } from 'next/server'

export async function GET(): Promise<NextResponse> {
  const version =
    process.env.NEXT_PUBLIC_APP_VERSION ?? process.env.SOURCE_COMMIT ?? 'dev'

  return NextResponse.json({
    ok: true,
    version,
    timestamp: new Date().toISOString(),
  })
}
