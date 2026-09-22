import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SophiaEntryPanel, SettingsEntryPanel } from './platform-entry-panels';

describe('platform entry panels', () => {
  it('distinguishes an unavailable count from a verified zero and explains the flag', () => {
    const html = renderToStaticMarkup(
      <SophiaEntryPanel data={{ counts: { enabled: null, disabled: 0 } }} />
    );
    expect(html).toContain('Indisponível');
    expect(html).toContain('Conversas com Sophia desligada');
    expect(html).toContain('>0</dd>');
    expect(html).toContain('Tentar novamente');
    expect(html).toContain('não comprova que a IA está executando');
    expect(html).not.toContain('aria-pressed');
  });

  it('does not expose management diagnostics or tenant to a broker', () => {
    const html = renderToStaticMarkup(
      <SettingsEntryPanel
        data={{
          scope: {
            tenantId: 'tenant-1',
            role: 'corretor',
            userEmail: null,
            isManagement: false,
          },
          travas: null,
        }}
      />
    );
    expect(html).toContain('Email indisponível');
    expect(html).toContain('Corretor');
    expect(html).toContain('não estão disponíveis');
    expect(html).not.toContain('Kill switch');
    expect(html).not.toContain('tenant-1');
    expect(html).not.toContain('Operações de configuração');
  });

  it('renders unavailable context without fabricated values', () => {
    for (const panel of [
      <SettingsEntryPanel key="settings" data={null} />,
      <SophiaEntryPanel key="sophia" data={null} />,
    ]) {
      const html = renderToStaticMarkup(panel);
      expect(html).toContain('Dados indisponíveis');
      expect(html).toContain('Tentar novamente');
      expect(html).not.toContain('>0<');
      expect(html).not.toContain('Kill switch');
    }
  });

  it('keeps management settings links when the diagnostic is unavailable', () => {
    const html = renderToStaticMarkup(
      <SettingsEntryPanel
        data={{
          scope: {
            tenantId: 'tenant-1',
            role: 'gestor',
            userEmail: 'manager@example.invalid',
            isManagement: true,
          },
          travas: null,
        }}
      />
    );
    expect(html).toContain('manager@example.invalid');
    expect(html).toContain('Gestor');
    expect(html).toContain('Dados indisponíveis');
    expect(html).toContain('Operações de configuração');
    expect(html).not.toContain('tenant-1');
    expect(html).not.toContain('Kill switch');
  });

  it('keeps unknown switch distinct from off in the existing management panel', () => {
    const html = renderToStaticMarkup(
      <SettingsEntryPanel
        data={{
          scope: {
            tenantId: 'tenant-1',
            role: 'gestor',
            userEmail: null,
            isManagement: true,
          },
          travas: {
            modo: 'shadow',
            broadcastEnvLigado: false,
            broadcastBancoLigado: null,
            envioMetaLigado: false,
            envioEvolutionLigado: false,
            pilotoLigado: true,
          },
        }}
      />
    );
    expect(html).toContain('Não verificado');
    expect(html).toContain('Liberação de campanhas na gestão');
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('tenant-1');
  });
});
