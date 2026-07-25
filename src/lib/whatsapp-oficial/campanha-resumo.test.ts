/**
 * Testes do cálculo do público mostrado antes da aprovação.
 *
 * Todos os erros que estes testes travam são SILENCIOSOS na tela — número
 * errado, sem exceção nenhuma:
 *  1. Preferir o dry-run velho ao público materializado faria alguém aprovar
 *     olhando um número que já não vale.
 *  2. Ordenação instável faz a lista de motivos dançar entre dois refreshes.
 *  3. `podeAprovar` sem checar `destinatarios_gerados_em` habilitaria um botão
 *     que só pode tomar 409.
 */

import { describe, expect, it } from 'vitest'
import {
  podeAprovar,
  podeCancelar,
  podeGerarPublico,
  podePausar,
  podeRetomar,
  resolverPublico,
  resumirSupressoes,
} from './campanha-resumo'
import type { CampanhaDetalhe, DestinatariosAgregado } from '@/types/whatsapp-oficial'

type CampanhaParcial = Pick<
  CampanhaDetalhe,
  'destinatarios_gerados_em' | 'dry_run_em' | 'dry_run_resultado'
>

function campanha(over: Partial<CampanhaParcial> = {}): CampanhaParcial {
  return {
    destinatarios_gerados_em: null,
    dry_run_em: null,
    dry_run_resultado: null,
    ...over,
  }
}

function agregado(over: Partial<DestinatariosAgregado> = {}): DestinatariosAgregado {
  return {
    total: 0,
    truncado: false,
    por_status: {},
    por_motivo_supressao: {},
    ...over,
  }
}

describe('resumirSupressoes', () => {
  it('ordena por contagem decrescente', () => {
    const linhas = resumirSupressoes({ cooldown: 3, optout_lead: 10, duplicado: 5 })
    expect(linhas.map((l) => l.slug)).toEqual(['optout_lead', 'duplicado', 'cooldown'])
  })

  it('desempata pela ordem da cascata da RPC, não pela ordem das chaves', () => {
    // Todos com 1: sem o segundo critério a ordem viria do Object.keys e
    // mudaria entre respostas, fazendo a lista dançar sem nada ter mudado.
    const a = resumirSupressoes({ duplicado: 1, telefone_invalido: 1, cooldown: 1 })
    const b = resumirSupressoes({ cooldown: 1, duplicado: 1, telefone_invalido: 1 })
    expect(a.map((l) => l.slug)).toEqual(['telefone_invalido', 'cooldown', 'duplicado'])
    expect(b.map((l) => l.slug)).toEqual(a.map((l) => l.slug))
  })

  it('joga motivo desconhecido para o fim, mas não o esconde', () => {
    const linhas = resumirSupressoes({ motivo_novo: 1, cooldown: 1 })
    expect(linhas.map((l) => l.slug)).toEqual(['cooldown', 'motivo_novo'])
    expect(linhas[1].rotulo).toBe('motivo_novo')
  })

  it('calcula percentual sobre o total de suprimidos', () => {
    const linhas = resumirSupressoes({ optout_lead: 3, cooldown: 1 })
    expect(linhas[0].percentual).toBe(75)
    expect(linhas[1].percentual).toBe(25)
  })

  it('descarta contagem zero, nula e não numérica', () => {
    const linhas = resumirSupressoes({
      cooldown: 0,
      duplicado: 2,
      optout_lead: Number.NaN,
    } as unknown as Record<string, number>)
    expect(linhas.map((l) => l.slug)).toEqual(['duplicado'])
    // Percentual do único sobrevivente é 100, não 40 — o zero não entra na soma.
    expect(linhas[0].percentual).toBe(100)
  })

  it('aceita ausência de dados sem explodir', () => {
    expect(resumirSupressoes(null)).toEqual([])
    expect(resumirSupressoes(undefined)).toEqual([])
    expect(resumirSupressoes({})).toEqual([])
  })
})

describe('resolverPublico', () => {
  it('sem cálculo nenhum devolve a fonte "nenhuma" zerada', () => {
    const r = resolverPublico(campanha(), agregado())
    expect(r.fonte).toBe('nenhuma')
    expect(r.elegiveis).toBe(0)
    expect(r.suprimidos).toBe(0)
    expect(r.supressoes).toEqual([])
  })

  it('usa o dry-run quando nada foi materializado', () => {
    const r = resolverPublico(
      campanha({
        dry_run_em: '2026-07-25T10:00:00Z',
        dry_run_resultado: {
          elegiveis: 40,
          suprimidos: 10,
          por_motivo: { cooldown: 10 },
          limite_aplicado: 100,
        },
      }),
      agregado(),
    )
    expect(r.fonte).toBe('dry_run')
    expect(r.elegiveis).toBe(40)
    expect(r.suprimidos).toBe(10)
    expect(r.limiteAplicado).toBe(100)
    expect(r.supressoes[0].slug).toBe('cooldown')
  })

  it('CRÍTICO: o público materializado ganha do dry-run antigo', () => {
    // O dry-run pode ser anterior a uma mudança de segmentação. Mostrar 40
    // quando o público gravado tem 8 é o número que faz alguém aprovar a
    // campanha errada.
    const r = resolverPublico(
      campanha({
        destinatarios_gerados_em: '2026-07-25T12:00:00Z',
        dry_run_em: '2026-07-20T10:00:00Z',
        dry_run_resultado: { elegiveis: 40, suprimidos: 10, por_motivo: { cooldown: 10 } },
      }),
      agregado({
        total: 10,
        por_status: { pendente: 8, suprimido: 2 },
        por_motivo_supressao: { duplicado: 2 },
      }),
    )
    expect(r.fonte).toBe('materializado')
    expect(r.elegiveis).toBe(8)
    expect(r.suprimidos).toBe(2)
    expect(r.supressoes.map((l) => l.slug)).toEqual(['duplicado'])
    expect(r.calculadoEm).toBe('2026-07-25T12:00:00Z')
  })

  it('agregado vazio não é tratado como materializado, mesmo com a data gravada', () => {
    // A leitura do agregado passa por RLS e pode devolver 0 linhas. Confiar só
    // no total faria "gravado e todo mundo suprimido" e "não consegui ler"
    // virarem a mesma coisa na tela.
    const r = resolverPublico(
      campanha({
        destinatarios_gerados_em: '2026-07-25T12:00:00Z',
        dry_run_em: '2026-07-25T11:00:00Z',
        dry_run_resultado: { elegiveis: 5, suprimidos: 1, por_motivo: { cooldown: 1 } },
      }),
      agregado({ total: 0 }),
    )
    expect(r.fonte).toBe('dry_run')
    expect(r.elegiveis).toBe(5)
  })

  it('propaga o truncado do agregado', () => {
    const r = resolverPublico(
      campanha({ destinatarios_gerados_em: '2026-07-25T12:00:00Z' }),
      agregado({ total: 20_000, truncado: true, por_status: { pendente: 20_000 } }),
    )
    expect(r.truncado).toBe(true)
    expect(r.elegiveis).toBe(20_000)
  })

  it('aceita dry_run_resultado sem dry_run_em usando o gerado_em interno', () => {
    // A materialização também grava `dry_run_resultado`, mas não mexe em
    // `dry_run_em` — sem este ramo o resumo desapareceria da tela.
    const r = resolverPublico(
      campanha({
        dry_run_resultado: { elegiveis: 3, suprimidos: 0, gerado_em: '2026-07-25T09:00:00Z' },
      }),
      null,
    )
    expect(r.fonte).toBe('dry_run')
    expect(r.calculadoEm).toBe('2026-07-25T09:00:00Z')
  })

  it('trata campos numéricos ausentes como zero em vez de NaN', () => {
    const r = resolverPublico(
      campanha({ dry_run_em: '2026-07-25T10:00:00Z', dry_run_resultado: {} }),
      null,
    )
    expect(r.elegiveis).toBe(0)
    expect(r.suprimidos).toBe(0)
  })
})

describe('gates de ciclo de vida', () => {
  it('só rascunho e aguardando aprovação aceitam gerar público', () => {
    expect(podeGerarPublico('rascunho')).toBe(true)
    expect(podeGerarPublico('aguardando_aprovacao')).toBe(true)
    for (const s of ['aprovado', 'enviando', 'pausado', 'concluido', 'cancelado']) {
      expect(podeGerarPublico(s)).toBe(false)
    }
  })

  it('aprovar exige público JÁ gravado', () => {
    expect(
      podeAprovar({ status: 'rascunho', destinatarios_gerados_em: '2026-07-25T12:00:00Z' }),
    ).toBe(true)
    // Sem público gravado a RPC recusa com `destinatarios_nao_gerados`; o
    // botão habilitado só serviria para produzir um 409.
    expect(podeAprovar({ status: 'rascunho', destinatarios_gerados_em: null })).toBe(false)
    expect(
      podeAprovar({ status: 'aprovado', destinatarios_gerados_em: '2026-07-25T12:00:00Z' }),
    ).toBe(false)
  })

  it('pausar/retomar cobrem estados opostos', () => {
    expect(podePausar('aprovado')).toBe(true)
    expect(podePausar('enviando')).toBe(true)
    expect(podePausar('pausado')).toBe(false)
    expect(podeRetomar('pausado')).toBe(true)
    expect(podeRetomar('enviando')).toBe(false)
  })

  it('cancelar vale em tudo que ainda pode produzir envio', () => {
    for (const s of ['rascunho', 'aguardando_aprovacao', 'aprovado', 'enviando', 'pausado']) {
      expect(podeCancelar(s)).toBe(true)
    }
    expect(podeCancelar('concluido')).toBe(false)
    expect(podeCancelar('cancelado')).toBe(false)
  })
})
