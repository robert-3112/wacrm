import { describe, expect, it } from 'vitest'
import { API_MESSAGE_SELECT, serializeMessage } from './serialize'

describe('provider message timestamp', () => {
  it('selects and preserves provider time even when the database received a delayed message', () => {
    const message = {
      id: 'message-1', created_at: '2026-09-21T19:00:00Z',
      wpp_timestamp: '2026-09-20T19:00:00Z',
    }
    expect(API_MESSAGE_SELECT.split(',').map(field => field.trim())).toContain('wpp_timestamp')
    expect(serializeMessage(message)).toMatchObject(message)
  })

  it('does not replace a missing provider timestamp with database insertion time', () => {
    expect(serializeMessage({ id: 'message-1', created_at: '2026-09-21T19:00:00Z' }))
      .toMatchObject({ wpp_timestamp: null })
  })
})
