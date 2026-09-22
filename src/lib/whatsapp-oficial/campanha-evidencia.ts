import type { SupabaseClient } from '@supabase/supabase-js'
import type { CampanhaEvidencia, DestinatariosAgregado } from '@/types/whatsapp-oficial'

/** Cada recipient tem um único motivo. A RPC pode classificá-lo como cancelado
 * (ou inconsistente) sem perder esse motivo; não somar novamente os estados. */
export function contarSupressoes(resumo: Pick<DestinatariosAgregado, 'por_motivo_supressao'>) {
  return Object.values(resumo.por_motivo_supressao).reduce((total, n) => total + n, 0)
}

export function contadoresCampanha(resumo: CampanhaEvidencia) {
  const s = resumo.por_status
  return {
    total_destinatarios: resumo.total,
    total_suprimidos: contarSupressoes(resumo),
    total_enviados: (s.enviado ?? 0) + (s.entregue ?? 0) + (s.lido ?? 0),
    total_entregues: (s.entregue ?? 0) + (s.lido ?? 0),
    total_lidos: s.lido ?? 0,
    total_falhas: s.falhou ?? 0,
  }
}

const contagem = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
const mapaContagens = (v: unknown): v is Record<string, number> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(contagem)

/** Recebe SOMENTE linhas já autorizadas pelo SELECT com sessão; nunca IDs do request. */
export async function carregarResumoCampanhas<T extends { id: string; tenant_id: string }>(
  admin: Pick<SupabaseClient, 'rpc'>,
  campanhas: T[],
) {
  if (campanhas.length > 100) throw new Error('Limite de resumos excedido')
  const porTenant = new Map<string, string[]>()
  for (const c of campanhas) {
    if (!c.id || !c.tenant_id) throw new Error('Campanha sem escopo para resumo')
    porTenant.set(c.tenant_id, [...(porTenant.get(c.tenant_id) ?? []), c.id])
  }
  const resumos = new Map<string, CampanhaEvidencia>()
  for (const [tenant, ids] of porTenant) {
    const { data, error } = await admin.rpc('whatsapp_oficial_campanhas_resumo', {
      p_tenant_id: tenant,
      p_broadcast_ids: ids,
    })
    if (error) throw error
    if (!Array.isArray(data) || data.length !== ids.length) throw new Error('Resumo de campanhas incompleto')
    for (const row of data) {
      if (!row || !ids.includes(row.broadcast_id) || resumos.has(row.broadcast_id) ||
        typeof row.calculado_em !== 'string' || !Number.isFinite(Date.parse(row.calculado_em)) ||
        !contagem(row.total) || !contagem(row.enfileirados) || row.enfileirados > row.total ||
        !mapaContagens(row.por_status) || !mapaContagens(row.por_motivo_supressao) ||
        contarSupressoes(row) > row.total ||
        Object.values(row.por_status).reduce((sum: number, n) => sum + Number(n), 0) !== row.total) {
        throw new Error('Resumo de campanhas inválido')
      }
      resumos.set(row.broadcast_id, { ...row, truncado: false })
    }
  }
  return campanhas.map((c) => {
    const resumo = resumos.get(c.id)
    if (!resumo) throw new Error('Resumo de campanha ausente')
    return { ...c, ...contadoresCampanha(resumo), resumo }
  })
}

export function dataCampanha(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short', timeStyle: 'medium', timeZone: 'America/Sao_Paulo',
  }).format(new Date(iso)) + ' (Brasília, America/Sao_Paulo)'
}
