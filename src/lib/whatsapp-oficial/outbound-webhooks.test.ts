/**
 * Testes do módulo de outbound webhooks.
 *
 * A ordem abaixo é por estrago se quebrar, não por ordem do arquivo:
 *  1. O SEGREDO NUNCA SAI. Ele não pode aparecer no corpo, em header que não
 *     seja o digest, em log, nem em mensagem de erro. É o único defeito daqui
 *     que não tem conserto depois: segredo que vazou está vazado.
 *  2. Simetria e rigidez da assinatura — `verifyOutboundSignature` tem que
 *     aceitar exatamente o que `signOutboundPayload` produziu e RECUSAR corpo
 *     alterado, timestamp alterado e assinatura de outro segredo. Se qualquer
 *     dessas passar, a assinatura vira enfeite.
 *  3. Uma entrega que falha não pode derrubar as outras do lote — senão o
 *     endpoint mais quebrado segura a fila inteira atrás dele.
 *  4. Timeout e teto de leitura: um destino que não responde (ou que responde
 *     para sempre) não pode segurar o worker.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  WEBHOOK_EVENTOS,
  WebhookSecretMissingError,
  buildOutboundEnvelope,
  deliverWebhook,
  isWebhookEvento,
  loadWebhookSecret,
  processWebhookDeliveryBatch,
  signOutboundPayload,
  verifyOutboundSignature,
} from './outbound-webhooks'
import { encryptToken } from './crypto'

const SEGREDO = 'segredo-super-secreto-do-n8n-1234567890abcdef'
const OUTRO_SEGREDO = 'outro-segredo-completamente-diferente-abcdef'
const AGORA = new Date('2026-07-26T12:00:00.000Z')
const URL_DESTINO = 'https://n8n.exemplo.com/webhook/sunt'

const WEBHOOK_ID = '11111111-1111-4111-8111-111111111111'
const OUTRO_WEBHOOK_ID = '22222222-2222-4222-8222-222222222222'
const DELIVERY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DELIVERY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const DELIVERY_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

// ------------------------------------------------------------------ helpers

function okResponse(body = '{"ok":true}', status = 200): Response {
  return new Response(body, { status })
}

/** Guarda tudo que o fetch recebeu, para o teste inspecionar headers e corpo. */
function makeFetchSpy(responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const chamadas: Array<{ url: string; init: RequestInit }> = []
  const impl = vi.fn(async (input: unknown, init?: unknown) => {
    const url = String(input)
    const opts = (init ?? {}) as RequestInit
    chamadas.push({ url, init: opts })
    return responder(url, opts)
  })
  return { impl: impl as unknown as typeof fetch, chamadas }
}

function headerValue(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.[name]
}

// ------------------------------------------------------------- 1. o segredo

describe('o segredo nunca escapa', () => {
  const logs: string[] = []

  beforeEach(() => {
    logs.length = 0
    for (const nivel of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, nivel).mockImplementation((...args: unknown[]) => {
        logs.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
      })
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('não aparece no corpo, nos headers (além do digest), no log nem no retorno', async () => {
    const { impl, chamadas } = makeFetchSpy(() => okResponse())

    const r = await deliverWebhook({
      url: URL_DESTINO,
      secret: SEGREDO,
      evento: 'mensagem.recebida',
      payload: { lead_id: 'abc' },
      deliveryId: DELIVERY_A,
      now: AGORA,
      fetchImpl: impl,
    })

    expect(r.ok).toBe(true)
    const { init } = chamadas[0]

    // corpo
    expect(String(init.body)).not.toContain(SEGREDO)
    // headers: nenhum valor pode conter o segredo, nem o próprio digest
    const headers = init.headers as Record<string, string>
    for (const [nome, valor] of Object.entries(headers)) {
      expect(valor, `header ${nome} vazou o segredo`).not.toContain(SEGREDO)
    }
    // retorno da função
    expect(JSON.stringify(r)).not.toContain(SEGREDO)
    // logs
    expect(logs.join('\n')).not.toContain(SEGREDO)
    // e o digest realmente está lá
    expect(headers[SIGNATURE_HEADER]).toMatch(/^sha256=[0-9a-f]{64}$/)
  })

  it('não vaza nem quando o destino ecoa o header de assinatura no corpo do erro', async () => {
    // Destino mal-educado devolvendo o segredo dentro da resposta de erro.
    const { impl } = makeFetchSpy(() =>
      okResponse(`erro: chave ${SEGREDO} recusada`, 401),
    )

    const r = await deliverWebhook({
      url: URL_DESTINO,
      secret: SEGREDO,
      evento: 'mensagem.recebida',
      payload: {},
      now: AGORA,
      fetchImpl: impl,
    })

    expect(r.ok).toBe(false)
    expect(r.httpStatus).toBe(401)
    expect(r.erro).not.toContain(SEGREDO)
    expect(r.erro).toContain('[redigido]')
  })

  it('não vaza quando o erro de rede carrega o segredo na mensagem', async () => {
    const impl = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED (auth=${SEGREDO})`)
    }) as unknown as typeof fetch

    const r = await deliverWebhook({
      url: URL_DESTINO,
      secret: SEGREDO,
      evento: 'mensagem.recebida',
      payload: {},
      now: AGORA,
      fetchImpl: impl,
    })

    expect(r.ok).toBe(false)
    expect(r.erro).not.toContain(SEGREDO)
    expect(r.erro).toContain('erro_de_rede')
    expect(logs.join('\n')).not.toContain(SEGREDO)
  })
})

// ------------------------------------------------------------ 2. assinatura

describe('assinatura HMAC', () => {
  const body = JSON.stringify({ evento: 'mensagem.recebida', dados: { lead_id: 'abc' } })
  const ts = Math.floor(AGORA.getTime() / 1000)

  it('verify aceita exatamente o que sign produziu', () => {
    const assinatura = signOutboundPayload(SEGREDO, ts, body)
    expect(
      verifyOutboundSignature({
        secret: SEGREDO,
        body,
        timestamp: ts,
        signature: assinatura,
        now: AGORA,
      }),
    ).toBe(true)
  })

  it('recusa corpo alterado', () => {
    const assinatura = signOutboundPayload(SEGREDO, ts, body)
    expect(
      verifyOutboundSignature({
        secret: SEGREDO,
        body: body.replace('abc', 'xyz'),
        timestamp: ts,
        signature: assinatura,
        now: AGORA,
      }),
    ).toBe(false)
  })

  it('recusa timestamp alterado — é o que impede replay', () => {
    const assinatura = signOutboundPayload(SEGREDO, ts, body)
    expect(
      verifyOutboundSignature({
        secret: SEGREDO,
        body,
        timestamp: ts + 1,
        signature: assinatura,
        // tolerância desligada para provar que a recusa vem do HMAC, e não do frescor
        toleranceSeconds: 0,
        now: AGORA,
      }),
    ).toBe(false)
  })

  it('recusa assinatura feita com outro segredo', () => {
    const assinatura = signOutboundPayload(OUTRO_SEGREDO, ts, body)
    expect(
      verifyOutboundSignature({
        secret: SEGREDO,
        body,
        timestamp: ts,
        signature: assinatura,
        now: AGORA,
      }),
    ).toBe(false)
  })

  it('recusa entrega velha demais e aceita quando a tolerância é desligada', () => {
    const velho = ts - 3600
    const assinatura = signOutboundPayload(SEGREDO, velho, body)
    const comum = { secret: SEGREDO, body, timestamp: velho, signature: assinatura, now: AGORA }
    expect(verifyOutboundSignature(comum)).toBe(false)
    expect(verifyOutboundSignature({ ...comum, toleranceSeconds: 0 })).toBe(true)
  })

  it('é fail-closed em entrada torta (sem lançar por tamanho diferente)', () => {
    const assinatura = signOutboundPayload(SEGREDO, ts, body)
    const base = { secret: SEGREDO, body, timestamp: ts, now: AGORA }
    expect(verifyOutboundSignature({ ...base, signature: null })).toBe(false)
    expect(verifyOutboundSignature({ ...base, signature: '' })).toBe(false)
    expect(verifyOutboundSignature({ ...base, signature: 'sha1=abc' })).toBe(false)
    // tamanho diferente faria timingSafeEqual LANÇAR se não fosse checado antes
    expect(verifyOutboundSignature({ ...base, signature: 'sha256=abc' })).toBe(false)
    expect(verifyOutboundSignature({ ...base, signature: assinatura, secret: '' })).toBe(false)
    expect(verifyOutboundSignature({ ...base, signature: assinatura, timestamp: 'ontem' })).toBe(false)
    expect(verifyOutboundSignature({ ...base, signature: assinatura, timestamp: null })).toBe(false)
    expect(verifyOutboundSignature({ ...base, signature: assinatura, timestamp: 1.5 })).toBe(false)
  })

  it('a assinatura enviada por deliverWebhook fecha com o corpo enviado', async () => {
    const { impl, chamadas } = makeFetchSpy(() => okResponse())
    await deliverWebhook({
      url: URL_DESTINO,
      secret: SEGREDO,
      evento: 'conversa.optout',
      payload: { conversation_id: 'c1' },
      deliveryId: DELIVERY_A,
      now: AGORA,
      fetchImpl: impl,
    })

    const { init } = chamadas[0]
    const corpo = String(init.body)
    expect(
      verifyOutboundSignature({
        secret: SEGREDO,
        body: corpo,
        timestamp: headerValue(init, TIMESTAMP_HEADER),
        signature: headerValue(init, SIGNATURE_HEADER),
        now: AGORA,
      }),
    ).toBe(true)

    expect(headerValue(init, EVENT_HEADER)).toBe('conversa.optout')
    expect(headerValue(init, DELIVERY_HEADER)).toBe(DELIVERY_A)
    expect(JSON.parse(corpo)).toEqual(
      buildOutboundEnvelope({
        evento: 'conversa.optout',
        payload: { conversation_id: 'c1' },
        deliveryId: DELIVERY_A,
        now: AGORA,
      }),
    )
  })

  it('o vocabulário de eventos é fechado e não inclui ping', () => {
    expect(isWebhookEvento('mensagem.recebida')).toBe(true)
    expect(isWebhookEvento('ping')).toBe(false)
    expect(isWebhookEvento('mensagem_recebida')).toBe(false)
    expect(isWebhookEvento('*')).toBe(false)
    expect(WEBHOOK_EVENTOS).not.toContain('ping')
  })
})

// ---------------------------------------------------------- 3. uma tentativa

describe('deliverWebhook', () => {
  it('classifica timeout sem lançar', async () => {
    const impl = vi.fn(async () => {
      const err = new Error('The operation was aborted due to timeout')
      err.name = 'TimeoutError'
      throw err
    }) as unknown as typeof fetch

    const r = await deliverWebhook({
      url: URL_DESTINO,
      secret: SEGREDO,
      evento: 'mensagem.recebida',
      payload: {},
      timeoutMs: 1234,
      fetchImpl: impl,
    })
    expect(r).toEqual({ ok: false, httpStatus: null, erro: 'timeout_1234ms' })
  })

  it('não lê a resposta inteira quando o destino despeja um corpo gigante', async () => {
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls > 500) {
          controller.close()
          return
        }
        controller.enqueue(new TextEncoder().encode('x'.repeat(1024)))
      },
    })
    const { impl } = makeFetchSpy(() => new Response(stream, { status: 500 }))

    const r = await deliverWebhook({
      url: URL_DESTINO,
      secret: SEGREDO,
      evento: 'mensagem.recebida',
      payload: {},
      maxResponseBytes: 2048,
      fetchImpl: impl,
    })

    expect(r.ok).toBe(false)
    expect(r.httpStatus).toBe(500)
    // o trecho no erro é truncado, e o loop parou logo depois do teto
    expect((r.erro ?? '').length).toBeLessThanOrEqual(240)
    expect(pulls).toBeLessThan(10)
  })

  it('achata quebra de linha e caractere de controle vindos do destino', async () => {
    const { impl } = makeFetchSpy(() => okResponse('linha1\n\n\tlinha2 fim', 422))
    const r = await deliverWebhook({
      url: URL_DESTINO,
      secret: SEGREDO,
      evento: 'mensagem.recebida',
      payload: {},
      fetchImpl: impl,
    })
    expect(r.erro).toBe('http_422: linha1 linha2 fim')
  })

  /**
   * Surrogate solto é a falha mais cara deste módulo porque ela NÃO se manifesta
   * aqui: a string sai daqui aparentemente normal, o Postgres recusa a escrita lá
   * na frente, `registrarResultado` lança, o catch genérico devolve a entrega para
   * 'processando' sem contar tentativa, e o MESMO POST se repete no destino a cada
   * expiração de lease, para sempre. Por isso o teste não olha "ficou bonito":
   * olha a única propriedade que importa, a string sobreviver a um round-trip UTF-8.
   */
  describe('o trecho do erro é sempre texto que o Postgres aceita', () => {
    /**
     * SOLTO, não "qualquer surrogate": um emoji é feito de DOIS surrogates e é
     * perfeitamente válido. O defeito é a metade órfã — alta sem baixa depois,
     * ou baixa sem alta antes.
     */
    const SURROGATE_SOLTO = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

    /** Round-trip por UTF-8: surrogate solto vira U+FFFD e a igualdade quebra. */
    function ehUtf8Valido(s: string): boolean {
      return Buffer.from(s, 'utf8').toString('utf8') === s
    }

    async function erroDe(corpo: string, status = 500): Promise<string> {
      const { impl } = makeFetchSpy(() => okResponse(corpo, status))
      const r = await deliverWebhook({
        url: URL_DESTINO,
        secret: SEGREDO,
        evento: 'mensagem.recebida',
        payload: {},
        fetchImpl: impl,
      })
      return r.erro ?? ''
    }

    it('emoji do destino caindo na borda exata do corte não vira meio caractere', async () => {
      // 199 caracteres + emoji: com corte por unidade UTF-16, `slice(0, 200)` fica
      // com a metade ALTA do par e joga a baixa fora.
      const erro = await erroDe('x'.repeat(199) + '😀' + 'y'.repeat(50))

      expect(erro).not.toMatch(SURROGATE_SOLTO)
      expect(ehUtf8Valido(erro)).toBe(true)
      // JSON.stringify escapa surrogate solto como \udXXX — é literalmente o que o
      // supabase-js manda para o banco quando a string está quebrada.
      expect(JSON.stringify(erro)).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i)
      // e o emoji não foi picado: ou entra inteiro, ou não entra
      expect(erro).toContain('😀')
    })

    it('a borda do corte no meio de um par em QUALQUER posição continua válida', async () => {
      // Varre as posições em volta do limite (o par pode começar em 198, 199, 200…):
      // uma implementação que só acerte um deslocamento específico cai aqui.
      for (let enchimento = 190; enchimento <= 205; enchimento += 1) {
        const erro = await erroDe('x'.repeat(enchimento) + '😀🙂👍' + 'z'.repeat(80))
        expect(erro, `enchimento ${enchimento}`).not.toMatch(SURROGATE_SOLTO)
        expect(ehUtf8Valido(erro), `enchimento ${enchimento}`).toBe(true)
      }
    })

    it('também no caminho de erro de rede, que tem outro prefixo e outro limite', async () => {
      // 'erro_de_rede: ' tem 14 caracteres; com 185 de enchimento o par começa em 199.
      const impl = vi.fn(async () => {
        throw new Error('x'.repeat(185) + '😀' + 'y'.repeat(40))
      }) as unknown as typeof fetch

      const r = await deliverWebhook({
        url: URL_DESTINO,
        secret: SEGREDO,
        evento: 'mensagem.recebida',
        payload: {},
        fetchImpl: impl,
      })

      expect(r.erro).not.toMatch(SURROGATE_SOLTO)
      expect(ehUtf8Valido(r.erro ?? '')).toBe(true)
    })

    it('NUL não passa — o Postgres também recusa esse byte em coluna text', async () => {
      const NUL = String.fromCharCode(0)
      const erro = await erroDe(['inicio', 'meio', 'fim'].join(NUL))
      expect(erro).not.toContain(NUL)
      expect(erro).toBe('http_500: inicio meio fim')
    })
  })
})

// ------------------------------------------------------------- 4. o segredo no banco

describe('loadWebhookSecret', () => {
  function adminComSegredo(valor: unknown, erro: unknown = null) {
    return {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({
              data: valor === undefined ? null : { segredo_cifrado: valor },
              error: erro,
            })),
          })),
        })),
      })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
  }

  it('decifra o que o Hub cifrou', async () => {
    const admin = adminComSegredo(encryptToken(SEGREDO))
    await expect(loadWebhookSecret(admin, WEBHOOK_ID)).resolves.toBe(SEGREDO)
  })

  it('coluna vazia e ciphertext ilegível são a MESMA condição permanente', async () => {
    await expect(loadWebhookSecret(adminComSegredo(null), WEBHOOK_ID)).rejects.toBeInstanceOf(
      WebhookSecretMissingError,
    )
    await expect(loadWebhookSecret(adminComSegredo(undefined), WEBHOOK_ID)).rejects.toBeInstanceOf(
      WebhookSecretMissingError,
    )
    await expect(
      loadWebhookSecret(adminComSegredo('\\xdeadbeef'), WEBHOOK_ID),
    ).rejects.toBeInstanceOf(WebhookSecretMissingError)
  })

  it('falha de LEITURA é transitória, não "sem segredo"', async () => {
    const admin = adminComSegredo(null, { message: 'connection reset' })
    const err = await loadWebhookSecret(admin, WEBHOOK_ID).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(WebhookSecretMissingError)
  })

  it('o erro de decifragem não carrega o ciphertext', async () => {
    const err = await loadWebhookSecret(adminComSegredo('\\xdeadbeef'), WEBHOOK_ID).catch((e) => e)
    expect(String((err as Error).message)).not.toContain('deadbeef')
  })
})

// ----------------------------------------------------------------- 5. o lote

interface FakeAdminOpts {
  jobs: Array<Record<string, unknown>>
  segredoPorWebhook?: Record<string, unknown>
  /** Sobrescreve a resposta da RPC de registro (pode lançar, como o banco faria). */
  aoRegistrar?: (args: Record<string, unknown>) => { data: unknown; error: unknown }
}

function makeAdmin({ jobs, segredoPorWebhook = {}, aoRegistrar }: FakeAdminOpts) {
  const resultados: Array<Record<string, unknown>> = []
  const leiturasDeSegredo: string[] = []

  const rpc = vi.fn(async (nome: string, args: Record<string, unknown>) => {
    if (nome === 'whatsapp_oficial_webhook_claim') {
      return { data: { ok: true, claimed: jobs }, error: null }
    }
    if (nome === 'whatsapp_oficial_webhook_registrar_resultado') {
      resultados.push(args)
      if (aoRegistrar) return aoRegistrar(args)
      return {
        data: { ok: true, status: args.p_ok === true ? 'entregue' : 'falhou' },
        error: null,
      }
    }
    throw new Error(`rpc inesperada: ${nome}`)
  })

  const from = vi.fn(() => ({
    select: vi.fn(() => ({
      eq: vi.fn((_coluna: string, valor: string) => ({
        maybeSingle: vi.fn(async () => {
          leiturasDeSegredo.push(valor)
          const bruto = segredoPorWebhook[valor]
          return { data: bruto === undefined ? null : { segredo_cifrado: bruto }, error: null }
        }),
      })),
    })),
  }))

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { admin: { rpc, from } as any, rpc, resultados, leiturasDeSegredo }
}

function job(deliveryId: string, webhookId = WEBHOOK_ID, url = URL_DESTINO) {
  return {
    delivery_id: deliveryId,
    tenant_id: 'sunt',
    webhook_id: webhookId,
    evento: 'mensagem.recebida',
    payload: { lead_id: 'abc' },
    attempts: 0,
    max_attempts: 5,
    url,
  }
}

describe('processWebhookDeliveryBatch', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uma entrega que falha não impede as outras do lote', async () => {
    const { admin, resultados } = makeAdmin({
      jobs: [
        job(DELIVERY_A, WEBHOOK_ID, 'https://a.exemplo.com/hook'),
        job(DELIVERY_B, WEBHOOK_ID, 'https://b.exemplo.com/hook'),
        job(DELIVERY_C, WEBHOOK_ID, 'https://c.exemplo.com/hook'),
      ],
      segredoPorWebhook: { [WEBHOOK_ID]: encryptToken(SEGREDO) },
    })

    const impl = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.includes('b.exemplo.com')) throw new Error('ECONNREFUSED')
      return okResponse()
    }) as unknown as typeof fetch

    const r = await processWebhookDeliveryBatch({
      admin,
      workerId: 'worker-1',
      fetchImpl: impl,
    })

    expect(r.claimed).toBe(3)
    expect(r.delivered).toBe(2)
    expect(r.retried).toBe(1)
    expect(resultados).toHaveLength(3)
    // a do meio falhou, as das pontas foram entregues
    expect(resultados.map((x) => x.p_ok)).toEqual([true, false, true])
    expect(r.outcomes.map((o) => o.deliveryId)).toEqual([DELIVERY_A, DELIVERY_B, DELIVERY_C])
    expect(JSON.stringify(r)).not.toContain(SEGREDO)
  })

  it('lê e decifra o segredo uma vez por inscrição, não por entrega', async () => {
    const { admin, leiturasDeSegredo } = makeAdmin({
      jobs: [job(DELIVERY_A), job(DELIVERY_B), job(DELIVERY_C, OUTRO_WEBHOOK_ID)],
      segredoPorWebhook: {
        [WEBHOOK_ID]: encryptToken(SEGREDO),
        [OUTRO_WEBHOOK_ID]: encryptToken(OUTRO_SEGREDO),
      },
    })
    const { impl } = makeFetchSpy(() => okResponse())

    await processWebhookDeliveryBatch({ admin, workerId: 'w', fetchImpl: impl })

    expect(leiturasDeSegredo).toEqual([WEBHOOK_ID, OUTRO_WEBHOOK_ID])
  })

  it('entrega sem segredo utilizável vira falha registrada, não exceção', async () => {
    const { admin, resultados } = makeAdmin({
      jobs: [job(DELIVERY_A)],
      segredoPorWebhook: {},
    })
    const { impl, chamadas } = makeFetchSpy(() => okResponse())

    const r = await processWebhookDeliveryBatch({ admin, workerId: 'w', fetchImpl: impl })

    expect(chamadas).toHaveLength(0)
    expect(r.retried).toBe(1)
    expect(resultados[0]).toMatchObject({ p_ok: false, p_erro: 'segredo_indisponivel' })
  })

  it('erro transitório NÃO registra resultado — a entrega volta pelo lease', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { admin, resultados } = makeAdmin({ jobs: [job(DELIVERY_A)] })
    // força uma falha de LEITURA (não "sem segredo")
    admin.from = vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({ data: null, error: { message: 'timeout' } })),
        })),
      })),
    }))

    const r = await processWebhookDeliveryBatch({ admin, workerId: 'w' })

    expect(resultados).toHaveLength(0)
    expect(r.outcomes[0].status).toBe('erro_inesperado')
    expect(r.delivered + r.retried + r.deadLettered).toBe(0)
  })

  it('claim recusado devolve lote vazio sem tentar nada', async () => {
    const rpc = vi.fn(async () => ({ data: { ok: false, reason: 'worker_id_obrigatorio' }, error: null }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = { rpc, from: vi.fn() } as any
    const r = await processWebhookDeliveryBatch({ admin, workerId: '' })
    expect(r).toEqual({ claimed: 0, delivered: 0, retried: 0, deadLettered: 0, remaining: 0, outcomes: [] })
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('propaga erro da RPC de claim (é problema de infra, não de uma entrega)', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'boom' } }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = { rpc, from: vi.fn() } as any
    await expect(processWebhookDeliveryBatch({ admin, workerId: 'w' })).rejects.toBeTruthy()
  })

  it('manda o worker_id junto do resultado — é o fence do lease', async () => {
    const { admin, resultados } = makeAdmin({
      jobs: [job(DELIVERY_A)],
      segredoPorWebhook: { [WEBHOOK_ID]: encryptToken(SEGREDO) },
    })
    const { impl } = makeFetchSpy(() => okResponse())

    await processWebhookDeliveryBatch({ admin, workerId: 'worker-1', fetchImpl: impl })

    // Sem isto a RPC fecha por id e um tique com outro lease conta a tentativa
    // que este worker está gastando.
    expect(resultados[0].p_worker_id).toBe('worker-1')
  })

  it('lease perdido não vira entrega contabilizada — aparece como tal no tique', async () => {
    const { admin } = makeAdmin({
      jobs: [job(DELIVERY_A)],
      segredoPorWebhook: { [WEBHOOK_ID]: encryptToken(SEGREDO) },
      aoRegistrar: () => ({ data: { ok: false, reason: 'lease_perdido' }, error: null }),
    })
    const { impl } = makeFetchSpy(() => okResponse())

    const r = await processWebhookDeliveryBatch({ admin, workerId: 'w', fetchImpl: impl })

    expect(r.outcomes[0].status).toBe('lease_perdido')
    // recusa da RPC não é sucesso nem retry: nenhum contador pode se mexer, senão
    // o painel do tique mente sobre o que realmente foi entregue.
    expect(r.delivered + r.retried + r.deadLettered).toBe(0)
  })
})

// -------------------------------------------------- 6. o orçamento do lease

/**
 * O lease é uma promessa com prazo: "esta linha é minha por N segundos". Um laço
 * sequencial com timeout de 10s por entrega e lote de 20 leva até 200s — contra
 * um lease padrão de 120s. Da décima segunda em diante o worker está POSTando
 * numa linha que outro tique já reivindicou: POST duplicado no destino e
 * `attempts` andando duas vezes por ciclo real, o que mata a entrega em duas ou
 * três tentativas em vez das cinco contratadas.
 *
 * O relógio é injetado (`nowMs`) para o teste provar a parada em milissegundos
 * em vez de esperar minutos — o que estaria sendo testado num sleep de verdade
 * seria a paciência do CI, não a regra.
 */
describe('o lote respeita o prazo do lease', () => {
  function jobsSequenciais(quantidade: number) {
    return Array.from({ length: quantidade }, (_, i) =>
      job(`0000000${i}-0000-4000-8000-00000000000${i}`),
    )
  }

  it('para quando o próximo item não cabe e diz quantos ficaram para o próximo tique', async () => {
    const { admin, resultados } = makeAdmin({
      jobs: jobsSequenciais(6),
      segredoPorWebhook: { [WEBHOOK_ID]: encryptToken(SEGREDO) },
    })

    let agora = 0
    // Cada destino leva 4s. Lease de 12s, margem de 2s -> prazo em 10s.
    const { impl, chamadas } = makeFetchSpy(() => {
      agora += 4_000
      return okResponse()
    })

    const r = await processWebhookDeliveryBatch({
      admin,
      workerId: 'w',
      leaseSeconds: 12,
      timeoutMs: 5_000,
      fetchImpl: impl,
      nowMs: () => agora,
    })

    // 1ª em t=0 (termina 4s); 2ª em t=4s (4+5=9 <= 10, termina 8s);
    // 3ª em t=8s -> 8+5=13 > 10 -> para.
    expect(r.claimed).toBe(6)
    expect(r.delivered).toBe(2)
    expect(r.remaining).toBe(4)
    expect(chamadas).toHaveLength(2)
    expect(resultados).toHaveLength(2)
    // e o mais importante: o laço não passou do lease
    expect(agora).toBeLessThan(12_000)
  })

  it('a primeira entrega roda mesmo com o orçamento já estourado', async () => {
    const { admin } = makeAdmin({
      jobs: jobsSequenciais(3),
      segredoPorWebhook: { [WEBHOOK_ID]: encryptToken(SEGREDO) },
    })
    let agora = 0
    const { impl, chamadas } = makeFetchSpy(() => {
      agora += 1_000
      return okResponse()
    })

    // Lease menor que a margem: orçamento negativo desde o começo. Desistir de
    // tudo faria todo tique reivindicar e não entregar nada — a fila nunca andaria.
    const r = await processWebhookDeliveryBatch({
      admin,
      workerId: 'w',
      leaseSeconds: 1,
      timeoutMs: 10_000,
      fetchImpl: impl,
      nowMs: () => agora,
    })

    expect(chamadas).toHaveLength(1)
    expect(r.delivered).toBe(1)
    expect(r.remaining).toBe(2)
  })

  it('lease pedido acima do teto do banco não infla o orçamento', async () => {
    // O claim clampa `p_lease_seconds` em 3600. Pedir 99999 e orçar 99999 daria um
    // prazo que o lease real não cobre — o pior dos mundos, porque a checagem
    // pareceria estar lá e não seguraria nada.
    const { admin } = makeAdmin({
      jobs: jobsSequenciais(4),
      segredoPorWebhook: { [WEBHOOK_ID]: encryptToken(SEGREDO) },
    })
    let agora = 0
    const { impl, chamadas } = makeFetchSpy(() => {
      // 3590s por entrega. A conta importa: o prazo real é 3600s (o teto do banco)
      // menos a margem de 2s, ou seja 3598s. Para a SEGUNDA não caber, a primeira
      // precisa terminar depois de 3598 - 10 (o timeout que o laço reserva) = 3588s.
      // 3500s deixaria a segunda entrar e o teste mediria a coisa errada.
      agora += 3_590_000
      return okResponse()
    })

    const r = await processWebhookDeliveryBatch({
      admin,
      workerId: 'w',
      leaseSeconds: 99_999,
      timeoutMs: 10_000,
      fetchImpl: impl,
      nowMs: () => agora,
    })

    expect(chamadas).toHaveLength(1)
    expect(r.remaining).toBe(3)
    expect(agora).toBeLessThan(3_600_000)
  })

  it('lote que cabe no lease não sobra nada', async () => {
    const { admin } = makeAdmin({
      jobs: jobsSequenciais(3),
      segredoPorWebhook: { [WEBHOOK_ID]: encryptToken(SEGREDO) },
    })
    let agora = 0
    const { impl, chamadas } = makeFetchSpy(() => {
      agora += 100
      return okResponse()
    })

    const r = await processWebhookDeliveryBatch({
      admin,
      workerId: 'w',
      leaseSeconds: 120,
      fetchImpl: impl,
      nowMs: () => agora,
    })

    expect(chamadas).toHaveLength(3)
    expect(r.delivered).toBe(3)
    expect(r.remaining).toBe(0)
  })
})

// ------------------------------- 7. a entrega que não consegue ser registrada

/**
 * Teto para o pior modo de falha da fila: `deliverWebhook` produz um resultado,
 * mas `registrarResultado` não consegue gravá-lo (o Postgres recusa o corpo).
 * Sem teto, o catch genérico devolve a linha para 'processando' com `attempts`
 * INALTERADO, o lease expira, outro tique reivindica, recebe a MESMA resposta do
 * destino e falha igual — POST repetido no destino a cada dois minutos, para
 * sempre, sem tentativa contabilizada, sem dead-letter e sem trilha.
 *
 * A saída é uma segunda chamada com mensagem fixa ASCII: se ela passa, o
 * problema era o texto e a entrega volta a andar (tentativa contada, backoff,
 * dead-letter na hora certa). Se ela também falha, é o banco que está fora e o
 * comportamento antigo continua valendo — que é o certo numa queda do Supabase.
 */
describe('entrega que o banco recusa registrar', () => {
  /** Banco que só aceita a mensagem fixa; qualquer outro p_erro é recusado. */
  function bancoQueRecusaTexto(maxAttempts = 3) {
    const estado = { attempts: 0, status: 'pendente', postsNoDestino: 0 }
    const rpc = vi.fn(async (nome: string, args: Record<string, unknown>) => {
      if (nome === 'whatsapp_oficial_webhook_claim') {
        const jobs =
          estado.status === 'morto'
            ? []
            : [{ ...job(DELIVERY_A), attempts: estado.attempts, max_attempts: maxAttempts }]
        return { data: { ok: true, claimed: jobs }, error: null }
      }
      if (nome === 'whatsapp_oficial_webhook_registrar_resultado') {
        if (args.p_erro !== 'erro_ao_registrar') {
          throw new Error('invalid byte sequence for encoding "UTF8"')
        }
        estado.attempts += 1
        estado.status = estado.attempts >= maxAttempts ? 'morto' : 'falhou'
        return {
          data: { ok: true, status: estado.status, attempts: estado.attempts },
          error: null,
        }
      }
      throw new Error(`rpc inesperada: ${nome}`)
    })
    const from = vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({
            data: { segredo_cifrado: encryptToken(SEGREDO) },
            error: null,
          })),
        })),
      })),
    }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { admin: { rpc, from } as any, estado }
  }

  it('acaba em dead-letter em vez de girar para sempre POSTando no destino', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const MAX = 3
    const { admin, estado } = bancoQueRecusaTexto(MAX)
    const { impl, chamadas } = makeFetchSpy(() => {
      estado.postsNoDestino += 1
      return okResponse('falhou', 500)
    })

    let tiques = 0
    // 10 tiques é folga de sobra: a entrega tem que morrer em MAX. Se o teto não
    // existe, o laço roda os 10 e o destino leva 10 POSTs do mesmo evento.
    while (tiques < 10 && estado.status !== 'morto') {
      tiques += 1
      await processWebhookDeliveryBatch({ admin, workerId: `w-${tiques}`, fetchImpl: impl })
    }

    expect(estado.status).toBe('morto')
    expect(estado.attempts).toBe(MAX)
    expect(tiques).toBe(MAX)
    expect(chamadas).toHaveLength(MAX)
  })

  it('banco realmente fora continua devolvendo a entrega pelo lease, sem contar tentativa', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Aqui NADA passa, nem a mensagem fixa: é queda de banco, não texto ruim.
    const { admin, resultados } = makeAdmin({
      jobs: [job(DELIVERY_A)],
      segredoPorWebhook: { [WEBHOOK_ID]: encryptToken(SEGREDO) },
      aoRegistrar: () => {
        throw new Error('connection reset by peer')
      },
    })
    const { impl } = makeFetchSpy(() => okResponse())

    const r = await processWebhookDeliveryBatch({ admin, workerId: 'w', fetchImpl: impl })

    expect(r.outcomes[0].status).toBe('erro_inesperado')
    expect(r.delivered + r.retried + r.deadLettered).toBe(0)
    // duas chamadas: a original e a segunda chance com a mensagem segura
    expect(resultados).toHaveLength(2)
    expect(resultados[1].p_erro).toBe('erro_ao_registrar')
  })
})
