import Link from 'next/link';
import {
  ArrowUpRight,
  Clock3,
  FileText,
  Megaphone,
  MessageSquareText,
  ShieldCheck,
  Smartphone,
  UsersRound,
} from 'lucide-react';
import type { OperationalOverview } from '@/lib/whatsapp-oficial/operations-overview';
import type { TravasSaida } from '@/types/whatsapp-oficial';

function MetricValue({
  value,
  label,
}: {
  value: number | null;
  label: string;
}) {
  return value === null ? (
    <span
      className="text-muted-foreground text-sm font-medium"
      aria-label={`${label}: indisponível`}
    >
      Indisponível
    </span>
  ) : (
    <span
      className="font-heading text-foreground text-3xl font-semibold tabular-nums"
      aria-label={`${label}: ${value}`}
    >
      {value.toLocaleString('pt-BR')}
    </span>
  );
}

function WorkLine({
  label,
  value,
  detail,
}: {
  label: string;
  value: number | null;
  detail: string;
}) {
  return (
    <div className="border-border flex items-center justify-between gap-4 border-b py-4 last:border-b-0">
      <div className="min-w-0">
        <p className="text-foreground text-sm font-semibold">{label}</p>
        <p className="text-muted-foreground mt-0.5 text-xs leading-5">
          {detail}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <MetricValue value={value} label={label} />
      </div>
    </div>
  );
}

const commonLinks = [
  {
    href: '/whatsapp-oficial/inbox',
    label: 'Atendimento',
    Icon: MessageSquareText,
  },
  { href: '/whatsapp-oficial/contatos', label: 'Contatos', Icon: UsersRound },
] as const;

const managementLinks = [
  { href: '/whatsapp-oficial/campanhas', label: 'Campanhas', Icon: Megaphone },
  { href: '/whatsapp-oficial/templates', label: 'Templates', Icon: FileText },
  { href: '/whatsapp-oficial/numeros', label: 'Números', Icon: Smartphone },
] as const;

export function OverviewPanels({
  data,
  travas,
}: {
  data: OperationalOverview;
  travas: TravasSaida | null;
}) {
  const { counts, management } = data;

  return (
    <div className="space-y-9">
      <section
        aria-labelledby="overview-attendance"
        className="border-border bg-card overflow-hidden rounded-3xl border"
      >
        <div className="bg-primary-soft border-border flex flex-col gap-4 border-b px-5 py-6 sm:flex-row sm:items-center sm:justify-between sm:px-7">
          <div>
            <p className="text-primary text-sm font-semibold">
              Seu atendimento
            </p>
            <h2
              id="overview-attendance"
              className="font-heading text-foreground mt-1 text-xl font-semibold tracking-tight sm:text-2xl"
            >
              Conversas que sua conta pode acompanhar
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Contagem exata das conversas visíveis para você.
            </p>
          </div>
          <Link
            href="/whatsapp-oficial/inbox"
            className="bg-primary text-primary-foreground focus-visible:ring-ring inline-flex min-h-10 shrink-0 items-center justify-center gap-2 self-start rounded-xl px-4 text-sm font-semibold hover:opacity-90 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none sm:self-auto"
          >
            Abrir atendimento{' '}
            <ArrowUpRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
        <dl className="grid sm:grid-cols-3">
          {[
            {
              label: 'Aguardando atendimento',
              value: counts.pendentes,
              detail: 'Conversas pendentes',
            },
            {
              label: 'Não lidas',
              value: counts.naoLidas,
              detail: 'Com mensagens novas',
            },
            { label: 'Abertas', value: counts.abertas, detail: 'Em andamento' },
          ].map((item, index) => (
            <div
              key={item.label}
              className={`px-5 py-5 sm:px-7 ${index > 0 ? 'border-border border-t sm:border-t-0 sm:border-l' : ''}`}
            >
              <dt className="text-muted-foreground text-sm">{item.label}</dt>
              <dd className="mt-2">
                <MetricValue value={item.value} label={item.label} />
              </dd>
              <dd className="text-muted-foreground mt-1 text-xs">
                {item.detail}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {management && (
        <section aria-labelledby="overview-management" className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2
                id="overview-management"
                className="font-heading text-foreground text-xl font-semibold tracking-tight"
              >
                Operação da gestão
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">
                Prioridades de campanhas e fila no tenant da sua sessão.
              </p>
            </div>
            <span className="border-border bg-card text-muted-foreground inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs">
              <Clock3 className="size-3.5" aria-hidden="true" /> Atualizado ao
              abrir a página
            </span>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)]">
            <div className="border-border bg-card rounded-2xl border px-5 py-5 sm:px-6">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-foreground font-semibold">
                  O que pede atenção
                </h3>
                <Megaphone className="text-primary size-5" aria-hidden="true" />
              </div>
              <div className="mt-2">
                <WorkLine
                  label="Aguardando aprovação"
                  value={management.campaigns.awaitingApproval}
                  detail="Campanhas que precisam de uma segunda pessoa."
                />
                <WorkLine
                  label="Falhas para revisar"
                  value={management.outbox.failed}
                  detail="Itens para nova tentativa; entrega não confirmada."
                />
                <WorkLine
                  label="Intervenção necessária"
                  value={management.outbox.dead}
                  detail="Itens sem nova tentativa automática."
                />
                <WorkLine
                  label="Campanhas pausadas"
                  value={management.campaigns.paused}
                  detail="Permanecem sem novos lotes até a retomada."
                />
              </div>
              <Link
                href="/whatsapp-oficial/campanhas"
                className="text-primary focus-visible:ring-ring mt-4 inline-flex items-center gap-1 rounded text-sm font-semibold hover:underline focus-visible:ring-2 focus-visible:outline-none"
              >
                Abrir campanhas e escolher o filtro{' '}
                <ArrowUpRight className="size-4" aria-hidden="true" />
              </Link>
            </div>

            <div className="space-y-4">
              <div className="border-border bg-card rounded-2xl border px-5 py-5 sm:px-6">
                <h3 className="text-foreground flex items-center gap-2 font-semibold">
                  <ShieldCheck
                    className="text-primary size-5"
                    aria-hidden="true"
                  />{' '}
                  Estado de saída
                </h3>
                <p className="text-foreground mt-4 text-lg font-semibold">
                  {travas === null
                    ? 'Não verificado'
                    : travas.modo === 'shadow'
                      ? 'Envios simulados'
                      : 'Envio real configurado'}
                </p>
                <p className="text-muted-foreground mt-1 text-sm leading-6">
                  {travas === null
                    ? 'Não foi possível confirmar as travas de saída nesta leitura.'
                    : travas.modo === 'shadow'
                      ? 'A fila pode ser processada em simulação. Nenhum item simulado é uma entrega.'
                      : 'Mensagens podem sair para números reais quando as demais travas permitirem.'}
                </p>
                {travas && (
                  <ul className="border-border text-muted-foreground mt-4 space-y-1.5 border-t pt-3 text-xs">
                    <li>
                      Meta Cloud:{' '}
                      {travas.envioMetaLigado ? 'habilitado' : 'bloqueado'}
                    </li>
                    <li>
                      Evolution:{' '}
                      {travas.envioEvolutionLigado ? 'habilitado' : 'bloqueado'}
                    </li>
                    <li>
                      Campanhas no worker:{' '}
                      {travas.broadcastEnvLigado ? 'liberadas' : 'bloqueadas'}
                    </li>
                    <li>
                      Campanhas no banco:{' '}
                      {travas.broadcastBancoLigado === null
                        ? 'não verificadas'
                        : travas.broadcastBancoLigado
                          ? 'liberadas'
                          : 'bloqueadas'}
                    </li>
                  </ul>
                )}
              </div>
              <div className="border-border bg-card rounded-2xl border px-5 py-5 sm:px-6">
                <h3 className="text-foreground font-semibold">
                  Números cadastrados
                </h3>
                <div className="mt-3 flex items-baseline gap-2">
                  <MetricValue
                    value={management.channels.active}
                    label="Números ativos no cadastro"
                  />
                  <span className="text-muted-foreground text-sm">
                    ativos de{' '}
                    {management.channels.total === null
                      ? 'total indisponível'
                      : management.channels.total.toLocaleString('pt-BR')}
                  </span>
                </div>
                <p className="text-muted-foreground mt-1 text-xs leading-5">
                  Ativo no cadastro não confirma conexão com o provedor.
                </p>
                <Link
                  href="/whatsapp-oficial/numeros"
                  className="text-primary focus-visible:ring-ring mt-3 inline-flex items-center gap-1 rounded text-sm font-semibold hover:underline focus-visible:ring-2 focus-visible:outline-none"
                >
                  Gerir números{' '}
                  <ArrowUpRight className="size-4" aria-hidden="true" />
                </Link>
              </div>
            </div>
          </div>

          <div className="border-border bg-card rounded-2xl border px-5 py-4 sm:px-6">
            <h3 className="text-foreground text-sm font-semibold">
              Fluxo da fila
            </h3>
            <dl className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="text-muted-foreground text-xs">
                  Aguardando processamento
                </dt>
                <dd className="mt-1">
                  <MetricValue
                    value={management.outbox.pending}
                    label="Aguardando processamento"
                  />
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">
                  Em processamento
                </dt>
                <dd className="mt-1">
                  <MetricValue
                    value={management.outbox.processing}
                    label="Em processamento"
                  />
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">
                  Simulados, sem entrega
                </dt>
                <dd className="mt-1">
                  <MetricValue
                    value={management.outbox.simulated}
                    label="Simulados, sem entrega"
                  />
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">
                  Campanhas aprovadas ou enfileirando
                </dt>
                <dd className="mt-1">
                  <MetricValue
                    value={management.campaigns.inProgress}
                    label="Campanhas aprovadas ou enfileirando"
                  />
                </dd>
              </div>
            </dl>
            <p className="text-muted-foreground mt-3 text-xs">
              Estar na fila ou aprovado não comprova envio nem entrega ao
              destinatário.
            </p>
          </div>
        </section>
      )}

      <nav aria-label="Acessos rápidos" className="border-border border-t pt-6">
        <h2 className="text-foreground mb-3 text-sm font-semibold">Ir para</h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {[...commonLinks, ...(management ? managementLinks : [])].map(
            ({ href, label, Icon }) => (
              <Link
                key={href}
                href={href}
                className="border-border bg-card text-foreground focus-visible:ring-ring hover:bg-muted/60 flex min-h-12 items-center gap-3 rounded-xl border px-4 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
              >
                <Icon className="text-primary size-4" aria-hidden="true" />
                <span className="flex-1">{label}</span>
                <ArrowUpRight
                  className="text-muted-foreground size-4"
                  aria-hidden="true"
                />
              </Link>
            )
          )}
        </div>
      </nav>
    </div>
  );
}
