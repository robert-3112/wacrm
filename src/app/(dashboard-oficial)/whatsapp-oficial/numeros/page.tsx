import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { fetchCanaisGestao, fetchTravasSaida } from '@/lib/whatsapp-oficial/gestao-server';
import { GestaoPage, TravasSaidaPainel } from '@/components/whatsapp-oficial/gestao-shell';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { NumerosClient } from '@/components/whatsapp-oficial/numeros-client';

export const metadata: Metadata = {
  title: 'Números — WhatsHub',
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = 'force-dynamic';

export default async function NumerosPage() {
  const supabase = await createClient();
  const { canais, erro } = await fetchCanaisGestao(supabase);
  const { data: podeGerir, error: roleError } = await supabase.rpc('crm_is_admin_gestor');
  const travas = canais.length > 0 ? await fetchTravasSaida(supabase) : null;

  return (
    <GestaoPage
      titulo="Números"
      descricao="Conecte, confira e controle cada número de forma independente."
    >
      {erro ? (
        <Alert variant="destructive">
          <AlertTitle>Não foi possível carregar os números</AlertTitle>
          <AlertDescription>
            Atualize a página. Se o problema continuar, procure a gestão da
            plataforma.
          </AlertDescription>
        </Alert>
      ) : (
        <>
          {travas && <TravasSaidaPainel travas={travas} />}
          <NumerosClient canais={canais} podeGerir={!roleError && podeGerir === true}
            evolutionDisponivel={Boolean(process.env.EVOLUTION_API_URL)} />
        </>
      )}
    </GestaoPage>
  );
}
