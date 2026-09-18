import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { OverviewPanels } from './overview-panels';
import type { OperationalOverview } from '@/lib/whatsapp-oficial/operations-overview';
import type { TravasSaida } from '@/types/whatsapp-oficial';

const counts: OperationalOverview['counts'] = {
  abertas: 12,
  pendentes: 4,
  naoLidas: 2,
};

const travas: TravasSaida = {
  modo: 'shadow',
  broadcastEnvLigado: false,
  broadcastBancoLigado: false,
  envioMetaLigado: false,
  envioEvolutionLigado: false,
  pilotoLigado: true,
};

describe('OverviewPanels', () => {
  it('does not expose management queue counts or actions to a broker', () => {
    const html = renderToStaticMarkup(
      <OverviewPanels data={{ counts, management: null }} travas={null} />
    );
    expect(html).toContain('Aguardando atendimento');
    expect(html).toContain('Abrir atendimento');
    expect(html).not.toContain('Aguardando aprovação');
    expect(html).not.toContain('whatsapp-oficial/numeros');
  });

  it('shows unavailable data honestly and never calls a queued item delivered', () => {
    const html = renderToStaticMarkup(
      <OverviewPanels
        data={{
          counts,
          management: {
            campaigns: { awaitingApproval: 2, inProgress: 1, paused: 0 },
            channels: { total: 2, active: 1 },
            outbox: {
              pending: null,
              processing: 1,
              failed: 3,
              dead: 0,
              simulated: 7,
            },
          },
        }}
        travas={travas}
      />
    );
    expect(html).toContain('Indisponível');
    expect(html).toContain('Envios simulados');
    expect(html).toContain('Aguardando aprovação');
    expect(html).toContain('Falhas para revisar');
    expect(html).toContain('Simulados, sem entrega');
    expect(html).toContain('Meta Cloud: bloqueado');
    expect(html).toContain('Evolution: bloqueado');
    expect(html).toContain('Campanhas no worker: bloqueadas');
    expect(html).not.toContain('Entregues');
  });
});
