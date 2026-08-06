import { describe, it, expect } from 'vitest'
import { destinoSeguro } from './route'

/**
 * `next` chega pela URL do link do e-mail, ou seja, do lado de fora. Um
 * `?next=https://site-falso/` transformaria este endpoint de AUTENTICAÇÃO num
 * redirecionamento aberto — e é o pior tipo, porque a vítima chega nele logo
 * depois de clicar num e-mail legítimo do sistema, com a guarda baixa.
 */
describe('destinoSeguro', () => {
  it('aceita caminho interno', () => {
    expect(destinoSeguro('/reset-password')).toBe('/reset-password')
    expect(destinoSeguro('/dashboard/leads?x=1')).toBe('/dashboard/leads?x=1')
  })

  it('cai no padrão quando não vem nada', () => {
    expect(destinoSeguro(null)).toBe('/dashboard')
    expect(destinoSeguro('')).toBe('/dashboard')
  })

  it.each([
    ['https://site-falso.test/', 'URL absoluta'],
    ['http://site-falso.test/', 'URL absoluta sem TLS'],
    ['//site-falso.test/', 'protocol-relative — o navegador SAI do domínio'],
    ['/\\site-falso.test/', 'barra invertida, que alguns navegadores tratam como //'],
    ['javascript:alert(1)', 'esquema javascript'],
    ['dashboard', 'relativo sem barra inicial'],
  ])('recusa %s (%s)', (entrada) => {
    expect(destinoSeguro(entrada)).toBe('/dashboard')
  })
})
