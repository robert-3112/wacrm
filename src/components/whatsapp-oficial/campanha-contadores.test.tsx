import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AtualizarCampanhas, CampanhaContadores } from './campanha-contadores'

describe('contadores de campanha', () => {
  it('renderiza evidência, estados exclusivos e horário da consulta', () => {
    const html = renderToStaticMarkup(<CampanhaContadores detalhado resumo={{
      broadcast_id: 'a', calculado_em: '2026-09-22T15:00:00Z', enfileirados: 12, total: 14, truncado: false,
      por_status: { simulado: 5, enviado: 1, entregue: 1, lido: 1, processando: 2, aguardando_retry: 2, inconsistente: 2 },
      por_motivo_supressao: {},
    }} />)
    expect(html).toContain('Enfileirados (histórico): 12')
    expect(html).toContain('Enviados ao provedor: 3')
    expect(html).toContain('Entregues: 2')
    expect(html).toContain('Lidos: 1')
    expect(html).toContain('Simulados, sem envio: 5')
    expect(html).toContain('Processando: 2')
    expect(html).toContain('Aguardando nova tentativa: 2')
    expect(html).toContain('Inconsistente — revisar: 2')
    expect(html).toContain('12:00:00 (Brasília, America/Sao_Paulo)')
    expect(html).toContain('dateTime="2026-09-22T15:00:00Z"')
  })
  it('oferece atualização manual e impede repetição durante carregamento', () => {
    expect(renderToStaticMarkup(<AtualizarCampanhas carregando={false} onAtualizar={() => {}} />)).toContain('Atualizar contadores')
    const html = renderToStaticMarkup(<AtualizarCampanhas carregando onAtualizar={() => {}} />)
    expect(html).toContain('disabled')
    expect(html).toContain('Atualizando')
  })
})
