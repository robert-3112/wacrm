import { describe, it, expect } from 'vitest'
import { isInsideFreeFormWindow, META_FREE_FORM_WINDOW_MS } from './meta-window'

describe('isInsideFreeFormWindow', () => {
  it('is true for an inbound 1 hour ago', () => {
    const now = new Date('2026-07-24T12:00:00.000Z')
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString()
    expect(isInsideFreeFormWindow(oneHourAgo, now)).toBe(true)
  })

  it('is false exactly at the 24h+1s boundary', () => {
    const now = new Date('2026-07-24T12:00:00.000Z')
    const justOver = new Date(now.getTime() - (META_FREE_FORM_WINDOW_MS + 1_000)).toISOString()
    expect(isInsideFreeFormWindow(justOver, now)).toBe(false)
  })

  it('is false for null/undefined (no inbound ever)', () => {
    const now = new Date('2026-07-24T12:00:00.000Z')
    expect(isInsideFreeFormWindow(null, now)).toBe(false)
    expect(isInsideFreeFormWindow(undefined, now)).toBe(false)
  })

  it('is false for an invalid timestamp string', () => {
    const now = new Date('2026-07-24T12:00:00.000Z')
    expect(isInsideFreeFormWindow('not-a-date', now)).toBe(false)
  })
})
