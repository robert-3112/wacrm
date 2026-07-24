import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifyMetaWebhookSignature } from './webhook-signature'

const SECRET = process.env.META_APP_SECRET!

function signedHeader(body: string, secret: string = SECRET): string {
  const hex = crypto.createHmac('sha256', secret).update(body).digest('hex')
  return `sha256=${hex}`
}

describe('whatsapp-oficial/verifyMetaWebhookSignature', () => {
  it('accepts a request signed with the correct secret', () => {
    const body = JSON.stringify({ object: 'whatsapp_business_account' })
    expect(verifyMetaWebhookSignature(body, signedHeader(body))).toBe(true)
  })

  it('rejects a signature computed with a different secret', () => {
    const body = '{}'
    expect(verifyMetaWebhookSignature(body, signedHeader(body, 'wrong-secret'))).toBe(
      false,
    )
  })

  it('rejects when the body was tampered with after signing', () => {
    const original = '{"entry":[]}'
    const header = signedHeader(original)
    const tampered = '{"entry":[{"id":"injected"}]}'
    expect(verifyMetaWebhookSignature(tampered, header)).toBe(false)
  })

  it('rejects a missing header', () => {
    expect(verifyMetaWebhookSignature('anything', null)).toBe(false)
  })

  it('rejects a header without the sha256= prefix', () => {
    const body = '{}'
    const hex = crypto.createHmac('sha256', SECRET).update(body).digest('hex')
    expect(verifyMetaWebhookSignature(body, hex)).toBe(false)
    expect(verifyMetaWebhookSignature(body, `sha512=${hex}`)).toBe(false)
  })

  it('rejects a header of the wrong length without throwing', () => {
    expect(verifyMetaWebhookSignature('{}', 'sha256=tooshort')).toBe(false)
  })

  describe('fails closed when META_APP_SECRET is missing', () => {
    const originalSecret = process.env.META_APP_SECRET
    beforeEach(() => {
      delete process.env.META_APP_SECRET
    })
    afterEach(() => {
      process.env.META_APP_SECRET = originalSecret
    })

    it('rejects even a correctly-formed signature when no secret is configured', () => {
      const body = '{}'
      const header = signedHeader(body, originalSecret!)
      expect(verifyMetaWebhookSignature(body, header)).toBe(false)
    })
  })
})
