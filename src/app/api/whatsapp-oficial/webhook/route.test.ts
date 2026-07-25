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
  return {
    code: '23505',
    message: 'duplicate key value violates unique constraint',
  }
}

function makeFakeDb() {
  const state = {
    channels: [] as Row[],
    webhookEvents: [] as Row[],
    leads: [] as Row[],
    conversations: [] as Row[],
    messages: [] as Row[],
    messageEvents: [] as Row[],
    templates: [] as Row[],
    /** Args de cada chamada a whatsapp_oficial_registrar_status_template. */
    templateRpcCalls: [] as Row[],
  }
  let seq = 0
  let failInboundRpcOnce = false
  let failTemplateRpcOnce = false
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
        return {
          data: arr.filter((r) => matchesFilters(r, filters)),
          error: null,
        }
      }
      return {
        data: arr.find((r) => matchesFilters(r, filters)) ?? null,
        error: null,
      }
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

  const LEAD_PHONE_RE = /^[0-9]{10,15}$/

  // Mirrors public.whatsapp_oficial_processar_inbound (Fase 5,
  // supabase/migrations/20260724130000_whatsapp_oficial_bridge_rpcs.sql):
  // find-or-create lead by (tenant_id, whatsapp), find-or-create conversation
  // by (tenant_id, canal_id, lead_id), insert message idempotently by
  // (tenant_id, wamid). The route now calls this RPC instead of doing the
  // four separate reads/writes itself — see route.ts for the wiring.
  function rpcProcessarInbound(args: Record<string, unknown>) {
    const tenantId = args.p_tenant_id as string
    const canalId = args.p_canal_id as string
    const phone = ((args.p_whatsapp as string) ?? '').trim()
    if (!LEAD_PHONE_RE.test(phone)) return { ok: false, reason: 'whatsapp_invalido' }
    if (!state.channels.some((c) => c.id === canalId && c.tenant_id === tenantId)) {
      return { ok: false, reason: 'canal_invalido' }
    }

    let lead = state.leads.find((l) => l.tenant_id === tenantId && l.whatsapp === phone)
    let leadCreated = false
    if (!lead) {
      lead = {
        id: nextId('lead'),
        tenant_id: tenantId,
        whatsapp: phone,
        status_saida: 'ativo',
      }
      state.leads.push(lead)
      leadCreated = true
    }

    let conversation: Row | undefined = state.conversations.find(
      (c) => c.tenant_id === tenantId && c.canal_id === canalId && c.lead_id === lead!.id,
    )
    let conversationCreated = false
    if (!conversation) {
      conversation = {
        id: nextId('conv'),
        tenant_id: tenantId,
        canal_id: canalId,
        lead_id: lead.id,
        nao_lidas_corretor: 0,
      }
      state.conversations.push(conversation)
      conversationCreated = true
    }

    let messageId: string | null = null
    let messageCreated = false
    const wamid = args.p_wamid as string | null
    const content = args.p_content as string | null
    const mediaUrl = args.p_media_url as string | null
    if (wamid || content || mediaUrl) {
      const dupe = wamid
        ? state.messages.find((m) => m.tenant_id === tenantId && m.wamid === wamid)
        : undefined
      if (!dupe) {
        const row = {
          id: nextId('msg'),
          tenant_id: tenantId,
          conversation_id: conversation.id,
          wamid,
          direction: 'inbound',
          message_type: args.p_message_type ?? 'text',
          content,
          media_url: mediaUrl,
          media_mime_type: args.p_media_mime_type ?? null,
          status: 'recebida',
          raw_payload: args.p_raw_payload ?? null,
          wpp_timestamp: args.p_wpp_timestamp ?? null,
        }
        state.messages.push(row)
        messageId = row.id
        messageCreated = true
        conversation.nao_lidas_corretor =
          ((conversation.nao_lidas_corretor as number | undefined) ?? 0) + 1
        conversation.ultima_mensagem_preview = content
          ? String(content).slice(0, 200)
          : `[${row.message_type}]`
      } else {
        messageId = dupe.id as string
      }
    }

    return {
      ok: true,
      lead_id: lead.id,
      conversation_id: conversation.id,
      message_id: messageId,
      lead_created: leadCreated,
      conversation_created: conversationCreated,
      message_created: messageCreated,
    }
  }

  // Mirrors public.whatsapp_oficial_registrar_status AFTER the terminal-falhou
  // fix (supabase/migrations/20260724150000_..._fix_terminal_falhou.sql):
  // falhou is terminal (nothing overwrites it once set), falhou itself is
  // only accepted before entregue/lida, otherwise only forward rank moves apply.
  function rpcRegistrarStatus(args: Record<string, unknown>) {
    const tenantId = args.p_tenant_id as string
    const wamid = args.p_wamid as string
    const novoStatus = args.p_novo_status as string
    const metaStatusId = args.p_meta_status_id as string | undefined

    const message = state.messages.find((m) => m.tenant_id === tenantId && m.wamid === wamid)
    if (!message) return { ok: false, reason: 'mensagem_nao_encontrada' }

    if (metaStatusId && state.messageEvents.some((e) => e.meta_status_id === metaStatusId)) {
      return { ok: true, already_processed: true, message_id: message.id }
    }

    const tipoMap: Record<string, string> = {
      enviada: 'sent',
      entregue: 'delivered',
      lida: 'read',
      falhou: 'failed',
    }
    state.messageEvents.push({
      id: nextId('mev'),
      tenant_id: tenantId,
      message_id: message.id,
      meta_status_id: metaStatusId ?? null,
      tipo: tipoMap[novoStatus] ?? novoStatus,
      detalhe: args.p_detalhe ?? {},
      ocorrido_em: args.p_ocorrido_em ?? null,
    })

    const currentStatus = message.status as string
    const entregueRank = STATUS_RANK.entregue
    let shouldAdvance: boolean
    if (currentStatus === 'falhou') {
      shouldAdvance = false
    } else if (novoStatus === 'falhou') {
      shouldAdvance = (STATUS_RANK[currentStatus] ?? 0) < entregueRank
    } else {
      shouldAdvance = (STATUS_RANK[novoStatus] ?? 0) > (STATUS_RANK[currentStatus] ?? 0)
    }

    if (shouldAdvance) {
      message.status = novoStatus
      const detalhe = (args.p_detalhe ?? {}) as Record<string, unknown>
      if (novoStatus === 'falhou') {
        if (detalhe.code) message.erro_code = detalhe.code
        if (detalhe.message) message.erro_detalhe = detalhe.message
      }
    }

    return {
      ok: true,
      message_id: message.id,
      status_aplicado: shouldAdvance,
      status_atual: shouldAdvance ? novoStatus : currentStatus,
    }
  }

  // Mirrors public.whatsapp_oficial_registrar_status_template
  // (supabase/migrations/20260725120000_whatsapp_templates_sync.sql): casa por
  // (tenant, canal, nome[, idioma]), aplica coalesce em status/score/motivo e
  // NÃO cria linha — template desconhecido volta ok=true, atualizado=false,
  // porque o webhook não carrega os componentes.
  const META_STATUS_TO_SUNT: Record<string, string> = {
    APPROVED: 'aprovado',
    REJECTED: 'rejeitado',
    PAUSED: 'pausado',
    DISABLED: 'desabilitado',
    IN_APPEAL: 'em_apelacao',
    PENDING_DELETION: 'exclusao_pendente',
    DRAFT: 'rascunho',
    PENDING: 'pendente',
    PENDING_REVIEW: 'pendente',
  }

  function rpcRegistrarStatusTemplate(args: Record<string, unknown>) {
    state.templateRpcCalls.push({ ...args })

    const tenantId = ((args.p_tenant_id as string) ?? '').trim()
    const canalId = args.p_canal_id as string | null
    const nome = ((args.p_nome as string) ?? '').trim()
    if (!tenantId || !canalId || !nome) return { ok: false, reason: 'parametros_invalidos' }

    const idioma = ((args.p_idioma as string | null) ?? '').trim() || null
    const rawStatus = ((args.p_status as string | null) ?? '').trim()
    const status = rawStatus ? (META_STATUS_TO_SUNT[rawStatus.toUpperCase()] ?? 'pendente') : null
    const quality = ((args.p_quality_score as string | null) ?? '').trim().toUpperCase() || null
    const motivo = ((args.p_motivo as string | null) ?? '').trim() || null

    const row = state.templates.find(
      (t) =>
        t.tenant_id === tenantId &&
        t.canal_id === canalId &&
        t.nome === nome &&
        (idioma === null || t.idioma === idioma),
    )
    if (!row) return { ok: true, atualizado: false, reason: 'template_desconhecido' }

    row.status_aprovacao = status ?? row.status_aprovacao
    row.quality_score = quality ?? row.quality_score
    row.motivo_rejeicao = status === 'aprovado' ? null : (motivo ?? row.motivo_rejeicao)
    return { ok: true, atualizado: true, template_id: row.id }
  }

  return {
    state,
    failNextInboundRpc: () => {
      failInboundRpcOnce = true
    },
    failNextTemplateRpc: () => {
      failTemplateRpcOnce = true
    },
    from: (table: string) => builder(table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'whatsapp_status_rank') {
        return { data: STATUS_RANK[args.p_status as string] ?? 0, error: null }
      }
      if (fn === 'whatsapp_oficial_processar_inbound') {
        if (failInboundRpcOnce) {
          failInboundRpcOnce = false
          return { data: null, error: { message: 'transient database error' } }
        }
        return { data: rpcProcessarInbound(args), error: null }
      }
      if (fn === 'whatsapp_oficial_registrar_status') {
        return { data: rpcRegistrarStatus(args), error: null }
      }
      if (fn === 'whatsapp_oficial_registrar_status_template') {
        if (failTemplateRpcOnce) {
          failTemplateRpcOnce = false
          state.templateRpcCalls.push({ ...args })
          return { data: null, error: { message: 'transient template rpc error' } }
        }
        return { data: rpcRegistrarStatusTemplate(args), error: null }
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

const CHANNEL = {
  id: 'chan-1',
  tenant_id: 'sunt',
  status: 'ativo',
  phone_number_id: 'PNID-1',
  // Eventos de template não trazem phone_number_id — o canal é achado pelo
  // WABA id que vem em `entry.id`.
  waba_id: 'WABA-1',
}
const LEAD = { id: 'lead-1', tenant_id: 'sunt', whatsapp: '5511988887777' }
const TEMPLATE = {
  id: 'tpl-1',
  tenant_id: 'sunt',
  canal_id: CHANNEL.id,
  nome: 'boas_vindas',
  idioma: 'pt_BR',
  status_aprovacao: 'pendente',
  quality_score: null,
  motivo_rejeicao: null,
}

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
              metadata: {
                display_phone_number: '+1',
                phone_number_id: CHANNEL.phone_number_id,
              },
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

function metaStatusPayload(status: { id: string; status: string; timestamp?: string }) {
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
              metadata: {
                display_phone_number: '+1',
                phone_number_id: CHANNEL.phone_number_id,
              },
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

/**
 * Evento de lifecycle de template. `value` NÃO tem metadata/phone_number_id —
 * é outra forma de payload, e `entry.id` é o WABA id.
 *
 * `omitTime` reproduz as entregas em que a Meta não manda `entry.time`
 * (JSON.stringify some com a chave undefined) — o caso em que a chave de dedup
 * deixa de ser estável.
 */
function metaTemplatePayload(
  field: string,
  value: Record<string, unknown>,
  opts: { wabaId?: string; time?: number; omitTime?: boolean } = {},
) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: opts.wabaId ?? CHANNEL.waba_id,
        time: opts.omitTime ? undefined : (opts.time ?? 1700000900),
        changes: [{ field, value }],
      },
    ],
  })
}

function postWebhook(body: string, signature: string | null = sign(body)) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
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
  fakeDb.state.templates.push({ ...TEMPLATE })
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

  it('reprocesses an event persisted before a transient RPC failure', async () => {
    const body = metaTextPayload({ wamid: 'wamid.RETRY1' })
    fakeDb.failNextInboundRpc()

    const first = await postWebhook(body)
    expect(first.status).toBe(503)
    expect(fakeDb.state.messages).toHaveLength(0)
    expect(fakeDb.state.webhookEvents).toHaveLength(1)
    expect(fakeDb.state.webhookEvents[0].processed_at).toBeNull()
    expect(fakeDb.state.webhookEvents[0].processing_error).toBe('transient database error')

    const second = await postWebhook(body)
    expect(second.status).toBe(200)
    expect(fakeDb.state.messages).toHaveLength(1)
    expect(fakeDb.state.webhookEvents).toHaveLength(1)
    expect(fakeDb.state.webhookEvents[0].processed_at).not.toBeNull()
    expect(fakeDb.state.webhookEvents[0].processing_error).toBeNull()
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

    const body = metaStatusPayload({
      id: 'wamid.OUT1',
      status: 'delivered',
      timestamp: '1700000200',
    })
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

    await postWebhook(
      metaStatusPayload({
        id: 'wamid.FWD1',
        status: 'delivered',
        timestamp: '1700000300',
      }),
    )
    expect(fakeDb.state.messages.find((m) => m.id === 'msg-seed')?.status).toBe('entregue')

    await postWebhook(
      metaStatusPayload({
        id: 'wamid.FWD1',
        status: 'read',
        timestamp: '1700000400',
      }),
    )
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

    await postWebhook(
      metaStatusPayload({
        id: 'wamid.FAIL1',
        status: 'failed',
        timestamp: '1700000500',
      }),
    )
    expect(fakeDb.state.messages.find((m) => m.id === 'msg-seed')?.status).toBe('entregue')
  })

  it('falhou is terminal: a late delivered/read event never reverts it (regression — see migration 20260724150000)', async () => {
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
      wamid: 'wamid.TERM1',
      status: 'falhou',
    })

    await postWebhook(
      metaStatusPayload({
        id: 'wamid.TERM1',
        status: 'delivered',
        timestamp: '1700000600',
      }),
    )
    expect(fakeDb.state.messages.find((m) => m.id === 'msg-seed')?.status).toBe('falhou')

    await postWebhook(
      metaStatusPayload({
        id: 'wamid.TERM1',
        status: 'read',
        timestamp: '1700000700',
      }),
    )
    expect(fakeDb.state.messages.find((m) => m.id === 'msg-seed')?.status).toBe('falhou')
  })
})

describe('POST /api/whatsapp-oficial/webhook — template lifecycle', () => {
  it('status update chama a RPC com nome/idioma/status/motivo e aplica no template', async () => {
    const res = await postWebhook(
      metaTemplatePayload('message_template_status_update', {
        event: 'REJECTED',
        message_template_id: 123456,
        message_template_name: 'boas_vindas',
        message_template_language: 'pt_BR',
        reason: 'INVALID_FORMAT',
      }),
    )

    expect(res.status).toBe(200)
    expect(fakeDb.state.templateRpcCalls).toHaveLength(1)
    expect(fakeDb.state.templateRpcCalls[0]).toMatchObject({
      p_tenant_id: 'sunt',
      p_canal_id: CHANNEL.id,
      p_nome: 'boas_vindas',
      p_idioma: 'pt_BR',
      p_status: 'REJECTED',
      p_motivo: 'INVALID_FORMAT',
      p_quality_score: null,
    })

    expect(fakeDb.state.templates[0]).toMatchObject({
      status_aprovacao: 'rejeitado',
      motivo_rejeicao: 'INVALID_FORMAT',
    })

    // O evento cru fica registrado com o event_type que o CHECK da tabela aceita.
    expect(fakeDb.state.webhookEvents).toHaveLength(1)
    expect(fakeDb.state.webhookEvents[0]).toMatchObject({
      event_type: 'template_status',
      canal_id: CHANNEL.id,
    })
    expect(fakeDb.state.webhookEvents[0].processed_at).not.toBeNull()
    expect(fakeDb.state.webhookEvents[0].processing_error).toBeNull()
  })

  it('quality update passa p_status null — o score muda, o status é preservado', async () => {
    fakeDb.state.templates[0].status_aprovacao = 'aprovado'

    const res = await postWebhook(
      metaTemplatePayload('message_template_quality_update', {
        message_template_id: 123456,
        message_template_name: 'boas_vindas',
        message_template_language: 'pt_BR',
        previous_quality_score: 'GREEN',
        new_quality_score: 'YELLOW',
      }),
    )

    expect(res.status).toBe(200)
    expect(fakeDb.state.templateRpcCalls[0]).toMatchObject({
      p_status: null,
      p_quality_score: 'YELLOW',
    })
    // p_status null faz a RPC coalescer para o status atual — quality não pode
    // rebaixar um template aprovado.
    expect(fakeDb.state.templates[0]).toMatchObject({
      status_aprovacao: 'aprovado',
      quality_score: 'YELLOW',
    })
  })

  it('template ainda não sincronizado (atualizado=false) devolve 200 e só registra o motivo', async () => {
    const res = await postWebhook(
      metaTemplatePayload('message_template_status_update', {
        event: 'APPROVED',
        message_template_name: 'template_que_nunca_sincronizou',
        message_template_language: 'pt_BR',
      }),
    )

    expect(res.status).toBe(200)
    expect(fakeDb.state.webhookEvents[0].processed_at).not.toBeNull()
    expect(fakeDb.state.webhookEvents[0].processing_error).toBe('template_desconhecido')
    // não inventou linha: o webhook não carrega componentes
    expect(fakeDb.state.templates).toHaveLength(1)
  })

  it('components_update é registrado sem chamar a RPC (a Meta não manda os componentes)', async () => {
    const res = await postWebhook(
      metaTemplatePayload('message_template_components_update', {
        message_template_id: 123456,
        message_template_name: 'boas_vindas',
        message_template_language: 'pt_BR',
      }),
    )

    expect(res.status).toBe(200)
    expect(fakeDb.state.templateRpcCalls).toHaveLength(0)
    expect(fakeDb.state.webhookEvents[0].processing_error).toContain('sync de templates')
    expect(fakeDb.state.templates[0].status_aprovacao).toBe('pendente')
  })

  it('falha na RPC de template não impede a mensagem inbound do mesmo lote — e ainda devolve 503', async () => {
    // Duas exigências que brigam: a mensagem inbound é dado do cliente e não se
    // recupera sozinha (o lote precisa continuar depois do erro), mas responder
    // 200 PERDERIA a transição de template de vez — a Meta só reentrega em
    // resposta non-2xx e ninguém varre whatsapp_webhook_events com
    // processed_at IS NULL. Logo: processa tudo, responde 503 no fim.
    fakeDb.failNextTemplateRpc()

    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: CHANNEL.waba_id,
          time: 1700000900,
          changes: [
            {
              field: 'message_template_status_update',
              value: {
                event: 'APPROVED',
                message_template_name: 'boas_vindas',
                message_template_language: 'pt_BR',
              },
            },
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '+1',
                  phone_number_id: CHANNEL.phone_number_id,
                },
                contacts: [{ profile: { name: 'Maria' }, wa_id: LEAD.whatsapp }],
                messages: [
                  {
                    id: 'wamid.MIX1',
                    from: LEAD.whatsapp,
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'ola' },
                  },
                ],
              },
            },
          ],
        },
      ],
    })

    const res = await postWebhook(body)

    // 503 = "Meta, reenvia" — a única coisa que realmente retoma o evento.
    expect(res.status).toBe(503)
    // ...e mesmo assim o lote inteiro rodou: a mensagem inbound está gravada.
    expect(fakeDb.state.messages).toHaveLength(1)
    expect(fakeDb.state.messages[0].wamid).toBe('wamid.MIX1')

    // o evento de template ficou com processing_error e processed_at null,
    // então a redelivery da Meta o retoma (e o dedup insert-first faz a
    // mensagem inbound já processada ser pulada na volta)
    const templateEvent = fakeDb.state.webhookEvents.find(
      (e) => e.event_type === 'template_status',
    )
    expect(templateEvent?.processing_error).toBe('transient template rpc error')
    expect(templateEvent?.processed_at).toBeNull()
    // o template continuou intocado
    expect(fakeDb.state.templates[0].status_aprovacao).toBe('pendente')

    // a redelivery reaplica só o que faltava
    const retry = await postWebhook(body)
    expect(retry.status).toBe(200)
    expect(fakeDb.state.messages).toHaveLength(1)
    expect(fakeDb.state.templates[0].status_aprovacao).toBe('aprovado')
  })

  it('template desconhecido não é falha transitória: o lote inteiro responde 200', async () => {
    // { ok: true, atualizado: false } é informação, não erro — reentregar não
    // mudaria nada, então esse caso NÃO pode escorregar para o 503.
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: CHANNEL.waba_id,
          time: 1700000900,
          changes: [
            {
              field: 'message_template_status_update',
              value: {
                event: 'APPROVED',
                message_template_name: 'template_que_nunca_sincronizou',
                message_template_language: 'pt_BR',
              },
            },
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '+1',
                  phone_number_id: CHANNEL.phone_number_id,
                },
                contacts: [{ profile: { name: 'Maria' }, wa_id: LEAD.whatsapp }],
                messages: [
                  {
                    id: 'wamid.MIX2',
                    from: LEAD.whatsapp,
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'ola' },
                  },
                ],
              },
            },
          ],
        },
      ],
    })

    const res = await postWebhook(body)

    expect(res.status).toBe(200)
    expect(fakeDb.state.messages).toHaveLength(1)
    const templateEvent = fakeDb.state.webhookEvents.find(
      (e) => e.event_type === 'template_status',
    )
    expect(templateEvent?.processed_at).not.toBeNull()
    expect(templateEvent?.processing_error).toBe('template_desconhecido')
  })

  it('status update sem message_template_language é registrado e ignorado (não exercita o curinga da RPC)', async () => {
    // `p_idioma` null casa com TODAS as variantes de idioma na RPC
    // (`v_idioma is null or t.idioma = v_idioma`). Um APPROVED sem idioma
    // promoveria junto o en_US que a Meta rejeitou, e ele passaria a satisfazer
    // o gate `status_aprovacao <> 'aprovado'` de enfileirar_template.
    fakeDb.state.templates.push({
      ...TEMPLATE,
      id: 'tpl-en',
      idioma: 'en_US',
      status_aprovacao: 'rejeitado',
      motivo_rejeicao: 'INVALID_FORMAT',
    })

    const res = await postWebhook(
      metaTemplatePayload('message_template_status_update', {
        event: 'APPROVED',
        message_template_id: 123456,
        message_template_name: 'boas_vindas',
      }),
    )

    expect(res.status).toBe(200)
    expect(fakeDb.state.templateRpcCalls).toHaveLength(0)
    // nenhuma das duas variantes se mexeu
    expect(fakeDb.state.templates.map((t) => t.status_aprovacao)).toEqual([
      'pendente',
      'rejeitado',
    ])
    // mas o evento cru ficou registrado, com o motivo do descarte
    expect(fakeDb.state.webhookEvents).toHaveLength(1)
    expect(fakeDb.state.webhookEvents[0].processed_at).not.toBeNull()
    expect(fakeDb.state.webhookEvents[0].processing_error).toContain(
      'message_template_language',
    )
  })

  it('duas transições iguais sem entry.time não colapsam em replay', async () => {
    // Sem `entry.time` a chave (nome:idioma:field:status) se repete em toda
    // transição para o MESMO status. PAUSED → APPROVED → PAUSED: a terceira
    // colidiria com a primeira e seria descartada, deixando o template
    // 'aprovado' no SUNT enquanto está pausado na Meta.
    const pausado = metaTemplatePayload(
      'message_template_status_update',
      {
        event: 'PAUSED',
        message_template_name: 'boas_vindas',
        message_template_language: 'pt_BR',
      },
      { omitTime: true },
    )
    const aprovado = metaTemplatePayload(
      'message_template_status_update',
      {
        event: 'APPROVED',
        message_template_name: 'boas_vindas',
        message_template_language: 'pt_BR',
      },
      { omitTime: true },
    )

    await postWebhook(pausado)
    await postWebhook(aprovado)
    await postWebhook(pausado)

    expect(fakeDb.state.templateRpcCalls).toHaveLength(3)
    expect(fakeDb.state.templateRpcCalls.filter((c) => c.p_status === 'PAUSED')).toHaveLength(2)
    expect(fakeDb.state.webhookEvents).toHaveLength(3)
    // o que importa: o último estado real da Meta venceu
    expect(fakeDb.state.templates[0].status_aprovacao).toBe('pausado')
  })

  it('com entry.time, a redelivery literal continua sendo descartada', async () => {
    // A chave não-colidente vale SÓ para o caso sem `entry.time` — quando a
    // Meta manda o instante da entrega, dedup continua valendo.
    const body = metaTemplatePayload(
      'message_template_status_update',
      {
        event: 'PAUSED',
        message_template_name: 'boas_vindas',
        message_template_language: 'pt_BR',
      },
      { time: 1700001234 },
    )

    await postWebhook(body)
    await postWebhook(body)

    expect(fakeDb.state.webhookEvents).toHaveLength(1)
    expect(fakeDb.state.templateRpcCalls).toHaveLength(1)
  })

  it('não reprocessa uma redelivery do mesmo evento de template', async () => {
    const body = metaTemplatePayload('message_template_status_update', {
      event: 'APPROVED',
      message_template_name: 'boas_vindas',
      message_template_language: 'pt_BR',
    })

    await postWebhook(body)
    await postWebhook(body)

    expect(fakeDb.state.webhookEvents).toHaveLength(1)
    expect(fakeDb.state.templateRpcCalls).toHaveLength(1)
  })

  it('WABA id desconhecido é logado e ignorado, ainda com 200 (nada para registrar sem canal)', async () => {
    const res = await postWebhook(
      metaTemplatePayload(
        'message_template_status_update',
        {
          event: 'APPROVED',
          message_template_name: 'boas_vindas',
          message_template_language: 'pt_BR',
        },
        { wabaId: 'WABA-DE-OUTRA-CONTA' },
      ),
    )

    expect(res.status).toBe(200)
    expect(fakeDb.state.webhookEvents).toHaveLength(0)
    expect(fakeDb.state.templateRpcCalls).toHaveLength(0)
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
