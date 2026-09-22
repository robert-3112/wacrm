import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { contadoresCampanha, dataCampanha } from '@/lib/whatsapp-oficial/campanha-evidencia'
import { rotuloStatusDestinatario } from '@/lib/whatsapp-oficial/gestao-erros'
import type { CampanhaEvidencia } from '@/types/whatsapp-oficial'

export function CampanhaContadores({ resumo, detalhado = false }: {
  resumo: CampanhaEvidencia; detalhado?: boolean
}) {
  const c = contadoresCampanha(resumo)
  return <div className="space-y-2 text-xs text-muted-foreground">
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      <span>Enfileirados (histórico): {resumo.enfileirados}</span>
      <span>Enviados ao provedor: {c.total_enviados}</span>
      <span>Entregues: {c.total_entregues}</span>
      <span>Lidos: {c.total_lidos}</span>
      <span>Falhas: {c.total_falhas}</span>
      <span>Simulados, sem envio: {resumo.por_status.simulado ?? 0}</span>
    </div>
    {detalhado && <>
      <p>Enviados incluem entregues e lidos; entregues incluem lidos. Enfileirar ou simular não comprova envio.</p>
      <div className="flex flex-wrap gap-1.5" aria-label="Situação atual dos destinatários">
        {Object.entries(resumo.por_status).map(([status, total]) =>
          <Badge key={status} variant="outline">{rotuloStatusDestinatario(status)}: {total}</Badge>)}
      </div>
    </>}
    <p>Contadores calculados em <time dateTime={resumo.calculado_em}>{dataCampanha(resumo.calculado_em)}</time></p>
  </div>
}

export function AtualizarCampanhas({ carregando, onAtualizar }: {
  carregando: boolean; onAtualizar: () => void
}) {
  return <Button variant="outline" size="sm" disabled={carregando} onClick={onAtualizar}>
    {carregando ? 'Atualizando…' : 'Atualizar contadores'}
  </Button>
}
