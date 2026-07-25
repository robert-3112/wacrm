/**
 * Testes da tradução de erro e dos vocabulários de status.
 *
 * O que trava aqui, em ordem de estrago se quebrar:
 *  1. Slug DESCONHECIDO não pode virar mensagem genérica — a tela mentiria
 *     "não foi possível concluir" para um caso novo que precisa de tradução, e
 *     ninguém descobriria que o vocabulário mudou.
 *  2. `templatePodeEnviar` só aceita `aprovado`. Qualquer afrouxamento aqui faz
 *     a tela oferecer envio que o banco vai recusar.
 *  3. Slug específico ganha do genérico por status: `aprovador_igual_criador`
 *     (409) tem de explicar quatro olhos, não dizer "conflito".
 */

import { describe, expect, it } from 'vitest'
import {
  MOTIVOS_SUPRESSAO_ORDEM,
  descricaoMotivoSupressao,
  rotuloMotivoSupressao,
  rotuloStatusCampanha,
  rotuloStatusTemplate,
  templateEmAlerta,
  templatePodeEnviar,
  traduzirErro,
} from './gestao-erros'

describe('traduzirErro', () => {
  it('traduz os slugs que mais aparecem na tela', () => {
    expect(traduzirErro('aprovador_igual_criador')).toContain('quatro olhos')
    expect(traduzirErro('sem_base_legal')).toBe('sem_base_legal') // não é erro de rota
    expect(traduzirErro('bases_legais_vazia')).toContain('suprime todo mundo')
    expect(traduzirErro('template_nao_aprovado')).toContain('aprovado')
    expect(traduzirErro('campanha_nao_editavel')).toContain('rascunho')
  })

  it('devolve o slug cru quando não conhece a tradução', () => {
    // Feio de propósito: um texto genérico esconderia o caso novo, e o slug é
    // pesquisável no código.
    expect(traduzirErro('motivo_que_ainda_nao_existe')).toBe('motivo_que_ainda_nao_existe')
  })

  it('slug conhecido ganha do genérico por status', () => {
    // 409 genérico não está sequer na tabela por status; o que importa é que a
    // frase específica sobreviva ao status.
    expect(traduzirErro('aprovador_igual_criador', 409)).toContain('quatro olhos')
    expect(traduzirErro('Forbidden', 403)).toContain('papel de gestão')
  })

  it('cai no genérico por status só quando não há slug', () => {
    expect(traduzirErro('', 401)).toContain('Sessão expirada')
    expect(traduzirErro(null, 429)).toContain('Muitas requisições')
    expect(traduzirErro(undefined, 500)).toContain('Erro interno')
  })

  it('tem uma última linha de defesa sem slug e sem status conhecido', () => {
    expect(traduzirErro(undefined)).toBe('Não foi possível concluir a ação.')
    expect(traduzirErro('   ', 418)).toBe('Não foi possível concluir a ação.')
  })

  it('traduz as mensagens que `toErrorResponse` devolve no lugar de slug', () => {
    // A rota responde `{ error: err.message }` para os erros tipados de
    // api-auth — o "slug" chega como 'Unauthorized'/'Not found'.
    expect(traduzirErro('Unauthorized')).toContain('Sessão expirada')
    expect(traduzirErro('Not found')).toBe('Registro não encontrado.')
  })
})

describe('motivos de supressão', () => {
  it('traduz todos os motivos do vocabulário da RPC', () => {
    for (const motivo of MOTIVOS_SUPRESSAO_ORDEM) {
      const rotulo = rotuloMotivoSupressao(motivo)
      expect(rotulo).not.toBe(motivo)
      expect(rotulo.length).toBeGreaterThan(0)
      expect(descricaoMotivoSupressao(motivo).length).toBeGreaterThan(0)
    }
  })

  it('deixa motivo novo aparecer cru em vez de sumir', () => {
    expect(rotuloMotivoSupressao('motivo_novo_da_rpc')).toBe('motivo_novo_da_rpc')
    // Sem descrição: inventar a regra que suprimiu alguém é pior que calar.
    expect(descricaoMotivoSupressao('motivo_novo_da_rpc')).toBe('')
  })
})

describe('status de template', () => {
  it('só `aprovado` pode ser enviado', () => {
    expect(templatePodeEnviar('aprovado')).toBe(true)
    for (const status of [
      'rascunho',
      'pendente',
      'rejeitado',
      'pausado',
      'desabilitado',
      'em_apelacao',
      'exclusao_pendente',
      'APPROVED', // valor cru da Meta nunca deve passar
      '',
    ]) {
      expect(templatePodeEnviar(status)).toBe(false)
    }
  })

  it('marca como alerta só o que está quebrado do lado da Meta', () => {
    expect(templateEmAlerta('rejeitado')).toBe(true)
    expect(templateEmAlerta('pausado')).toBe(true)
    expect(templateEmAlerta('desabilitado')).toBe(true)
    // `pendente` é fluxo normal, não alerta — realçar tudo é não realçar nada.
    expect(templateEmAlerta('pendente')).toBe(false)
    expect(templateEmAlerta('aprovado')).toBe(false)
  })

  it('rotula status conhecido e repassa desconhecido', () => {
    expect(rotuloStatusTemplate('em_apelacao')).toBe('Em apelação')
    expect(rotuloStatusTemplate('status_futuro')).toBe('status_futuro')
  })
})

describe('status de campanha', () => {
  it('nunca chama de "enviado" o que só foi enfileirado', () => {
    // O worker pode ter simulado tudo (modo shadow). "Enviando" na tela faria
    // o operador acreditar que o cliente recebeu.
    expect(rotuloStatusCampanha('enviando')).toBe('Enfileirando')
  })

  it('rotula os demais status e repassa desconhecido', () => {
    expect(rotuloStatusCampanha('aguardando_aprovacao')).toBe('Aguardando aprovação')
    expect(rotuloStatusCampanha('concluido')).toBe('Concluída')
    expect(rotuloStatusCampanha('status_futuro')).toBe('status_futuro')
  })
})
