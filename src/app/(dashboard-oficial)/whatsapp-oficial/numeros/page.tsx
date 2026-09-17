import type { Metadata } from 'next';
import { Smartphone, ShieldCheck } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import { fetchCanaisGestao } from '@/lib/whatsapp-oficial/gestao-server';
import { GestaoPage } from '@/components/whatsapp-oficial/gestao-shell';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { statusCanalVariant } from '@/lib/whatsapp-oficial/canal-status';

export const metadata: Metadata = {
  title: 'Números — WhatsHub',
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = 'force-dynamic';

function providerLabel(provider: string): string {
  if (provider === 'meta_cloud') return 'API oficial da Meta';
  if (provider === 'evolution') return 'Evolution';
  return provider;
}

export default async function NumerosPage() {
  const supabase = await createClient();
  const { canais, erro } = await fetchCanaisGestao(supabase);

  return (
    <GestaoPage
      titulo="Números"
      descricao="Os números que a gestão pode operar no WhatsHub."
    >
      {erro ? (
        <Alert variant="destructive">
          <AlertTitle>Não foi possível carregar os números</AlertTitle>
          <AlertDescription>
            Atualize a página. Se o problema continuar, procure a gestão da
            plataforma.
          </AlertDescription>
        </Alert>
      ) : canais.length === 0 ? (
        <Alert>
          <AlertTitle>Nenhum número visível</AlertTitle>
          <AlertDescription>
            Não há números cadastrados ou sua conta ainda não tem acesso à
            gestão dos canais.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="space-y-3">
          <p className="text-muted-foreground text-sm">
            {canais.length === 1
              ? '1 número cadastrado'
              : `${canais.length} números cadastrados`}
          </p>
          <ul className="space-y-3">
            {canais.map((canal) => (
              <li
                key={canal.id}
                className="border-border bg-card flex flex-col gap-4 rounded-2xl border p-5 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-start gap-4">
                  <span className="bg-primary/10 text-primary flex size-11 shrink-0 items-center justify-center rounded-xl">
                    <Smartphone className="size-5" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <h2 className="font-heading text-foreground truncate text-base font-semibold">
                      {canal.nome}
                    </h2>
                    <p className="text-muted-foreground mt-1 text-sm">
                      {canal.numero_display || 'Número não informado'}
                    </p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {providerLabel(canal.provider)}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  {canal.is_default && (
                    <Badge variant="outline">
                      <ShieldCheck className="mr-1 size-3" aria-hidden="true" />
                      Padrão
                    </Badge>
                  )}
                  <Badge variant={statusCanalVariant(canal.status)}>
                    {canal.status === 'ativo'
                      ? 'Cadastro ativo'
                      : canal.status === 'pausado'
                        ? 'Pausado'
                        : canal.status}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </GestaoPage>
  );
}
