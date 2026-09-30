import { describe, expect, it } from 'vitest'
import { errorDiagnostics } from './error-diagnostics'

describe('errorDiagnostics', () => {
  it.each(['23505', 'PGRST202', 'ECONNRESET', 'ERR_INVALID_URL'])('preserves diagnostic code %s', (code) => {
    expect(errorDiagnostics({ code, message: 'synthetic-secret', details: 'private-contact' }))
      .toEqual({ type: 'object', code })
  })

  it('preserves Meta numeric codes and status without messages or trace data', () => {
    const error = Object.assign(new Error('synthetic-token'), {
      name: 'MetaApiError', code: 100, errorSubcode: 33, httpStatus: 400, fbtraceId: 'private-trace',
    })
    expect(errorDiagnostics(error)).toEqual({ type: 'MetaApiError', code: 100, errorSubcode: 33, httpStatus: 400 })
  })

  it.each(['wa_live_synthetic_secret', 'https://user:secret@example.test', '23505\nsecret'])
    ('drops arbitrary code strings: %s', (code) => {
      expect(errorDiagnostics({ code })).toEqual({ type: 'object' })
    })

  it('drops arbitrary names, stack, cause and nonnumeric provider fields', () => {
    expect(errorDiagnostics(Object.assign(new Error('synthetic-secret'), {
      name: 'synthetic-secret', code: NaN, errorSubcode: -1, httpStatus: 'secret', cause: 'private-contact',
    }))).toEqual({ type: 'Error' })
  })

  it.each([null, undefined, 'synthetic-secret'])('never logs primitive payloads: %s', (value) => {
    expect(errorDiagnostics(value)).toEqual({ type: typeof value })
  })
})
