import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

const SECRET = process.env.META_APP_SECRET!

function sign(body: string, secret: string = SECRET): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
}

// ---------------------------------------------------------------------------
// In-memory fake of the tables this route touches. Mimics just enough of
// the Supabase query-builder surface (select/eq/insert/update/maybeSingle/
// single/then) plus `.rpc('whatsapp_status_rank', ...)` for the route to run
// unmodified against it. See docs/WHATSAPP-OFFICIAL-ARCHITECTURE.md for the
// real schema this mirrors.
// ---------------------------------------------------------------------------

const STATUS_RANK: Record<string, number> = {
  pendente: 0,
  enviada: 1,
  entregue: 2,
  lida: 3,
  recebida: 3,
  falhou: -1,
}

type Row = Record<string, unknown>

function matchesFilters(row: Row, filters: Row): boolean {
  return Object.entries(filters).every(([k, v]) => row[k] === v)
}

function uniqueViolation() {
  return { code: '23505', message: 'duplicate key value violates unique constraint' }
}

function makeFakeDb() {
  const state = {
    channels: [] as Row[],
    webhookEvents: [] as Row[],
    leads: [] as Row[],
    conversations: [] as Row[],
    messages: [] as Row[],
    messageEvents: [] as Row[],
  }
  let seq = 0
  const nextId = (prefix: string) => `${prefix}-${++seq}`

  function tableArray(table: string): Row[] {
    switch (table) {
      case 'whatsapp_channels':
        return state.channels
      case 'whatsapp_webhook_events':
        return state.webhookEvents
      case 'leads':
        return state.leads
      case 'whatsapp_conversations':
        return state.conversations
      case 'whatsapp_messages':
        return state.messages
      case 'whatsapp_message_events':
        return state.messageEvents
      default:
        return []
    }
  }

  function builder(table: string) {
    const filters: Row = {}
    let insertPayload: Row | null = null
    let updatePayload: Row | null = null

    function doInsert(): { data: unknown; error: unknown } {
      const arr = tableArray(table)
      const payload = insertPayload as Row

      if (table === 'whatsapp_webhook_events') {
        const dupe = arr.find((r) =>
          matchesFilters(r, {
            canal_id: payload.canal_id,
            event_type: payload.event_type,
            external_id: payload.external_id,
          }),
        )
        if (dupe) return { data: null, error: uniqueViolation() }
        arr.push({ ...payload, processed_at: null, processing_error: null })
        return { data: null, error: null }
      }

      if (table === 'whatsapp_conversations') {
        const dupe = arr.find((r) =>
          matchesFilters(r, {
            tenant_id: payload.tenant_id,
            canal_id: payload.canal_id,
            lead_id: payload.lead_id,
          }),
        )
        if (dupe) return { data: null, error: uniqueViolation() }
        const row = { id: nextId('conv'), nao_lidas_corretor: 0, ...payload }
        arr.push(row)
        return { data: row, error: null }
      }

      if (table === 'whatsapp_messages') {
        if (
          payload.wamid &&
          arr.some((r) => r.tenant_id === payload.tenant_id && r.wamid === payload.wamid)
        ) {
          return { data: null, error: uniqueViolation() }
        }
        const row = { id: nextId('msg'), ...payload }
        arr.push(row)
        return { data: row, error: null }
      }

      if (table === 'whatsapp_message_events') {
        const row = { id: nextId('mev'), ...payload }
        arr.push(row)
        return { data: row, error: null }
      }

      arr.push(payload)
      return { data: payload, error: null }
    }

    function doUpdate(): { data: unknown; error: unknown } {
      const arr = tableArray(table)
      const row = arr.find((r) => matchesFilters(r, filters))
      if (row) Object.assign(row, updatePayload)
      return { data: row ?? null, error: null }
    }

    function doSelect(): { data: unknown; error: unknown } {
      const arr = tableArray(table)
      if (table === 'whatsapp_channels') {
        return { data: arr.filter((r) => matchesFilters(r, filters)), error: null }
      }
      return { data: arr.find((r) => matchesFilters(r, filters)) ?? null, error: null }
    }

    function terminal(): { data: unknown; error: unknown } {
      if (insertPayload) return doInsert()
      if (updatePayload) return doUpdate()
      return doSelect()
    }

    const b: Record<string, unknown> = {
      select: () => b,
      eq: (col: string, val: unknown) => {
        filters[col] = val
        return b
      },
      insert: (payload: Row) => {
        insertPayload = payload
        return b
      },
      update: (payload: Row) => {
        updatePayload = payload
        return b
      },
      maybeSingle: () => Promise.resolve(terminal()),
      single: () => Promise.resolve(terminal()),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(terminal()).then(resolve, reject),
    }
    return b
  }

  return {
    state,
    from: (table: string) => builder(table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'whatsapp_status_rank') {
        return { data: STATUS_RANK[args.p_status as string] ?? 0, error: null }
      }
      return { data: null, error: null }
    },
  }
}

// vi.mock is hoisted above these declarations, but the factory closure only
// reads `fakeDb` when `supabaseAdmin()` is actually CALLED (inside the route
// handler, at request time) — by then `fakeDb` has been assigned below.
// Same pattern already used by src/app/api/whatsapp/send/route.test.ts.
let fakeDb = makeFakeDb()

vi.mock('@/lib/whatsapp-oficial/supabase-admin', () => ({
  supabaseAdmin: () => fakeDb,
}))

import { GET, POST } from './route'

const CHANNEL = { id: 'chan-1', tenant_id: 'sunt', status: 'ativo', phone_number_id: 'PNID-1' }
const LEAD = { id: 'lead-1', tenant_id: 'sunt', whatsapp: '5511988887777' }

function metaTextPayload(overrides: { wamid?: string; from?: string; body?: string } = {}) {
  const wamid = overrides.wamid ?? 'wamid.MSG1'
  const from = overrides.from ?? LEAD.whatsapp
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+1', phone_number_id: CHANNEL.phone_number_id },
              contacts: [{ profile: { name: 'Maria' }, wa_id: from }],
              messages: [
                {
                  id: wamid,
                  from,
                  timestamp: '1700000000',
                  type: 'text',
                  text: { body: overrides.body ?? 'ola' },
                },
              ],
            },
          },
        ],
      },
    ],
  })
}

function metaStatusPayload(status: {
  id: string
  status: string
  timestamp?: string
}) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+1', phone_number_id: CHANNEL.phone_number_id },
              statuses: [
                {
                  id: status.id,
                  status: status.status,
                  timestamp: status.timestamp ?? '1700000100',
                  recipient_id: LEAD.whatsapp,
                },
              ],
            },
          },
        ],
      },
    ],
  })
}

function postWebhook(body: string, signature: string | null = sign(body)) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (signature) headers['x-hub-signature-256'] = signature
  return POST(
    new Request('http://localhost/api/whatsapp-oficial/webhook', {
      method: 'POST',
      headers,
      body,
    }),
  )
}

beforeEach(() => {
  fakeDb = makeFakeDb()
  fakeDb.state.channels.push({ ...CHANNEL })
  fakeDb.state.leads.push({ ...LEAD })
  __resetRateLimitForTests()
})

describe('POST /api/whatsapp-oficial/webhook — signature verification', () => {
  it('accepts a validly signed request and processes it (200)', async () => {
    const body = metaTextPayload()
    const res = await postWebhook(body)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'received' })
    expect(fakeDb.state.messages).toHaveLength(1)
  })

  it('rejects an invalid signature with 401 and does not process the payload', async () => {
    const body = metaTextPayload()
    const res = await postWebhook(body, sign(body, 'wrong-secret'))
    expect(res.status).toBe(401)
    expect(fakeDb.state.messages).toHaveLength(0)
    expect(fakeDb.state.webhookEvents).toHaveLength(0)
  })

  it('fails closed (401) when META_APP_SECRET is not configured, even with a well-formed header', async () => {
    const original = process.env.META_APP_SECRET
    delete process.env.META_APP_SECRET
    try {
      const body = metaTextPayload()
      const res = await postWebhook(body, sign(body, original!))
      expect(res.status).toBe(401)
      expect(fakeDb.state.messages).toHaveLength(0)
    } finally {
      process.env.META_APP_SECRET = original
    }
  })
})

describe('POST /api/whatsapp-oficial/webhook — idempotency (ADR D7)', () => {
  it('does not duplicate the webhook event or the message on a replayed delivery', async () => {
    const body = metaTextPayload({ wamid: 'wamid.DUPE1' })

    const first = await postWebhook(body)
    expect(first.status).toBe(200)
    expect(fakeDb.state.messages).toHaveLength(1)
    expect(fakeDb.state.webhookEvents).toHaveLength(1)

    // Meta re-delivers the exact same payload (ack was slow / 5xx / network blip).
    const second = await postWebhook(body)
    expect(second.status).toBe(200)
    expect(fakeDb.state.messages).toHaveLength(1)
    expect(fakeDb.state.webhookEvents).toHaveLength(1)
  })

  it('creates only one whatsapp_conversations row across two different inbound messages from the same lead', async () => {
    await postWebhook(metaTextPayload({ wamid: 'wamid.A' }))
    await postWebhook(metaTextPayload({ wamid: 'wamid.B', body: 'segunda mensagem' }))
    expect(fakeDb.state.conversations).toHaveLength(1)
    expect(fakeDb.state.messages).toHaveLength(2)
    expect(fakeDb.state.conversations[0].nao_lidas_corretor).toBe(2)
  })
})

describe('POST /api/whatsapp-oficial/webhook — status transitions never regress (ADR D7)', () => {
  it('does not revert lida back to entregue when a late "delivered" event arrives', async () => {
    fakeDb.state.conversations.push({
      id: 'conv-seed',
      tenant_id: 'sunt',
      canal_id: CHANNEL.id,
      lead_id: LEAD.id,
      nao_lidas_corretor: 0,
    })
    fakeDb.state.messages.push({
      id: 'msg-seed',
      tenant_id: 'sunt',
      conversation_id: 'conv-seed',
      wamid: 'wamid.OUT1',
      status: 'lida',
    })

    const body = metaStatusPayload({ id: 'wamid.OUT1', status: 'delivered', timestamp: '1700000200' })
    const res = await postWebhook(body)
    expect(res.status).toBe(200)

    const message = fakeDb.state.messages.find((m) => m.id === 'msg-seed')
    expect(message?.status).toBe('lida')
    // The raw event and the append-only trail are still recorded even
    // though the current status wasn't overwritten.
    expect(fakeDb.state.webhookEvents).toHaveLength(1)
    expect(fakeDb.state.messageEvents).toHaveLength(1)
    expect(fakeDb.state.messageEvents[0].tipo).toBe('delivered')
  })

  it('advances pendente -> enviada -> entregue -> lida through separate events', async () => {
    fakeDb.state.conversations.push({
      id: 'conv-seed',
      tenant_id: 'sunt',
      canal_id: CHANNEL.id,
      lead_id: LEAD.id,
      nao_lidas_corretor: 0,
    })
    fakeDb.state.messages.push({
      id: 'msg-seed',
      tenant_id: 'sunt',
      conversation_id: 'conv-seed',
      wamid: 'wamid.FWD1',
      status: 'enviada',
    })

    await postWebhook(metaStatusPayload({ id: 'wamid.FWD1', status: 'delivered', timestamp: '1700000300' }))
    expect(fakeDb.state.messages.find((m) => m.id === 'msg-seed')?.status).toBe('entregue')

    await postWebhook(metaStatusPayload({ id: 'wamid.FWD1', status: 'read', timestamp: '1700000400' }))
    expect(fakeDb.state.messages.find((m) => m.id === 'msg-seed')?.status).toBe('lida')
  })

  it('does not mark falhou once the message is already entregue (late/spoofed failure)', async () => {
    fakeDb.state.conversations.push({
      id: 'conv-seed',
      tenant_id: 'sunt',
      canal_id: CHANNEL.id,
      lead_id: LEAD.id,
      nao_lidas_corretor: 0,
    })
    fakeDb.state.messages.push({
      id: 'msg-seed',
      tenant_id: 'sunt',
      conversation_id: 'conv-seed',
      wamid: 'wamid.FAIL1',
      status: 'entregue',
    })

    await postWebhook(metaStatusPayload({ id: 'wamid.FAIL1', status: 'failed', timestamp: '1700000500' }))
    expect(fakeDb.state.messages.find((m) => m.id === 'msg-seed')?.status).toBe('entregue')
  })
})

describe('GET /api/whatsapp-oficial/webhook — hub.challenge verification', () => {
  afterEach(() => {
    delete process.env.META_WEBHOOK_VERIFY_TOKEN
  })

  it('returns the challenge when the verify token matches', async () => {
    process.env.META_WEBHOOK_VERIFY_TOKEN = 'right-token'
    const res = await GET(
      new Request(
        'http://localhost/api/whatsapp-oficial/webhook?hub.mode=subscribe&hub.challenge=12345&hub.verify_token=right-token',
      ),
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('12345')
  })

  it('returns 403 when the verify token does not match', async () => {
    process.env.META_WEBHOOK_VERIFY_TOKEN = 'right-token'
    const res = await GET(
      new Request(
        'http://localhost/api/whatsapp-oficial/webhook?hub.mode=subscribe&hub.challenge=12345&hub.verify_token=wrong-token',
      ),
    )
    expect(res.status).toBe(403)
  })

  it('fails closed (403) when META_WEBHOOK_VERIFY_TOKEN is not configured', async () => {
    delete process.env.META_WEBHOOK_VERIFY_TOKEN
    const res = await GET(
      new Request(
        'http://localhost/api/whatsapp-oficial/webhook?hub.mode=subscribe&hub.challenge=12345&hub.verify_token=anything',
      ),
    )
    expect(res.status).toBe(403)
  })
})
