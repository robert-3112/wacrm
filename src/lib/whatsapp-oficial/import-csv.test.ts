import { describe, expect, it } from 'vitest'
import { parseLeadCsv } from './import-csv'

describe('parseLeadCsv', () => {
  it('lê exportação brasileira com BOM, ponto e vírgula, aspas e quebra interna', () => {
    expect(parseLeadCsv('\uFEFFNome;WhatsApp;E-mail;Responsável email;Cidade\r\n"Ana; Maria";5511999990000;ANA@EXAMPLE.COM;corretor@example.com;"São\nPaulo"\r\n'))
      .toEqual([{ nome: 'Ana; Maria', telefone: '5511999990000', email: 'ANA@EXAMPLE.COM',
        corretor_email: 'corretor@example.com', cidade: 'São\nPaulo' }])
  })

  it('mantém linhas incompletas para o banco apontar o erro por linha', () => {
    expect(parseLeadCsv('Nome,Telefone\nAna,5511999990000\n,123\n'))
      .toEqual([{ nome: 'Ana', telefone: '5511999990000' }, { nome: '', telefone: '123' }])
  })

  it('recusa arquivo sem colunas essenciais e lote acima do limite da RPC', () => {
    expect(() => parseLeadCsv('Nome,Email\nAna,a@b.com')).toThrow('Nome e Telefone')
    expect(() => parseLeadCsv(`Nome,Telefone\n${'Ana,5511999990000\n'.repeat(501)}`))
      .toThrow('500')
  })
})
