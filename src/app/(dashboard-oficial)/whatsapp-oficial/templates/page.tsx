import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { fetchCanaisGestao, fetchTravasSaida } from "@/lib/whatsapp-oficial/gestao-server";
import { GestaoPage, SemCanal, TravasSaidaPainel } from "@/components/whatsapp-oficial/gestao-shell";
import { TemplatesClient } from "@/components/whatsapp-oficial/templates-client";

/**
 * Catálogo de templates do canal oficial.
 *
 * Server Component fino, no mesmo espírito da inbox: resolve sessão e canais,
 * e entrega o resto a um Client Component. A autenticação já foi feita pelo
 * layout do grupo — aqui a leitura de canais roda com o cliente COM SESSÃO,
 * então a RLS de `whatsapp_channels` é a autorização (nenhuma rota nova foi
 * criada para isso; ver `gestao-server.ts`).
 *
 * As travas de saída só são detalhadas quando existe canal visível. Zero
 * canais significa (também) "não é gestão", e o estado das travas de envio não
 * é informação que uma conta sem papel precise ler.
 */
export const metadata: Metadata = {
  title: "Templates — canal oficial",
  robots: { index: false, follow: false, nocache: true },
};

export default async function TemplatesPage() {
  const supabase = await createClient();
  const { canais, erro } = await fetchCanaisGestao(supabase);

  if (erro || canais.length === 0) {
    return (
      <GestaoPage
        titulo="Templates"
        descricao="Catálogo de templates aprovados na Meta, por canal."
      >
        <SemCanal erro={erro} />
      </GestaoPage>
    );
  }

  const travas = await fetchTravasSaida(supabase);

  return (
    <GestaoPage
      titulo="Templates"
      descricao="Catálogo sincronizado da Meta. Só templates aprovados podem ser enviados — o resto está aqui para você saber por que não pode."
    >
      <TravasSaidaPainel travas={travas} />
      <TemplatesClient canais={canais} />
    </GestaoPage>
  );
}
