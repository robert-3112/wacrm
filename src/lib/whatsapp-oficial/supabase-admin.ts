import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Service-role Supabase client for the official-channel webhook handler
 * and (future) outbox worker. Lazily initialized — same pattern as the
 * WACRM original (`src/app/api/whatsapp/webhook/route.ts`'s
 * `supabaseAdmin()`) — so importing this module doesn't crash a build
 * that hasn't set the env vars yet (e.g. `next build` in CI without
 * secrets).
 *
 * Only ever used server-side. This bypasses RLS by design (`service_role`)
 * — every table this module touches (`whatsapp_webhook_events`,
 * `whatsapp_outbox`, `whatsapp_channels`) either has no client-facing
 * policy at all, or is written to exclusively through this path until
 * Fase 4-6 add `SECURITY INVOKER` RPCs (ADR D5/D10).
 */
let _client: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) {
      throw new Error(
        'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY must be set to use the ' +
          'whatsapp-oficial admin Supabase client.',
      )
    }
    _client = createClient(url, key)
  }
  return _client
}

/** Test-only escape hatch — lets test files reset the memoized singleton. */
export function __resetSupabaseAdminForTests(): void {
  _client = null
}
