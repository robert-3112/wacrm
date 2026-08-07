import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { fetchTravasSaida } from "@/lib/whatsapp-oficial/gestao-server";
import { InboxClient } from "@/components/whatsapp-oficial/inbox-client";

/**
 * Caixa de entrada do canal oficial.
 *
 * Server Component fino — mesmo desenho de `templates/page.tsx` e
 * `campanhas/page.tsx`: resolve sessão, lê as travas de saída e entrega o
 * resto a um Client Component.
 *
 * POR QUE ESTA CASCA PASSOU A EXISTIR: a página era `"use client"` inteira e
 * portanto não tinha como ler as travas, que são de servidor. Sem elas o
 * composer não sabia que o envio real estava desligado, e a tela mostrava a
 * bolha roxa de mensagem enviada para algo que o worker apenas marcou como
 * `simulado` — o operador conclui que falou com o cliente e não falou. Foi o
 * que aconteceu no primeiro uso real (2026-08-07).
 *
 * `envioMetaLigado` já combina `WHATSAPP_OUTBOUND_MODE` com a trava do
 * provider, então é a resposta direta para "o que eu digitar aqui chega?".
 */
export const metadata: Metadata = {
  title: "Inbox — canal oficial",
  robots: { index: false, follow: false, nocache: true },
};

export default async function WhatsAppOficialInboxPage() {
  const supabase = await createClient();
  const travas = await fetchTravasSaida(supabase);

  return <InboxClient envioReal={travas.envioMetaLigado} />;
}
