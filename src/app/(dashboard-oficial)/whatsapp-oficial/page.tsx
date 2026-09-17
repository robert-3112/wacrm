import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowUpRight,
  MessagesSquare,
  UsersRound,
  Megaphone,
  RotateCcw,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import { loadOverviewCounts } from '@/lib/whatsapp-oficial/overview-data';

export const metadata: Metadata = {
  title: 'Visão geral — WhatsHub',
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = 'force-dynamic';

const destinations = [
  {
    href: '/whatsapp-oficial/inbox',
    label: 'Abrir atendimento',
    description: 'Conversas e respostas',
    Icon: MessagesSquare,
  },
  {
    href: '/whatsapp-oficial/contatos',
    label: 'Ver contatos',
    description: 'Pessoas da sua carteira',
    Icon: UsersRound,
  },
  {
    href: '/whatsapp-oficial/campanhas',
    label: 'Gerir campanhas',
    description: 'Públicos, envios e resultados',
    Icon: Megaphone,
  },
] as const;

export default async function WhatsHubOverviewPage() {
  const supabase = await createClient();
  let counts: Awaited<ReturnType<typeof loadOverviewCounts>> | null = null;
  try {
    counts = await loadOverviewCounts(supabase);
  } catch (error) {
    console.error(
      '[whatsapp-oficial/overview] count failed:',
      error instanceof Error ? error.message : error
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-10">
        <div className="border-border border-b pb-7">
          <p className="text-primary mb-3 text-sm font-medium">
            WhatsHub · SUNT
          </p>
          <h1 className="font-heading text-foreground max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
            Sua operação, em um só lugar.
          </h1>
          <p className="text-muted-foreground mt-3 max-w-2xl text-sm leading-6 sm:text-base">
            Acompanhe as conversas que você pode atender e siga para a próxima
            ação.
          </p>
        </div>

        <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1.45fr)_minmax(280px,1fr)]">
          <section aria-labelledby="overview-work-title" className="min-w-0">
            <div className="mb-4 flex items-baseline justify-between gap-3">
              <h2
                id="overview-work-title"
                className="font-heading text-foreground text-lg font-semibold"
              >
                Conversas da sua carteira
              </h2>
              <span className="text-muted-foreground text-xs">
                Dados visíveis para sua conta
              </span>
            </div>

            {counts ? (
              <div className="border-border bg-card overflow-hidden rounded-2xl border">
                <MetricRow
                  label="Abertas"
                  description="Em andamento"
                  value={counts.abertas}
                />
                <MetricRow
                  label="Pendentes"
                  description="Aguardando atendimento"
                  value={counts.pendentes}
                />
                <MetricRow
                  label="Não lidas"
                  description="Conversas com mensagens novas"
                  value={counts.naoLidas}
                  last
                />
              </div>
            ) : (
              <div
                role="alert"
                className="border-destructive/30 bg-card rounded-2xl border p-6"
              >
                <p className="text-foreground font-medium">
                  Os indicadores não puderam ser carregados.
                </p>
                <p className="text-muted-foreground mt-1 text-sm">
                  As conversas continuam acessíveis no atendimento.
                </p>
                <a
                  href="/whatsapp-oficial"
                  className="text-primary mt-4 inline-flex items-center gap-2 text-sm font-medium underline-offset-4 hover:underline"
                >
                  <RotateCcw className="size-4" aria-hidden="true" /> Atualizar
                  indicadores
                </a>
              </div>
            )}
          </section>

          <section aria-labelledby="overview-next-title" className="min-w-0">
            <h2
              id="overview-next-title"
              className="font-heading text-foreground mb-4 text-lg font-semibold"
            >
              Onde você precisa ir
            </h2>
            <div className="border-border bg-card overflow-hidden rounded-2xl border">
              {destinations.map(({ href, label, description, Icon }, index) => (
                <Link
                  key={href}
                  href={href}
                  className={`group hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-ring flex items-center gap-4 px-5 py-4 transition-colors focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset ${index < destinations.length - 1 ? 'border-border border-b' : ''}`}
                >
                  <span className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-xl">
                    <Icon className="size-5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-foreground block text-sm font-semibold">
                      {label}
                    </span>
                    <span className="text-muted-foreground block text-xs">
                      {description}
                    </span>
                  </span>
                  <ArrowUpRight
                    className="text-muted-foreground group-hover:text-foreground size-4 shrink-0 transition-colors"
                    aria-hidden="true"
                  />
                </Link>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function MetricRow({
  label,
  description,
  value,
  last = false,
}: {
  label: string;
  description: string;
  value: number;
  last?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-4 px-5 py-5 sm:px-6 ${last ? '' : 'border-border border-b'}`}
    >
      <div>
        <p className="text-foreground text-sm font-semibold">{label}</p>
        <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>
      </div>
      <span
        className="font-heading text-foreground min-w-12 text-right text-3xl font-semibold tabular-nums"
        aria-label={`${value} ${label.toLowerCase()}`}
      >
        {value.toLocaleString('pt-BR')}
      </span>
    </div>
  );
}
