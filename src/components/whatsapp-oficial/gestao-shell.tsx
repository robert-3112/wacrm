/**
 * Peças de moldura compartilhadas pelas telas de gestão (templates e
 * campanhas): o container rolável com cabeçalho, o estado vazio de "nenhum
 * canal" e o painel das travas de saída.
 *
 * Server Components (sem `"use client"`): são puramente apresentacionais e
 * recebem tudo por prop. Só o que tem interação vira cliente.
 *
 * O container existe porque o layout do grupo é `overflow-hidden` (herança da
 * inbox de três painéis, que rola por dentro). Uma página de conteúdo longo
 * solta lá dentro simplesmente NÃO rola — o conteúdo some abaixo da dobra sem
 * barra nenhuma.
 */

import { AlertTriangle, Info, PlugZap, ShieldCheck, ShieldOff } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { TravasSaida } from "@/types/whatsapp-oficial";

/** Só a caixa rolável + a medida de leitura. Para telas que trazem o próprio
 *  cabeçalho (o detalhe de campanha, cujo `<h1>` é o nome da campanha e só
 *  existe depois do fetch). */
export function GestaoContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-5 px-4 py-6 sm:px-6">{children}</div>
    </div>
  );
}

/** Variante do badge de status de campanha. Mora aqui, e não no componente da
 *  lista, porque a tela de detalhe usa a mesma escala — importá-la de
 *  `campanhas-client` arrastaria a lista inteira para o bundle do detalhe só
 *  por causa de um `switch`. */
export function badgeStatusCampanha(
  status: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "aprovado" || status === "enviando") return "default";
  if (status === "cancelado") return "destructive";
  if (status === "pausado" || status === "aguardando_aprovacao") return "secondary";
  return "outline";
}

export function GestaoPage({
  titulo,
  descricao,
  acoes,
  children,
}: {
  titulo: string;
  descricao?: React.ReactNode;
  acoes?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <GestaoContainer>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="font-heading text-xl font-semibold text-foreground">{titulo}</h1>
          {descricao && <p className="text-sm text-muted-foreground">{descricao}</p>}
        </div>
        {acoes && <div className="flex shrink-0 flex-wrap items-center gap-2">{acoes}</div>}
      </div>
      {children}
    </GestaoContainer>
  );
}

/**
 * Estado vazio honesto para "nenhum canal".
 *
 * A RLS de `whatsapp_channels` é `tenant_id + crm_is_gestao()`, então zero
 * linhas tem DUAS causas indistinguíveis daqui — e a tela diz as duas em vez
 * de escolher a mais simpática. Dizer só "nenhum canal cadastrado" para um
 * corretor logado mandaria ele procurar um cadastro que existe e ele não pode
 * ver; dizer só "sem permissão" esconderia o estado real de produção hoje,
 * que é a tabela vazia mesmo.
 */
export function SemCanal({ erro }: { erro?: string | null }) {
  if (erro) {
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>Não foi possível carregar os canais</AlertTitle>
        <AlertDescription>
          {erro} Recarregue a página; se persistir, verifique a conexão com o Supabase.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert>
      <PlugZap />
      <AlertTitle>Nenhum canal disponível</AlertTitle>
      <AlertDescription>
        <p>
          Não há nenhum canal de WhatsApp visível para a sua conta. Isso tem duas causas
          possíveis, e daqui não dá para distinguir:
        </p>
        <ul className="mt-2 ml-4 list-disc space-y-1">
          <li>
            <strong className="text-foreground">Nenhum canal foi cadastrado ainda.</strong> É o
            estado esperado enquanto as credenciais da Meta não chegam — o cadastro do canal é o
            primeiro passo, e templates e campanhas dependem dele.
          </li>
          <li>
            <strong className="text-foreground">Seu usuário não tem papel de gestão.</strong> Só
            owner, admin, gestor e líder enxergam canais; um corretor vê zero linhas mesmo com o
            canal cadastrado.
          </li>
        </ul>
      </AlertDescription>
    </Alert>
  );
}

/** Uma trava: rótulo + estado + o que ela significa quando está desligada. */
function LinhaTrava({
  rotulo,
  ligada,
  detalhe,
}: {
  rotulo: string;
  /** `null` = não foi possível verificar. Nunca é renderizado como "desligada". */
  ligada: boolean | null;
  detalhe: string;
}) {
  const texto = ligada === null ? "Não verificado" : ligada ? "Ligado" : "Desligado";
  return (
    <li className="flex items-start gap-2">
      <Badge
        variant={ligada === null ? "outline" : ligada ? "default" : "secondary"}
        className="mt-0.5 shrink-0"
      >
        {texto}
      </Badge>
      <span className="min-w-0">
        <span className="font-medium text-foreground">{rotulo}</span>{" "}
        <span className="text-muted-foreground">— {detalhe}</span>
      </span>
    </li>
  );
}

/**
 * Painel do estado de saída.
 *
 * A frase que o operador precisa ler PRIMEIRO é "nada é enviado de verdade", e
 * por isso ela é o título quando o modo é shadow — não um rodapé cinza. O
 * backend responde `enfileirado: true` justamente para não deixar ninguém
 * concluir "enviado"; a tela repete a mesma disciplina.
 *
 * `compacto` é para a tela de detalhe, onde o painel divide espaço com a
 * decisão de aprovar: lá vale o aviso curto, com o detalhamento só na lista de
 * travas.
 */
export function TravasSaidaPainel({
  travas,
  className,
}: {
  travas: TravasSaida;
  className?: string;
}) {
  const shadow = travas.modo === "shadow";
  // Broadcast só sai com os DOIS kill switches ligados. `null` (não
  // verificado) conta como não-ligado para efeito de aviso — fail-closed, a
  // mesma disciplina de `readWhatsappFlags`.
  const broadcastLiberado =
    travas.broadcastEnvLigado && travas.broadcastBancoLigado === true;

  return (
    <Alert className={cn("border-border", className)}>
      {shadow ? <ShieldCheck /> : <ShieldOff />}
      <AlertTitle>
        {shadow
          ? "Modo shadow — nada é enviado de verdade"
          : "Modo live — mensagens podem sair para números reais"}
      </AlertTitle>
      <AlertDescription>
        <p>
          {shadow
            ? "Tudo que você enfileirar aqui é simulado pelo worker da outbox: a mensagem é marcada como simulada e nenhum provedor é chamado. Nenhum cliente recebe nada."
            : "O modo de saída está em live. Confira as travas abaixo antes de aprovar qualquer campanha."}
        </p>
        <ul className="mt-3 space-y-1.5 text-xs">
          <LinhaTrava
            rotulo="Kill switch de broadcast (banco)"
            ligada={travas.broadcastBancoLigado}
            detalhe="crm_config.whatsapp_broadcast_enabled, editável pela gestão do CRM."
          />
          <LinhaTrava
            rotulo="Kill switch de broadcast (worker)"
            ligada={travas.broadcastEnvLigado}
            detalhe="Trava de ambiente do worker da outbox, conferida a cada item de campanha."
          />
          <LinhaTrava
            rotulo="Envio real — Meta Cloud"
            ligada={travas.envioMetaLigado}
            detalhe="Combina o modo de saída com a trava do provider."
          />
          <LinhaTrava
            rotulo="Envio real — Evolution"
            ligada={travas.envioEvolutionLigado}
            detalhe="Combina o modo de saída com a trava do provider."
          />
          <LinhaTrava
            rotulo="Modo piloto"
            ligada={travas.pilotoLigado}
            detalhe="Quando ligado, só números da allowlist podem receber envio real."
          />
        </ul>
        {!broadcastLiberado && (
          <p className="mt-3 flex items-start gap-1.5 text-xs">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Campanha só sai com os <strong className="text-foreground">dois</strong> kill
              switches de broadcast ligados. Com qualquer um desligado, os itens ficam parados na
              outbox — aprovar não faz nada chegar a ninguém.
            </span>
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}
