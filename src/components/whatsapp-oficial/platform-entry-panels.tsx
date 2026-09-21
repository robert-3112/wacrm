import Link from 'next/link';
import { GestaoPage, TravasSaidaPainel } from './gestao-shell';
import type {
  SettingsEntry,
  SophiaEntry,
} from '@/lib/whatsapp-oficial/platform-entry-data';

const linkClass =
  'inline-flex min-h-11 items-center rounded text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const roles: Record<string, string> = {
  owner: 'Proprietário',
  admin: 'Administrador',
  gestor: 'Gestor',
  lider: 'Líder',
  corretor: 'Corretor',
  viewer: 'Consulta',
};

function EntryUnavailable({
  href,
  description = 'Não foi possível confirmar sua sessão e consultar os dados agora. Nenhum valor foi estimado.',
}: {
  href: string;
  description?: string;
}) {
  return (
    <div
      role="alert"
      className="border-destructive/40 bg-card rounded-xl border p-5"
    >
      <h2 className="font-semibold">Dados indisponíveis</h2>
      <p className="text-muted-foreground mt-2 text-sm">{description}</p>
      <a href={href} className={linkClass}>
        Tentar novamente
      </a>
    </div>
  );
}

export function SophiaEntryPanel({ data }: { data: SophiaEntry | null }) {
  return (
    <GestaoPage
      titulo="Sophia"
      descricao="Consulte o estado da Sophia nas conversas abertas ou pendentes visíveis para sua conta."
    >
      {data ? (
        <>
          <dl className="grid gap-4 sm:grid-cols-2">
            {(
              [
                ['Conversas com Sophia habilitada', data.counts.enabled],
                ['Conversas com Sophia desligada', data.counts.disabled],
              ] as const
            ).map(([label, count]) => (
              <div key={label} className="bg-card rounded-xl border p-5">
                <dt className="text-muted-foreground text-sm">{label}</dt>
                <dd className="mt-2 text-2xl font-semibold">
                  {count === null ? 'Indisponível' : count}
                </dd>
              </div>
            ))}
          </dl>
          {(data.counts.enabled === null || data.counts.disabled === null) && (
            <EntryUnavailable
              href="/whatsapp-oficial/sophia"
              description="Não foi possível consultar todas as contagens de conversas. Os valores indisponíveis não foram estimados."
            />
          )}
          <p className="text-muted-foreground text-sm">
            Habilitada significa que a conversa permite atuação da Sophia. Esse
            estado não comprova que a IA está executando agora. Desligada não
            confirma a presença de um atendente.
          </p>
        </>
      ) : (
        <EntryUnavailable href="/whatsapp-oficial/sophia" />
      )}
      <div className="bg-card rounded-xl border p-5">
        <h2 className="font-semibold">Controle por conversa</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Abra o atendimento, selecione uma conversa e consulte o controle da
          Sophia quando disponível para o canal.
        </p>
        <Link className={linkClass} href="/whatsapp-oficial/inbox">
          Abrir atendimento
        </Link>
      </div>
    </GestaoPage>
  );
}

export function SettingsEntryPanel({ data }: { data: SettingsEntry | null }) {
  return (
    <GestaoPage
      titulo="Configurações"
      descricao="Consulte seu acesso e as configurações operacionais disponíveis para sua conta."
    >
      {data ? (
        <>
          <dl className="bg-card rounded-xl border p-5">
            <dt className="text-muted-foreground text-sm">Conta</dt>
            <dd className="break-all">
              {data.scope.userEmail ?? 'Email indisponível'}
            </dd>
            <dt className="text-muted-foreground mt-3 text-sm">Papel</dt>
            <dd>{roles[data.scope.role] ?? 'Papel não reconhecido'}</dd>
          </dl>
          {data.scope.isManagement ? (
            <>
              {data.travas ? (
                <TravasSaidaPainel travas={data.travas} />
              ) : (
                <EntryUnavailable
                  href="/whatsapp-oficial/configuracoes"
                  description="Não foi possível consultar o diagnóstico de envio agora. As travas permanecem não verificadas."
                />
              )}
              <nav
                aria-label="Operações de configuração"
                className="flex flex-wrap gap-4"
              >
                <Link className={linkClass} href="/whatsapp-oficial/numeros">
                  Números e conexões
                </Link>
                <Link className={linkClass} href="/whatsapp-oficial/equipe">
                  Equipe
                </Link>
                <Link className={linkClass} href="/whatsapp-oficial/templates">
                  Templates
                </Link>
                <Link className={linkClass} href="/whatsapp-oficial/campanhas">
                  Campanhas
                </Link>
              </nav>
            </>
          ) : (
            <p className="text-muted-foreground text-sm">
              O diagnóstico de envio e as configurações de gestão não estão
              disponíveis para seu papel.
            </p>
          )}
        </>
      ) : (
        <EntryUnavailable href="/whatsapp-oficial/configuracoes" />
      )}
      <Link className={linkClass} href="/whatsapp-oficial/inbox">
        Abrir atendimento
      </Link>
    </GestaoPage>
  );
}
