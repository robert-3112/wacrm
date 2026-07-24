import crypto from 'node:crypto'

/**
 * Token encryption for the SUNT WhatsApp Hub (official Meta Cloud API channel).
 *
 * ADAPTED from `src/lib/whatsapp/encryption.ts` (the original WACRM module —
 * see `docs/WACRM-HARVEST-MATRIX.md` area 1, classified "Reutilizar"). Same
 * algorithm (AES-256-GCM, 12-byte IV, 16-byte auth tag) and the same
 * motivation (GCM over CBC: an attacker who can write rows to
 * `whatsapp_channels` — directly, via an RLS bug, or a tampered backup —
 * can't flip ciphertext bits silently; any tampering fails the decrypt).
 *
 * What's different from the WACRM original, and why:
 *   - The SUNT schema stores the encrypted token in
 *     `whatsapp_channels.access_token_cifrado`, a Postgres `bytea` column
 *     (see `supabase/migrations/20260723190000_whatsapp_oficial_foundation.sql`),
 *     not a `text` column holding a `iv:ciphertext:authTag` hex string like
 *     WACRM's `whatsapp_config.access_token`. PostgREST (and therefore
 *     supabase-js) represents `bytea` values as a hex string prefixed with
 *     `\x` (Postgres's `bytea_output = hex` textual format) on both read and
 *     write. `encryptToken`/`decryptToken` below produce/consume exactly
 *     that `\x`-prefixed hex string, with `iv (12 bytes) || authTag (16
 *     bytes) || ciphertext` packed as raw bytes (no colon separators
 *     needed — every field has a fixed or unambiguous length).
 *   - No legacy CBC read-path: SUNT's `whatsapp_*` schema is greenfield
 *     (Fase 3 confirmed zero production rows), so there is no old
 *     ciphertext to stay backward-compatible with. WACRM's CBC compat
 *     branch was explicitly classified "Não usar" for the SUNT port
 *     (harvest matrix area 1, item 2) for exactly this reason.
 *
 * `ENCRYPTION_KEY` is a 64-char hex string (32 bytes) — same contract as
 * the runbook (`docs/runbooks/META-CLOUD-SETUP-SUNT.md`), generated with
 * `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
 */

const GCM_IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY
  if (!hex) {
    throw new Error(
      'ENCRYPTION_KEY is not set — cannot encrypt/decrypt WhatsApp channel tokens.',
    )
  }
  const key = Buffer.from(hex, 'hex')
  if (key.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must decode to 32 bytes (got ${key.length}) — expected a 64-char hex string.`,
    )
  }
  return key
}

/**
 * Encrypt a plaintext token (e.g. a Meta access token) into the
 * `\x`-prefixed hex string Postgres `bytea` columns expect on insert.
 */
export function encryptToken(plaintext: string): string {
  const iv = crypto.randomBytes(GCM_IV_LENGTH)
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  const combined = Buffer.concat([iv, authTag, ciphertext])
  return `\\x${combined.toString('hex')}`
}

/**
 * Decrypt a `bytea` value read back from `whatsapp_channels.access_token_cifrado`.
 * Accepts either the `\x`-prefixed hex string PostgREST returns, or a raw
 * Buffer (in case a caller reads the column through a lower-level client).
 */
export function decryptToken(cipherValue: string | Buffer): string {
  const combined = Buffer.isBuffer(cipherValue)
    ? cipherValue
    : Buffer.from(cipherValue.startsWith('\\x') ? cipherValue.slice(2) : cipherValue, 'hex')

  if (combined.length < GCM_IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error(
      `Encrypted token is too short to contain an IV + auth tag (got ${combined.length} bytes).`,
    )
  }

  const iv = combined.subarray(0, GCM_IV_LENGTH)
  const authTag = combined.subarray(GCM_IV_LENGTH, GCM_IV_LENGTH + AUTH_TAG_LENGTH)
  const ciphertext = combined.subarray(GCM_IV_LENGTH + AUTH_TAG_LENGTH)

  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv)
  decipher.setAuthTag(authTag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf8')
}
