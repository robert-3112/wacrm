import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { resolvePublicBaseUrl } from './base-url'

/**
 * Esta cadeia decide para qual HOST o sistema manda o usuário em link de
 * convite e em redirect de autenticação. Errar por cima manda para localhost
 * (aconteceu: o link de redefinição de senha caía em ERR_CONNECTION_REFUSED);
 * errar por baixo aceita host forjado e vira phishing com a marca da SUNT.
 */

const FALLBACK = 'https://fallback.test'

function req(headers: Record<string, string>, url = 'http://localhost:3000/auth/callback') {
  return new Request(url, { headers })
}

describe('resolvePublicBaseUrl', () => {
  const envOriginal = { ...process.env }

  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_SITE_URL
    delete process.env.ALLOWED_INVITE_HOSTS
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    process.env = { ...envOriginal }
    vi.restoreAllMocks()
  })

  it('NEXT_PUBLIC_SITE_URL vence tudo, e a barra final some', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://oficial.test/'
    expect(resolvePublicBaseUrl(req({ 'x-forwarded-host': 'outro.test' }), FALLBACK)).toBe(
      'https://oficial.test',
    )
  })

  it('REGRESSAO: sem config, usa o host do proxy e NAO o localhost interno', () => {
    // Era exatamente este o defeito: `new URL(request.url).origin` devolve
    // http://localhost:3000 dentro do contêiner, e o e-mail de redefinição
    // levava o usuário para lá.
    const base = resolvePublicBaseUrl(
      req({ 'x-forwarded-host': 'app.sunt.test', 'x-forwarded-proto': 'https' }),
      FALLBACK,
    )
    expect(base).toBe('https://app.sunt.test')
    expect(base).not.toContain('localhost')
  })

  it('assume https quando o proxy manda host sem proto', () => {
    expect(resolvePublicBaseUrl(req({ 'x-forwarded-host': 'app.sunt.test' }), FALLBACK)).toBe(
      'https://app.sunt.test',
    )
  })

  it('pega o primeiro da cadeia quando o proxy encadeia varios', () => {
    expect(
      resolvePublicBaseUrl(
        req({ 'x-forwarded-host': 'app.sunt.test, interno.local', 'x-forwarded-proto': 'https, http' }),
        FALLBACK,
      ),
    ).toBe('https://app.sunt.test')
  })

  it('cai no cabecalho Host quando nao ha proxy', () => {
    expect(
      resolvePublicBaseUrl(req({ host: 'app.sunt.test' }, 'https://x/y'), FALLBACK),
    ).toBe('https://app.sunt.test')
  })

  it('usa o fallback quando nao ha cabecalho nenhum', () => {
    // Request() sempre deriva um Host da URL, entao forcamos a ausencia.
    const semHost = { headers: { get: () => null }, url: 'http://localhost:3000/' } as unknown as Request
    expect(resolvePublicBaseUrl(semHost, FALLBACK)).toBe(FALLBACK)
  })

  describe('allow-list', () => {
    beforeEach(() => {
      process.env.ALLOWED_INVITE_HOSTS = 'app.sunt.test, crm.sunt.test'
    })

    it('aceita host da lista', () => {
      expect(resolvePublicBaseUrl(req({ 'x-forwarded-host': 'app.sunt.test' }), FALLBACK)).toBe(
        'https://app.sunt.test',
      )
    })

    it('e indiferente a maiuscula/minuscula', () => {
      expect(resolvePublicBaseUrl(req({ 'x-forwarded-host': 'APP.SUNT.TEST' }), FALLBACK)).toBe(
        'https://APP.SUNT.TEST',
      )
    })

    it('RECUSA host forjado e cai no fallback', () => {
      expect(
        resolvePublicBaseUrl(req({ 'x-forwarded-host': 'site-falso.test' }), FALLBACK),
      ).toBe(FALLBACK)
      expect(console.warn).toHaveBeenCalled()
    })

    it('RECUSA host forjado tambem pelo cabecalho Host', () => {
      const forjado = {
        headers: { get: (k: string) => (k === 'host' ? 'site-falso.test' : null) },
        url: 'https://x/y',
      } as unknown as Request
      expect(resolvePublicBaseUrl(forjado, FALLBACK)).toBe(FALLBACK)
    })

    it('lista so com virgulas e espacos conta como ausente (permissivo)', () => {
      process.env.ALLOWED_INVITE_HOSTS = ' , , '
      expect(resolvePublicBaseUrl(req({ 'x-forwarded-host': 'qualquer.test' }), FALLBACK)).toBe(
        'https://qualquer.test',
      )
    })
  })
})
