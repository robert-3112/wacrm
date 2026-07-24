import { describe, expect, it } from 'vitest'
import {
  applyOutboxFailure,
  classifyMetaError,
  computeNextRetryAt,
} from './outbox'

describe('classifyMetaError', () => {
  it('classifies a known permanent Meta code (invalid parameter) as permanent', () => {
    expect(classifyMetaError({ code: 100 })).toMatchObject({ errorClass: 'permanent' })
  })

  it('classifies template-related permanent codes as permanent', () => {
    expect(classifyMetaError({ code: 132000 })).toMatchObject({ errorClass: 'permanent' })
    expect(classifyMetaError({ code: 131026 })).toMatchObject({ errorClass: 'permanent' })
  })

  it('classifies a known retryable Meta code (rate limit) as retryable', () => {
    expect(classifyMetaError({ code: 130429 })).toMatchObject({ errorClass: 'retryable' })
    expect(classifyMetaError({ code: 80007 })).toMatchObject({ errorClass: 'retryable' })
  })

  it('falls back to HTTP status when code is unrecognized', () => {
    expect(classifyMetaError({ httpStatus: 429, code: 999999 })).toMatchObject({
      errorClass: 'retryable',
    })
    expect(classifyMetaError({ httpStatus: 500 })).toMatchObject({ errorClass: 'retryable' })
    expect(classifyMetaError({ httpStatus: 503 })).toMatchObject({ errorClass: 'retryable' })
    expect(classifyMetaError({ httpStatus: 400 })).toMatchObject({ errorClass: 'permanent' })
    expect(classifyMetaError({ httpStatus: 404 })).toMatchObject({ errorClass: 'permanent' })
  })

  it('defaults unknown-shape errors (e.g. network failure) to retryable', () => {
    expect(classifyMetaError({ message: 'fetch failed' })).toMatchObject({
      errorClass: 'retryable',
      reason: 'unknown_error_default_retryable',
    })
  })
})

describe('computeNextRetryAt', () => {
  it('grows the backoff window as attempts increase', () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const delay0 = computeNextRetryAt(0, now).getTime() - now.getTime()
    const delay5 = computeNextRetryAt(5, now).getTime() - now.getTime()
    // With jitter, compare the theoretical minimum bounds instead of exact values.
    expect(delay0).toBeGreaterThanOrEqual(30_000 * 0.5)
    expect(delay0).toBeLessThanOrEqual(30_000)
    expect(delay5).toBeGreaterThan(delay0)
  })

  it('caps backoff so it never exceeds the ceiling', () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const delay = computeNextRetryAt(50, now).getTime() - now.getTime()
    expect(delay).toBeLessThanOrEqual(6 * 60 * 60 * 1000)
  })
})

function makeSupabaseMock() {
  const updateCalls: Array<{ table: string; values: Record<string, unknown>; id: string }> = []
  const supabase = {
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => ({
        eq: async (_column: string, id: string) => {
          updateCalls.push({ table, values, id })
          return { error: null }
        },
      }),
    }),
  }
  return { supabase, updateCalls }
}

describe('applyOutboxFailure', () => {
  it('schedules a retry (status=falhou, next_retry_at set) for a retryable error under budget', async () => {
    const { supabase, updateCalls } = makeSupabaseMock()
    const result = await applyOutboxFailure(
      supabase,
      { id: 'ob-1', attempts: 0, max_attempts: 5 },
      { httpStatus: 500, message: 'server error' },
    )
    expect(result).toEqual({ errorClass: 'retryable', deadLettered: false })
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].values).toMatchObject({ status: 'falhou', attempts: 1 })
    expect(updateCalls[0].values.next_retry_at).toBeDefined()
    expect(updateCalls[0].values.dead_letter_at).toBeUndefined()
  })

  it('dead-letters immediately on a permanent error, even on the first attempt', async () => {
    const { supabase, updateCalls } = makeSupabaseMock()
    const result = await applyOutboxFailure(
      supabase,
      { id: 'ob-2', attempts: 0, max_attempts: 5 },
      { code: 131026, message: 'undeliverable' },
    )
    expect(result).toEqual({ errorClass: 'permanent', deadLettered: true })
    expect(updateCalls[0].values).toMatchObject({ status: 'morto', attempts: 1 })
    expect(updateCalls[0].values.dead_letter_at).toBeDefined()
  })

  it('dead-letters a retryable error once the attempt budget is exhausted', async () => {
    const { supabase, updateCalls } = makeSupabaseMock()
    const result = await applyOutboxFailure(
      supabase,
      { id: 'ob-3', attempts: 4, max_attempts: 5 },
      { httpStatus: 503, message: 'unavailable' },
    )
    expect(result).toEqual({ errorClass: 'retryable', deadLettered: true })
    expect(updateCalls[0].values).toMatchObject({ status: 'morto', attempts: 5 })
  })

  it('propagates a Supabase update error instead of swallowing it', async () => {
    const supabase = {
      from: () => ({
        update: () => ({
          eq: async () => ({ error: new Error('db down') }),
        }),
      }),
    }
    await expect(
      applyOutboxFailure(supabase, { id: 'ob-4', attempts: 0, max_attempts: 5 }, {
        httpStatus: 500,
      }),
    ).rejects.toThrow('db down')
  })
})
