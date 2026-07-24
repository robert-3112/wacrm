import crypto from 'node:crypto'

/**
 * Verify the HMAC-SHA256 signature Meta attaches to webhook POSTs.
 *
 * REUSED near-1:1 from `src/lib/whatsapp/webhook-signature.ts` (WACRM
 * original — harvest matrix area 3, classified "Reutilizar": pure crypto
 * over raw bytes, no dependency on any table or account-scoping, so it
 * ports unchanged). Duplicated into this namespace (instead of imported)
 * so the `whatsapp-oficial` adapter has zero dependency on the legacy
 * `src/lib/whatsapp` tree, which belongs to the Evolution/community WACRM
 * routes untouched by this mission (ADR-WHATSAPP-OFFICIAL-WACRM D1/D6).
 *
 * Meta signs the raw request body with the app secret and sends the
 * result in the `x-hub-signature-256: sha256=<hex>` header. Without
 * verification, anyone who knows the webhook URL could POST fabricated
 * events and pollute `whatsapp_webhook_events`/`whatsapp_messages`.
 *
 * Reference:
 *   https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verify-payloads
 *
 * Contract (mission requirement, non-negotiable):
 *   `META_APP_SECRET` is REQUIRED. If it's missing we fail closed — every
 *   request is rejected until the operator configures the secret. Never
 *   "let it pass for now."
 */
export function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  const secret = process.env.META_APP_SECRET
  if (!secret) {
    console.error(
      '[whatsapp-oficial/webhook] META_APP_SECRET is not set — rejecting request ' +
        '(fail-closed by design). Configure the env var (Meta → App Settings → ' +
        'Basic → App Secret) to enable signature verification.',
    )
    return false
  }

  if (!signatureHeader) return false
  if (!signatureHeader.startsWith('sha256=')) return false

  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')

  const a = Buffer.from(signatureHeader)
  const b = Buffer.from(expected)
  // Bail if lengths differ — timingSafeEqual throws otherwise.
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
