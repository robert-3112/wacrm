import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { fetchTravasSaida } from "@/lib/whatsapp-oficial/gestao-server";
import { GestaoContainer } from "@/components/whatsapp-oficial/gestao-shell";
import { CampanhaDetalheClient } from "@/components/whatsapp-oficial/campanha-detalhe-client";

/**
 * Detalhe de uma campanha.
 *
 * O detalhe em si é buscado no cliente (`GET /api/whatsapp-oficial/campanhas/[id]`)
 * e não aqui: a mesma resposta precisa ser RECARREGADA depois de cada ação
 * (simular, gravar público, aprovar, pausar), e uma leitura de servidor
 * obrigaria um round-trip de navegação a cada clique. O servidor resolve só o
 * que não muda com a interação — o estado das travas de saída.
 *
 * Nada de `titulo` dinâmico com o nome da campanha: ele viria de uma segunda
 * leitura no servidor, e o nome já aparece no cabeçalho assim que o detalhe
 * carrega.
 */
export const metadata: Metadata = {
  title: "Campanha — canal oficial",
  robots: { index: false, follow: false, nocache: true },
};

export default async function CampanhaDetalhePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const travas = await fetchTravasSaida(supabase);

  return (
    <GestaoContainer>
      <CampanhaDetalheClient campanhaId={id} travas={travas} />
    </GestaoContainer>
  );
}
