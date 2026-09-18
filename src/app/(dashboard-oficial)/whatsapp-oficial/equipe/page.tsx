import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  UserRound,
  UsersRound,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { createClient } from '@/lib/supabase/server';
import {
  EQUIPE_PAGE_SIZE,
  fetchEquipe,
  parseEquipeQuery,
  type EquipeFiltro,
  type EquipeMembro,
} from '@/lib/whatsapp-oficial/equipe-data';

export const metadata: Metadata = {
  title: 'Equipe — WhatsHub',
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = 'force-dynamic';

const filtros: { value: EquipeFiltro; label: string }[] = [
  { value: 'todos', label: 'Todos' },
  { value: 'ativos', label: 'Ativos' },
  { value: 'inativos', label: 'Inativos' },
];

function pageHref(filtro: EquipeFiltro, page = 1): string {
  const params = new URLSearchParams();
  if (filtro !== 'todos') params.set('filtro', filtro);
  if (page > 1) params.set('page', String(page));
  const suffix = params.toString();
  return `/whatsapp-oficial/equipe${suffix ? `?${suffix}` : ''}`;
}

function accessRoleLabel(role: unknown): string {
  const labels: Record<string, string> = {
    owner: 'Proprietário',
    admin: 'Administrador',
    gestor: 'Gestor',
    lider: 'Líder',
    corretor: 'Corretor',
    viewer: 'Leitura',
  };
  return typeof role === 'string'
    ? (labels[role] ?? 'Não identificado')
    : 'Não identificado';
}

export default async function EquipePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = parseEquipeQuery(await searchParams);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [resultado, papelAcesso] = await Promise.all([
    fetchEquipe(supabase, user.id, query),
    supabase.rpc('current_user_role'),
  ]);
  const totalPages = Math.max(1, Math.ceil(resultado.total / EQUIPE_PAGE_SIZE));

  return (
    <div className="bg-background h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6 lg:py-8">
        <div className="border-border flex flex-wrap items-end justify-between gap-4 border-b pb-6">
          <div className="space-y-2">
            <p className="text-primary flex items-center gap-2 text-xs font-semibold tracking-widest uppercase">
              <UsersRound className="size-4" aria-hidden="true" /> WhatsHub /
              Operação
            </p>
            <h1 className="text-foreground text-3xl font-semibold tracking-tight">
              Equipe
            </h1>
            <p className="text-muted-foreground max-w-2xl text-sm leading-6">
              Pessoas cadastradas no CRM e visíveis para sua conta. O status
              indica cadastro e escala; não indica conexão ou disponibilidade no
              WhatsApp.
            </p>
          </div>
          <div className="border-border bg-card rounded-xl border px-4 py-3 text-sm shadow-sm">
            <span className="text-muted-foreground block text-xs">
              Seu papel de acesso
            </span>
            <strong className="text-foreground font-medium">
              {papelAcesso.error
                ? 'Indisponível'
                : accessRoleLabel(papelAcesso.data)}
            </strong>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4">
          <nav
            aria-label="Filtrar membros da equipe"
            className="border-border bg-card inline-flex flex-wrap gap-1 rounded-xl border p-1"
          >
            {filtros.map((filtro) => (
              <Link
                key={filtro.value}
                href={pageHref(filtro.value)}
                aria-current={
                  query.filtro === filtro.value ? 'page' : undefined
                }
                className={cn(
                  'focus-visible:ring-ring rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none',
                  query.filtro === filtro.value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                {filtro.label}
              </Link>
            ))}
          </nav>
          {!resultado.erro && (
            <p className="text-muted-foreground text-sm">
              <strong className="text-foreground font-semibold">
                {resultado.total.toLocaleString('pt-BR')}
              </strong>{' '}
              {resultado.total === 1 ? 'pessoa visível' : 'pessoas visíveis'}
            </p>
          )}
        </div>

        {resultado.erro ? (
          <StateCard
            icon={<AlertCircle className="size-6" />}
            title="Não foi possível carregar a equipe"
            description="A consulta falhou. Atualize a página para tentar novamente; nenhum cadastro foi alterado."
          />
        ) : resultado.total === 0 ? (
          <StateCard
            icon={<UsersRound className="size-6" />}
            title="Nenhum membro visível"
            description={
              query.filtro === 'todos'
                ? 'Não há corretores liberados para sua conta neste tenant.'
                : 'Nenhuma pessoa corresponde a este filtro. Tente outra situação cadastral.'
            }
          />
        ) : resultado.membros.length === 0 ? (
          <div className="space-y-3">
            <StateCard
              icon={<UsersRound className="size-6" />}
              title="Esta página está vazia"
              description="A lista mudou desde a última consulta. Volte à primeira página para conferir os membros atuais."
            />
            <Link
              href={pageHref(query.filtro)}
              className={buttonVariants({ variant: 'outline' })}
            >
              Voltar ao início
            </Link>
          </div>
        ) : (
          <section aria-label="Membros da equipe" className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              {resultado.membros.map((membro) => (
                <MemberCard key={membro.id} membro={membro} />
              ))}
            </div>
            <nav
              aria-label="Páginas da equipe"
              className="flex items-center justify-between gap-3 pb-4"
            >
              {query.page > 1 ? (
                <Link
                  href={pageHref(query.filtro, query.page - 1)}
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
              <span className="text-muted-foreground text-xs">
                Página {query.page} de {totalPages}
              </span>
              {query.page < totalPages ? (
                <Link
                  href={pageHref(query.filtro, query.page + 1)}
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

function MemberCard({ membro }: { membro: EquipeMembro }) {
  return (
    <article className="border-border bg-card flex min-w-0 flex-col gap-4 rounded-2xl border p-5 shadow-sm">
      <div className="flex min-w-0 items-start gap-3">
        <span
          aria-hidden="true"
          className="bg-primary/10 text-primary flex size-11 shrink-0 items-center justify-center rounded-xl"
        >
          <UserRound className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2
            className="text-foreground truncate text-base font-semibold"
            title={membro.nome}
          >
            {membro.nome}
            {membro.proprio ? ' · Você' : ''}
          </h2>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Função no CRM:{' '}
            {membro.papel === 'gestor'
              ? 'Gestor'
              : membro.papel === 'corretor'
                ? 'Corretor'
                : 'Não identificada'}
          </p>
        </div>
        <Badge
          variant={
            membro.ativo === true
              ? 'default'
              : membro.ativo === false
                ? 'secondary'
                : 'outline'
          }
        >
          {membro.ativo === true
            ? 'Cadastro ativo'
            : membro.ativo === false
              ? 'Cadastro inativo'
              : 'Situação não informada'}
        </Badge>
      </div>
      <div className="border-border grid gap-3 border-t pt-4 text-sm sm:grid-cols-2">
        <div>
          <span className="text-muted-foreground block text-xs">Escala</span>
          <span className="text-foreground font-medium">
            {membro.emPlantao ? 'Plantão marcado' : 'Fora do plantão'}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground block text-xs">
            Vínculo de usuário
          </span>
          <span className="text-foreground font-medium">
            {membro.contaVinculada
              ? 'Usuário vinculado'
              : 'Sem usuário vinculado'}
          </span>
        </div>
        <div className="sm:col-span-2">
          <span className="text-muted-foreground block text-xs">Carteira</span>
          <span className="text-foreground font-medium">
            {!membro.podeVerCarteira
              ? 'Restrita ao corretor e à gestão'
              : membro.carteira === null
                ? 'Contagem indisponível'
                : `${membro.carteira.toLocaleString('pt-BR')} ${membro.carteira === 1 ? 'lead atribuído' : 'leads atribuídos'}`}
          </span>
        </div>
      </div>
    </article>
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
    <div className="border-border bg-card/70 flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-12 text-center">
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
