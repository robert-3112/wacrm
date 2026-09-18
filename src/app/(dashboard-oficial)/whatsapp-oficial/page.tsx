import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertCircle, RotateCcw } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/whatsapp-oficial/supabase-admin';
import { fetchTravasSaida } from '@/lib/whatsapp-oficial/gestao-server';
import { loadOperationalOverview } from '@/lib/whatsapp-oficial/operations-overview';
import { OverviewPanels } from '@/components/whatsapp-oficial/overview-panels';
import type { TravasSaida } from '@/types/whatsapp-oficial';

export const metadata: Metadata = {
  title: 'Visão geral — WhatsHub',
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = 'force-dynamic';

export default async function WhatsHubOverviewPage() {
  const supabase = await createClient();
  let data: Awaited<ReturnType<typeof loadOperationalOverview>> | null = null;
  let travas: TravasSaida | null = null;

  try {
    data = await loadOperationalOverview(supabase, supabaseAdmin);
    if (data.management) {
      try {
        travas = await fetchTravasSaida(supabase);
      } catch (error) {
        console.error(
          '[whatsapp-oficial/overview] outbound controls unavailable:',
          error instanceof Error ? error.message : error
        );
      }
    }
  } catch (error) {
    console.error(
      '[whatsapp-oficial/overview] overview unavailable:',
      error instanceof Error ? error.message : error
    );
  }

  return (
    <div className="bg-background h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-4 py-7 sm:px-6 sm:py-9 lg:py-11">
        <header className="border-border mb-7 border-b pb-6">
          <p className="text-primary text-sm font-semibold">WhatsHub · SUNT</p>
          <h1 className="font-heading text-foreground mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
            Visão geral da operação
          </h1>
          <p className="text-muted-foreground mt-2 max-w-2xl text-sm leading-6 sm:text-base">
            Acompanhe o atendimento e, quando tiver acesso de gestão, as
            decisões de campanha e o estado da fila.
          </p>
        </header>

        {data ? (
          <OverviewPanels data={data} travas={travas} />
        ) : (
          <div
            role="alert"
            className="border-destructive/40 bg-card rounded-2xl border p-6"
          >
            <AlertCircle
              className="text-destructive size-6"
              aria-hidden="true"
            />
            <h2 className="text-foreground mt-3 text-lg font-semibold">
              Indicadores indisponíveis
            </h2>
            <p className="text-muted-foreground mt-1 max-w-xl text-sm leading-6">
              Não foi possível confirmar sua sessão e consultar os indicadores
              agora. Nenhum número foi estimado.
            </p>
            <div className="mt-5 flex flex-wrap gap-4 text-sm font-semibold">
              <a
                href="/whatsapp-oficial"
                className="text-primary focus-visible:ring-ring inline-flex items-center gap-2 rounded hover:underline focus-visible:ring-2 focus-visible:outline-none"
              >
                <RotateCcw className="size-4" aria-hidden="true" /> Tentar
                novamente
              </a>
              <Link
                href="/whatsapp-oficial/inbox"
                className="text-foreground focus-visible:ring-ring rounded hover:underline focus-visible:ring-2 focus-visible:outline-none"
              >
                Abrir atendimento
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
