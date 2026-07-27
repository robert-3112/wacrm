import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
}))

vi.mock('./supabase-admin', () => ({
  supabaseAdmin: () => ({ rpc: mocks.rpc }),
}))

import {
  requireApiKey,
  requireApiKeyWithScope,
  requireScope,
  toApiV1Response,
  apiV1Page,
  ApiV1Error,
  API_V1_RATE_LIMIT,
  API_V1_ORIGIN_RATE_LIMIT,
} from './api-key-auth'

const CHAVE = `wa_live_${'a'.repeat(48)}`

function req(headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/v1/health', { headers })
}

/** Exatamente o que `openssl rand -hex 24` produz — a forma que o atacante usaria. */
function chaveAleatoria() {
  return `wa_live_${randomBytes(24).toString('hex')}`
}

/** `x-forwarded-for` com um salto de proxy depois, como chega em produção. */
function reqDeIp(ip: string, chave?: string) {
  const headers: Record<string, string> = { 'x-forwarded-for': `${ip}, 10.0.0.7` }
  if (chave) headers.authorization = `Bearer ${chave}`
  return req(headers)
}

/** Roda `requireApiKey` e devolve a Response de erro, ou null se autenticou. */
async function tentativa(request: Request): Promise<Response | null> {
  return requireApiKey(request).then(
    () => null,
    (e) => toApiV1Response(e) as Response,
  )
}

function autenticada(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      ok: true,
      api_key_id: 'key-1',
      tenant_id: 'sunt',
      escopos: ['conversations:read'],
      ...overrides,
    },
    error: null,
  }
}

/** Lê o corpo JSON de uma NextResponse. */
async function corpo(res: Response) {
  return (await res.json()) as Record<string, unknown>
}

describe('requireApiKey — formato do header', () => {
  beforeEach(() => {
    mocks.rpc.mockReset()
    __resetRateLimitForTests()
  })

  const malformados: Array<[string, Record<string, string>]> = [
    ['sem header', {}],
    ['header vazio', { authorization: '' }],
    ['sem o esquema Bearer', { authorization: CHAVE }],
    ['esquema errado', { authorization: `Basic ${CHAVE}` }],
    ['Bearer sem valor', { authorization: 'Bearer ' }],
    ['prefixo errado', { authorization: 'Bearer wacrm_live_abcdef0123456789' }],
    ['corpo nao-hexadecimal', { authorization: 'Bearer wa_live_ZZZZZZZZZZZZZZZZ' }],
    ['corpo curto demais', { authorization: 'Bearer wa_live_abc' }],
    ['dois tokens', { authorization: `Bearer ${CHAVE} extra` }],
  ]

  for (const [rotulo, headers] of malformados) {
    it(`401 sem tocar no banco: ${rotulo}`, async () => {
      await expect(requireApiKey(req(headers))).rejects.toBeInstanceOf(ApiV1Error)
      // O ponto do teste: formato ruim não vira consulta.
      expect(mocks.rpc).not.toHaveBeenCalled()
    })
  }

  it('aceita o esquema em qualquer caixa e com espaco extra', async () => {
    mocks.rpc.mockResolvedValue(autenticada())
    const ctx = await requireApiKey(req({ authorization: `bearer   ${CHAVE}` }))
    expect(ctx.tenantId).toBe('sunt')
  })
})

describe('requireApiKey — respostas do banco', () => {
  beforeEach(() => {
    mocks.rpc.mockReset()
    __resetRateLimitForTests()
  })

  it('devolve tenant, escopos e id da chave no caminho feliz', async () => {
    mocks.rpc.mockResolvedValue(autenticada())
    const ctx = await requireApiKey(req({ authorization: `Bearer ${CHAVE}` }))
    expect(ctx).toMatchObject({
      apiKeyId: 'key-1',
      tenantId: 'sunt',
      escopos: ['conversations:read'],
    })
    expect(mocks.rpc).toHaveBeenCalledWith('whatsapp_oficial_autenticar_api_key', {
      p_chave: CHAVE,
    })
  })

  it('CORPO IDENTICO para chave inexistente, revogada e expirada', async () => {
    const corpos: string[] = []
    const status: number[] = []

    // Inclui o caso de header ausente para provar que ele também é indistinguível.
    mocks.rpc.mockResolvedValue({ data: null, error: null })
    for (const reason of ['chave_invalida', 'chave_revogada', 'chave_expirada', 'chave_ausente']) {
      mocks.rpc.mockResolvedValue({ data: { ok: false, reason }, error: null })
      const res = await requireApiKey(req({ authorization: `Bearer ${CHAVE}` })).catch((e) =>
        toApiV1Response(e),
      )
      status.push((res as Response).status)
      corpos.push(JSON.stringify(await corpo(res as Response)))
    }
    const semHeader = await requireApiKey(req()).catch((e) => toApiV1Response(e))
    status.push((semHeader as Response).status)
    corpos.push(JSON.stringify(await corpo(semHeader as Response)))

    expect(new Set(status)).toEqual(new Set([401]))
    expect(new Set(corpos).size).toBe(1)
    expect(JSON.parse(corpos[0])).toEqual({
      error: 'unauthorized',
      message: 'Missing or invalid API key',
    })
  })

  it('falha de infraestrutura vira 500, nao 401 (chave certa nao pode parecer errada)', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'connection refused' } })
    const res = await requireApiKey(req({ authorization: `Bearer ${CHAVE}` })).catch((e) =>
      toApiV1Response(e),
    )
    expect((res as Response).status).toBe(500)
    // A mensagem interna não pode vazar para o fio.
    expect(JSON.stringify(await corpo(res as Response))).not.toContain('connection refused')
  })

  it('ok:true sem tenant_id e recusado — chave sem tenant enxergaria tudo', async () => {
    mocks.rpc.mockResolvedValue(autenticada({ tenant_id: '   ' }))
    await expect(requireApiKey(req({ authorization: `Bearer ${CHAVE}` }))).rejects.toMatchObject({
      status: 401,
    })
  })

  it('ok:true sem api_key_id e recusado', async () => {
    mocks.rpc.mockResolvedValue(autenticada({ api_key_id: null }))
    await expect(requireApiKey(req({ authorization: `Bearer ${CHAVE}` }))).rejects.toMatchObject({
      status: 401,
    })
  })

  it('escopos em formato inesperado viram lista vazia, nao acesso total', async () => {
    mocks.rpc.mockResolvedValue(autenticada({ escopos: 'messages:send' }))
    const ctx = await requireApiKey(req({ authorization: `Bearer ${CHAVE}` }))
    expect(ctx.escopos).toEqual([])
    expect(() => requireScope(ctx, 'messages:send')).toThrow()
  })
})

describe('requireScope', () => {
  beforeEach(() => {
    mocks.rpc.mockReset()
    __resetRateLimitForTests()
  })

  it('403 com o escopo exigido no corpo', async () => {
    mocks.rpc.mockResolvedValue(autenticada({ escopos: ['conversations:read'] }))
    const res = await requireApiKeyWithScope(
      req({ authorization: `Bearer ${CHAVE}` }),
      'messages:send',
    ).catch((e) => toApiV1Response(e))

    expect((res as Response).status).toBe(403)
    expect(await corpo(res as Response)).toEqual({
      error: 'insufficient_scope',
      required: 'messages:send',
      message: "This API key is missing the 'messages:send' scope",
    })
  })

  it('deixa passar quando o escopo esta presente', async () => {
    mocks.rpc.mockResolvedValue(autenticada({ escopos: ['messages:send', 'contacts:read'] }))
    const ctx = await requireApiKeyWithScope(
      req({ authorization: `Bearer ${CHAVE}` }),
      'messages:send',
    )
    expect(ctx.tenantId).toBe('sunt')
  })

  it('escopo parecido nao conta como o escopo exigido', async () => {
    mocks.rpc.mockResolvedValue(autenticada({ escopos: ['messages:read'] }))
    const ctx = await requireApiKey(req({ authorization: `Bearer ${CHAVE}` }))
    expect(() => requireScope(ctx, 'messages:send')).toThrow(ApiV1Error)
  })
})

describe('vazao por chave', () => {
  beforeEach(() => {
    mocks.rpc.mockReset()
    __resetRateLimitForTests()
  })

  it('429 com Retry-After depois de estourar o orcamento da chave', async () => {
    mocks.rpc.mockResolvedValue(autenticada())
    for (let i = 0; i < API_V1_RATE_LIMIT.limit; i += 1) {
      await requireApiKey(req({ authorization: `Bearer ${CHAVE}` }))
    }
    const res = await requireApiKey(req({ authorization: `Bearer ${CHAVE}` })).catch((e) =>
      toApiV1Response(e),
    )
    expect((res as Response).status).toBe(429)
    expect((res as Response).headers.get('Retry-After')).toBeTruthy()
    expect((await corpo(res as Response)).error).toBe('rate_limited')
  })

  it('o balde e por chave: outra chave nao herda o estouro da primeira', async () => {
    mocks.rpc.mockResolvedValue(autenticada())
    for (let i = 0; i < API_V1_RATE_LIMIT.limit; i += 1) {
      await requireApiKey(req({ authorization: `Bearer ${CHAVE}` }))
    }
    const outra = `wa_live_${'b'.repeat(48)}`
    await expect(requireApiKey(req({ authorization: `Bearer ${outra}` }))).resolves.toMatchObject({
      tenantId: 'sunt',
    })
  })

  it('chave invalida repetida gasta o balde antes de martelar o banco', async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: false, reason: 'chave_invalida' }, error: null })
    for (let i = 0; i < API_V1_RATE_LIMIT.limit; i += 1) {
      await requireApiKey(req({ authorization: `Bearer ${CHAVE}` })).catch(() => null)
    }
    const chamadasAntes = mocks.rpc.mock.calls.length
    await requireApiKey(req({ authorization: `Bearer ${CHAVE}` })).catch(() => null)
    expect(mocks.rpc.mock.calls.length).toBe(chamadasAntes)
  })
})

describe('vazao por origem', () => {
  beforeEach(() => {
    mocks.rpc.mockReset()
    __resetRateLimitForTests()
  })

  it('200 requisicoes com chaves ALEATORIAS diferentes do mesmo IP tomam 429', async () => {
    // O ataque que o balde por chave não vê: cada `openssl rand -hex 24` é um balde novo de 120,
    // então nada nunca estoura — e cada volta do laço é uma RPC no Postgres que o Hub divide com
    // o CRM, mais uma entrada no Map de baldes.
    mocks.rpc.mockResolvedValue(autenticada())

    let bloqueadaEm: number | null = null
    for (let i = 0; i < 200; i += 1) {
      const res = await tentativa(reqDeIp('203.0.113.7', chaveAleatoria()))
      if (res) {
        expect(res.status).toBe(429)
        expect((await corpo(res)).error).toBe('rate_limited')
        expect(res.headers.get('Retry-After')).toBeTruthy()
        bloqueadaEm = i
        break
      }
    }

    expect(bloqueadaEm).not.toBeNull()
    // Corta DEPOIS do teto por chave (o integrador honesto com uma chave não é atingido antes)
    // e ANTES das 200 (o laço não roda de graça).
    expect(bloqueadaEm!).toBeGreaterThanOrEqual(API_V1_RATE_LIMIT.limit)
    expect(bloqueadaEm!).toBe(API_V1_ORIGIN_RATE_LIMIT.limit)

    // E, bloqueado, para de encostar no banco: era esse o custo real do laço.
    const chamadas = mocks.rpc.mock.calls.length
    for (let i = 0; i < 10; i += 1) {
      await tentativa(reqDeIp('203.0.113.7', chaveAleatoria()))
    }
    expect(mocks.rpc.mock.calls.length).toBe(chamadas)
  })

  it('sem IP nenhum o balde global de ultima instancia segura o mesmo laco', async () => {
    // Se o proxy parar de mandar o header, não pode sobrar caminho sem teto.
    mocks.rpc.mockResolvedValue(autenticada())
    let bloqueou = false
    for (let i = 0; i < 200; i += 1) {
      const res = await tentativa(req({ authorization: `Bearer ${chaveAleatoria()}` }))
      if (res) {
        bloqueou = res.status === 429
        break
      }
    }
    expect(bloqueou).toBe(true)
  })

  it('outra origem nao herda o estouro da primeira', async () => {
    mocks.rpc.mockResolvedValue(autenticada())
    for (let i = 0; i < API_V1_ORIGIN_RATE_LIMIT.limit; i += 1) {
      await tentativa(reqDeIp('203.0.113.7', chaveAleatoria()))
    }
    const estourada = await tentativa(reqDeIp('203.0.113.7', chaveAleatoria()))
    expect(estourada?.status).toBe(429)

    // Vizinho de rack não paga pelo laço do outro.
    await expect(
      requireApiKey(reqDeIp('198.51.100.20', CHAVE)),
    ).resolves.toMatchObject({ tenantId: 'sunt' })
  })

  it('usa x-real-ip quando nao ha x-forwarded-for', async () => {
    mocks.rpc.mockResolvedValue(autenticada())
    for (let i = 0; i < API_V1_ORIGIN_RATE_LIMIT.limit; i += 1) {
      await tentativa(
        req({ 'x-real-ip': '203.0.113.9', authorization: `Bearer ${chaveAleatoria()}` }),
      )
    }
    const estourou = await tentativa(
      req({ 'x-real-ip': '203.0.113.9', authorization: `Bearer ${chaveAleatoria()}` }),
    )
    expect(estourou?.status).toBe(429)
    // Outro x-real-ip continua passando — é balde por origem, não global.
    await expect(
      requireApiKey(req({ 'x-real-ip': '198.51.100.30', authorization: `Bearer ${CHAVE}` })),
    ).resolves.toMatchObject({ tenantId: 'sunt' })
  })

  it('o balde de origem vale para quem nem apresenta chave', async () => {
    // A ordem importa: origem ANTES do formato. Senão o laço mais barato de todos — nenhum
    // header — continuaria de graça.
    mocks.rpc.mockResolvedValue(autenticada())
    for (let i = 0; i < API_V1_ORIGIN_RATE_LIMIT.limit; i += 1) {
      await tentativa(reqDeIp('203.0.113.7'))
    }
    const res = await tentativa(reqDeIp('203.0.113.7'))
    expect(res?.status).toBe(429)
  })

  it('a chave honesta atras do NAT nao e cortada antes do teto dela', async () => {
    mocks.rpc.mockResolvedValue(autenticada())
    for (let i = 0; i < API_V1_RATE_LIMIT.limit; i += 1) {
      await expect(requireApiKey(reqDeIp('203.0.113.7', CHAVE))).resolves.toMatchObject({
        tenantId: 'sunt',
      })
    }
    const res = await tentativa(reqDeIp('203.0.113.7', CHAVE))
    expect(res?.status).toBe(429)
    // Quem cortou foi o balde DA CHAVE, não o da origem.
    expect((await corpo(res!)).message).toContain('API key')
  })
})

describe('envelope', () => {
  it('sucesso paginado expoe next_cursor e has_more', async () => {
    const res = apiV1Page([{ id: 1 }], 'cursor-abc')
    expect(await corpo(res)).toEqual({
      data: [{ id: 1 }],
      pagination: { next_cursor: 'cursor-abc', has_more: true },
    })
  })

  it('ultima pagina tem has_more false', async () => {
    const res = apiV1Page([], null)
    expect(await corpo(res)).toEqual({
      data: [],
      pagination: { next_cursor: null, has_more: false },
    })
  })

  it('erro nao categorizado vira 500 generico sem texto interno', async () => {
    const res = toApiV1Response(new Error('senha do banco no stack trace'))
    expect(res.status).toBe(500)
    expect(await corpo(res)).toEqual({ error: 'internal', message: 'Internal server error' })
  })

  it('slug sem mensagem propria nao repete o slug em message', async () => {
    const res = toApiV1Response(new ApiV1Error('canal_inativo', 409))
    expect(await corpo(res)).toEqual({ error: 'canal_inativo' })
  })
})
