import { describe, expect, it } from 'vitest'
import { decryptToken, encryptToken } from './crypto'

// ENCRYPTION_KEY is set globally in vitest.config.ts (dummy 32-byte hex).

describe('whatsapp-oficial/crypto', () => {
  it('round-trips a plaintext token through encrypt/decrypt', () => {
    const plaintext = 'EAAG_fake_meta_access_token_1234567890'
    const cipherHex = encryptToken(plaintext)
    expect(cipherHex.startsWith('\\x')).toBe(true)
    expect(decryptToken(cipherHex)).toBe(plaintext)
  })

  it('produces a unique IV on every call (ciphertext differs for the same plaintext)', () => {
    const a = encryptToken('same-token')
    const b = encryptToken('same-token')
    expect(a).not.toBe(b)
    expect(decryptToken(a)).toBe('same-token')
    expect(decryptToken(b)).toBe('same-token')
  })

  it('accepts a raw Buffer as well as the \\x-prefixed hex string', () => {
    const cipherHex = encryptToken('buffer-path')
    const buf = Buffer.from(cipherHex.slice(2), 'hex')
    expect(decryptToken(buf)).toBe('buffer-path')
  })

  it('throws when the ciphertext has been tampered with (GCM auth tag mismatch)', () => {
    const cipherHex = encryptToken('tamper-me')
    // Flip the last byte of the ciphertext — must fail the auth tag check.
    const raw = cipherHex.slice(2)
    const tampered =
      '\\x' + raw.slice(0, -2) + (raw.slice(-2) === '00' ? '01' : '00')
    expect(() => decryptToken(tampered)).toThrow()
  })

  it('throws a clear error when ENCRYPTION_KEY is missing', () => {
    const original = process.env.ENCRYPTION_KEY
    delete process.env.ENCRYPTION_KEY
    try {
      expect(() => encryptToken('x')).toThrow(/ENCRYPTION_KEY/)
    } finally {
      process.env.ENCRYPTION_KEY = original
    }
  })
})
