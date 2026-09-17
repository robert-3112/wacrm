import type { Metadata } from 'next';
import Link from 'next/link';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  MessageCircle,
  Search,
  UsersRound,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { createClient } from '@/lib/supabase/server';
import {
  CONTACT_PAGE_SIZE,
  fetchHubContacts,
  parseContactListQuery,
  type ContactListQuery,
} from '@/lib/whatsapp-oficial/contatos-data';

export const metadata: Metadata = {
  title: 'Contatos — WhatsHub',
  robots: { index: false, follow: false, nocache: true },
};

function crmHref(leadId: string): string | null {
  const template = process.env.NEXT_PUBLIC_SUNT_CRM_LEAD_URL;
  const destination = template?.includes('{leadId}')
    ? template.replace('{leadId}', encodeURIComponent(leadId))
    : process.env.NEXT_PUBLIC_SUNT_CRM_URL;
  if (!destination) return null;
  try {
    const url = new URL(destination);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function pageHref(query: ContactListQuery, page: number): string {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.visao !== 'todos') params.set('visao', query.visao);
  if (page > 1) params.set('page', String(page));
  const suffix = params.toString();
  return `/whatsapp-oficial/contatos${suffix ? `?${suffix}` : ''}`;
}

export default async function ContatosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = parseContactListQuery(await searchParams);
  const supabase = await createClient();
  const result = query.buscaInvalida
    ? { contatos: [], total: 0, erro: null }
    : await fetchHubContacts(supabase, query);
  const totalPages = Math.max(1, Math.ceil(result.total / CONTACT_PAGE_SIZE));

  return (
    <div className="bg-background h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:py-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <div className="text-primary flex items-center gap-2 text-xs font-semibold tracking-widest uppercase">
              <UsersRound className="size-4" aria-hidden="true" />
              WhatsHub / Relacionamento
            </div>
            <h1 className="text-foreground text-3xl font-semibold tracking-tight">
              Contatos
            </h1>
            <p className="text-muted-foreground max-w-2xl text-sm">
              Leads do CRM que sua conta pode acessar. Busque, filtre e
              acompanhe o responsável por cada contato.
            </p>
          </div>
          <Link
            href="/whatsapp-oficial/inbox"
            className={cn(buttonVariants({ variant: 'outline' }), 'gap-2')}
          >
            <MessageCircle className="size-4" aria-hidden="true" />
            Ir para conversas
          </Link>
        </div>

        <form
          action="/whatsapp-oficial/contatos"
          method="get"
          className="border-border bg-card flex flex-col gap-3 rounded-2xl border p-4 shadow-sm sm:flex-row sm:items-end"
        >
          <div className="min-w-0 flex-1 space-y-1.5">
            <label
              htmlFor="contatos-busca"
              className="text-foreground text-xs font-medium"
            >
              Nome ou telefone
            </label>
            <Input
              id="contatos-busca"
              name="q"
              type="search"
              defaultValue={query.q}
              maxLength={80}
              placeholder="Busque um nome ou número"
            />
          </div>
          <div className="space-y-1.5 sm:w-48">
            <label
              htmlFor="contatos-visao"
              className="text-foreground text-xs font-medium"
            >
              Mostrar
            </label>
            <select
              id="contatos-visao"
              name="visao"
              defaultValue={query.visao}
              className="border-input bg-background text-foreground focus-visible:ring-ring/50 h-8 w-full rounded-lg border px-2.5 text-sm focus-visible:ring-3 focus-visible:outline-none"
            >
              <option value="todos">Todos</option>
              <option value="sem_corretor">Sem corretor</option>
              <option value="urgentes">Urgentes</option>
            </select>
          </div>
          <Button type="submit" className="gap-2">
            <Search className="size-4" aria-hidden="true" />
            Buscar
          </Button>
        </form>

        {query.buscaInvalida ? (
          <StateCard
            icon={<Search className="size-6" />}
            title="Busca inválida"
            description="Digite pelo menos uma letra ou um número para pesquisar."
          />
        ) : result.erro ? (
          <StateCard
            icon={<AlertCircle className="size-6" />}
            title="Não foi possível carregar os contatos"
            description="Houve uma falha na consulta. Atualize a página e tente novamente; nenhum dado foi alterado."
          />
        ) : result.total === 0 ? (
          <StateCard
            icon={<UsersRound className="size-6" />}
            title={
              query.q || query.visao !== 'todos'
                ? 'Nenhum contato encontrado'
                : 'Nenhum contato visível'
            }
            description={
              query.q || query.visao !== 'todos'
                ? 'Ajuste a busca ou os filtros. Você só vê os contatos liberados para sua conta.'
                : 'Ainda não há contatos liberados para sua conta neste tenant.'
            }
          />
        ) : result.contatos.length === 0 ? (
          <div className="border-border bg-card rounded-2xl border p-8 text-center">
            <p className="font-medium">Esta página não contém contatos.</p>
            <Link
              href={pageHref(query, 1)}
              className="text-primary mt-2 inline-block text-sm underline-offset-4 hover:underline"
            >
              Voltar ao início
            </Link>
          </div>
        ) : (
          <section aria-label="Lista de contatos" className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <p className="text-muted-foreground text-sm">
                <strong className="text-foreground font-semibold">
                  {result.total.toLocaleString('pt-BR')}
                </strong>{' '}
                {result.total === 1 ? 'contato visível' : 'contatos visíveis'}
              </p>
              <p className="text-muted-foreground text-xs">
                Página {query.page} de {totalPages}
              </p>
            </div>

            <div className="border-border bg-card overflow-hidden rounded-2xl border shadow-sm">
              {result.contatos.map((contato) => {
                const crmUrl = crmHref(contato.id);
                return (
                  <article
                    key={contato.id}
                    className="border-border hover:bg-muted/30 grid gap-4 border-b p-4 last:border-b-0 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto] sm:items-center sm:px-5"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span
                        aria-hidden="true"
                        className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
                      >
                        {contato.nome.slice(0, 1).toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <h2 className="text-foreground truncate text-sm font-semibold">
                          {contato.nome}
                        </h2>
                        <p className="text-muted-foreground truncate text-xs">
                          {contato.telefone ?? 'Telefone não informado'}
                        </p>
                        {contato.email && (
                          <p className="text-muted-foreground truncate text-xs">
                            {contato.email}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {contato.urgente && (
                        <Badge variant="destructive">Urgente</Badge>
                      )}
                      {contato.etapa && (
                        <Badge variant="secondary">{contato.etapa}</Badge>
                      )}
                      {contato.temperatura && (
                        <Badge variant="outline">{contato.temperatura}</Badge>
                      )}
                      <Badge variant="outline">
                        {contato.corretorNome ??
                          (contato.temCorretor
                            ? 'Com corretor'
                            : 'Sem corretor')}
                      </Badge>
                      {contato.cidade && (
                        <span className="text-muted-foreground ml-1 text-xs">
                          {contato.cidade}
                        </span>
                      )}
                    </div>
                    <div className="sm:text-right">
                      {crmUrl ? (
                        <a
                          href={crmUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary inline-flex items-center gap-1 text-sm font-medium underline-offset-4 hover:underline focus-visible:underline"
                        >
                          Abrir no CRM{' '}
                          <ExternalLink
                            className="size-3.5"
                            aria-hidden="true"
                          />
                        </a>
                      ) : (
                        <span className="text-muted-foreground text-xs">
                          Ficha do CRM indisponível
                        </span>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>

            <nav
              aria-label="Páginas de contatos"
              className="flex items-center justify-between gap-3 pb-4"
            >
              {query.page > 1 ? (
                <Link
                  href={pageHref(query, query.page - 1)}
                  className={cn(
                    buttonVariants({ variant: 'outline' }),
                    'gap-2'
                  )}
                >
                  <ArrowLeft className="size-4" aria-hidden="true" /> Anterior
                </Link>
              ) : (
                <span />
              )}
              {query.page < totalPages && query.page < 10_000 ? (
                <Link
                  href={pageHref(query, query.page + 1)}
                  className={cn(
                    buttonVariants({ variant: 'outline' }),
                    'gap-2'
                  )}
                >
                  Próxima <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
              ) : (
                <span />
              )}
            </nav>
          </section>
        )}
      </div>
    </div>
  );
}

function StateCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="border-border bg-card/70 flex min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-12 text-center">
      <div className="bg-muted text-muted-foreground mb-4 flex size-14 items-center justify-center rounded-2xl">
        {icon}
      </div>
      <h2 className="text-foreground text-base font-semibold">{title}</h2>
      <p className="text-muted-foreground mt-2 max-w-md text-sm">
        {description}
      </p>
    </div>
  );
}
