import { describe, it, expect } from 'vitest'
import { isAllowlisted } from './allowlist'
import type { WhatsappFlags } from './env-flags'

function makeFlags(overrides: Partial<WhatsappFlags> = {}): WhatsappFlags {
  return {
    mode: 'shadow',
    metaSendEnabled: false,
    evolutionSendEnabled: false,
    broadcastEnabled: false,
    pilotMode: true,
    allowlist: ['5547990480036'],
    ...overrides,
  }
}

describe('isAllowlisted', () => {
  it('blocks a number outside the allowlist while pilot mode is on', () => {
    const flags = makeFlags()
    expect(isAllowlisted('5547999998888', flags)).toBe(false)
  })

  it('allows a number that is in the allowlist', () => {
    const flags = makeFlags()
    expect(isAllowlisted('5547990480036', flags)).toBe(true)
  })

  it('matches the same digit sequence regardless of separators', () => {
    const flags = makeFlags()
    expect(isAllowlisted('+55 47 99048-0036', flags)).toBe(true)
    expect(isAllowlisted('+55 (47) 99048-0036', flags)).toBe(true)
    expect(isAllowlisted(' 55.47.99048.0036 ', flags)).toBe(true)
  })

  it('does NOT match a different digit ordering of the same characters', () => {
    // '(47) 99048-0036 +55' normalizes to 4799048003655, a DIFFERENT number
    // than 5547990480036. An allowlist must never guess intent by reordering
    // digits — fuzzy matching here would let an unintended recipient through.
    const flags = makeFlags()
    expect(isAllowlisted('(47) 99048-0036 +55', flags)).toBe(false)
  })

  it('allows any number when pilot mode is off', () => {
    const flags = makeFlags({ pilotMode: false, allowlist: [] })
    expect(isAllowlisted('5547999998888', flags)).toBe(true)
  })

  it('blocks null/empty phone while pilot mode is on', () => {
    const flags = makeFlags()
    expect(isAllowlisted(null, flags)).toBe(false)
    expect(isAllowlisted(undefined, flags)).toBe(false)
    expect(isAllowlisted('', flags)).toBe(false)
  })
})
