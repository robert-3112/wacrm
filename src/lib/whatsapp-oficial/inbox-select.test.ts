import { describe, it, expect } from 'vitest'
import { CONVERSATION_SELECT } from './inbox-data'
import { ROTA_INICIAL, ROTAS_PROTEGIDAS } from '../rotas'

/**
 * REGRESSAO medida em producao no primeiro acesso real (2026-08-07).
 *
 * `leads.corretor_id` tem DUAS foreign keys para `corretores`:
 *   leads_corretor_id_fkey            (corretor_id) -> corretores(id)
 *   leads_corretor_id_tenant_fkey_os  (tenant_id, corretor_id) -> corretores(tenant_id, id)
 *
 * Com dois caminhos possiveis o PostgREST recusa a consulta INTEIRA com
 * PGRST201 — nao devolve o corretor vazio, devolve erro. O sintoma na tela foi
 * "Nao foi possivel carregar as conversas" com a lista vazia, enquanto a
 * conversa estava intacta no banco.
 *
 * Confirmado contra o PostgREST de producao:
 *   sem a FK nomeada -> PGRST201 "more than one relationship was found"
 *   com a FK nomeada -> 1 linha, corretor "Carol Bernardi"
 *
 * Este teste falha se alguem "limpar" a sintaxe e tirar o nome da constraint.
 */
describe('CONVERSATION_SELECT', () => {
  it('nomeia a foreign key ao aninhar corretores — senao o PostgREST recusa tudo', () => {
    expect(CONVERSATION_SELECT).toContain(
      'corretor:corretores!leads_corretor_id_tenant_fkey_os',
    )
  })

  it('nao deixa nenhum embed de corretores sem FK explicita', () => {
    // Todo embed de corretores, com ou sem `!nome_da_fk`...
    const todos = (CONVERSATION_SELECT.match(/corretores(![a-z_]+)?\s*\(/g) ?? []).length
    // ...e so os que nomeiam a constraint.
    const nomeados = (CONVERSATION_SELECT.match(/corretores![a-z_]+\s*\(/g) ?? []).length

    expect(todos).toBeGreaterThan(0) // guarda: se o embed sumir, o teste vira vacuo
    expect(nomeados).toBe(todos)
  })

  it('usa a FK COMPOSTA, que casa o tenant junto', () => {
    // A simples (corretor_id -> id) funcionaria para o PostgREST, mas deixaria o
    // join capaz de cruzar tenants. A composta nao.
    expect(CONVERSATION_SELECT).not.toContain('corretores!leads_corretor_id_fkey')
  })
})

describe('rota inicial', () => {
  it('leva para o painel da SUNT, nao para o dashboard do fork', () => {
    expect(ROTA_INICIAL).toBe('/whatsapp-oficial/inbox')
  })

  it('o inbox oficial esta protegido por sessao', () => {
    expect(ROTAS_PROTEGIDAS).toContain('/whatsapp-oficial')
    expect(ROTAS_PROTEGIDAS.some((p) => ROTA_INICIAL.startsWith(p))).toBe(true)
  })
})
