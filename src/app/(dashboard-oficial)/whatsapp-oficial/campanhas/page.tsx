import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { fetchCanaisGestao, fetchTravasSaida } from "@/lib/whatsapp-oficial/gestao-server";
import { GestaoPage, SemCanal, TravasSaidaPainel } from "@/components/whatsapp-oficial/gestao-shell";
import { CampanhasClient } from "@/components/whatsapp-oficial/campanhas-client";

/**
 * Lista de campanhas do canal oficial + criação de rascunho.
 *
 * Mesmo desenho da tela de templates: Server Component resolve canais e
 * travas, o Client Component cuida da interação. Criar campanha aqui não
 * resolve público nem envia nada — as duas coisas moram na tela de detalhe,
 * atrás de dry-run e de aprovação em quatro olhos.
 */
export const metadata: Metadata = {
  title: "Campanhas — canal oficial",
  robots: { index: false, follow: false, nocache: true },
};

export default async function CampanhasPage() {
  const supabase = await createClient();
  const { canais, erro } = await fetchCanaisGestao(supabase);

  if (erro || canais.length === 0) {
    return (
      <GestaoPage titulo="Campanhas" descricao="Disparos em massa pelo canal oficial.">
        <SemCanal erro={erro} />
      </GestaoPage>
    );
  }

  const travas = await fetchTravasSaida(supabase);

  return (
    <GestaoPage
      titulo="Campanhas"
      descricao="Cada campanha nasce como rascunho. O público é simulado antes de ser gravado, e a aprovação exige uma segunda pessoa."
    >
      <TravasSaidaPainel travas={travas} />
      <CampanhasClient canais={canais} />
    </GestaoPage>
  );
}
