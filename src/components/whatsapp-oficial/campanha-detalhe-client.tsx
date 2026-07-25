"use client";

/**
 * Detalhe de uma campanha. É AQUI que a decisão perigosa acontece, então a
 * tela é construída em torno de uma pergunta: quem entra, quem NÃO entra, e
 * por quê — antes de qualquer aprovação.
 *
 * Três regras de UX que espelham travas reais do backend e não são
 * negociáveis:
 *
 *  1. **Simular é o caminho fácil; materializar não é.** O botão primário faz
 *     dry-run. Gravar o público de verdade é outro botão, com confirmação, e
 *     só ele manda `dryRun: false`. A rota já tem o default seguro (qualquer
 *     coisa que não seja literalmente `false` vira dry-run); a tela não pode
 *     ser o lugar onde essa proteção é contornada por conveniência.
 *  2. **Nunca escrever "enviado".** No modo shadow o worker marca o item como
 *     simulado e não chama provider nenhum. "Enfileirado" é a palavra honesta.
 *  3. **Quatro olhos explicado, não vazado.** `aprovador_igual_criador` vira
 *     um bloco que explica a regra, não um toast com o slug cru.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  CheckCircle2,
  Database,
  Loader2,
  Pause,
  Play,
  ShieldQuestion,
  TestTube2,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import {
  acaoCampanha,
  gerarDestinatarios,
  obterCampanha,
  type AcaoCampanha,
} from "@/lib/whatsapp-oficial/gestao-actions";
import {
  descricaoMotivoSupressao,
  rotuloStatusCampanha,
  rotuloStatusDestinatario,
} from "@/lib/whatsapp-oficial/gestao-erros";
import {
  podeAprovar,
  podeCancelar,
  podeGerarPublico,
  podePausar,
  podeRetomar,
  resolverPublico,
  resumirSupressoes,
  type PublicoResolvido,
} from "@/lib/whatsapp-oficial/campanha-resumo";
import { badgeStatusCampanha, TravasSaidaPainel } from "./gestao-shell";
import type {
  CampanhaDetalhe,
  DestinatariosAgregado,
  GerarDestinatariosResultado,
  TravasSaida,
} from "@/types/whatsapp-oficial";

function dataCurta(iso: string | null | undefined): string {
  if (!iso) return "—";
  return format(new Date(iso), "dd/MM/yyyy HH:mm", { locale: ptBR });
}

export function CampanhaDetalheClient({
  campanhaId,
  travas,
}: {
  campanhaId: string;
  travas: TravasSaida;
}) {
  const [campanha, setCampanha] = useState<CampanhaDetalhe | null>(null);
  const [destinatarios, setDestinatarios] = useState<DestinatariosAgregado | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const [simulando, setSimulando] = useState(false);
  const [materializando, setMaterializando] = useState(false);
  const [ultimaSimulacao, setUltimaSimulacao] = useState<GerarDestinatariosResultado | null>(null);
  // Carimbo do momento em que a simulação voltou. Guardado no estado, e não
  // calculado na renderização: um `new Date()` no corpo do componente mostraria
  // "agora" a cada re-render, ou seja, o horário do último clique em qualquer
  // botão da tela em vez do horário do cálculo.
  const [ultimaSimulacaoEm, setUltimaSimulacaoEm] = useState<string | null>(null);
  const [erroPublico, setErroPublico] = useState<string | null>(null);
  const [limite, setLimite] = useState("");

  const [confirmarMaterializar, setConfirmarMaterializar] = useState(false);
  const [acaoEmCurso, setAcaoEmCurso] = useState<AcaoCampanha | null>(null);
  const [erroAcao, setErroAcao] = useState<{ slug: string; mensagem: string } | null>(null);
  const [dialogoMotivo, setDialogoMotivo] = useState<"pausar" | "cancelar" | null>(null);
  const [motivo, setMotivo] = useState("");

  // Sem `setCarregando(true)` no começo, e isso é intencional em dois sentidos.
  // O estado já NASCE carregando, então a primeira ida não precisa dele; e as
  // recargas depois de uma ação (aprovar, gravar público) não devem apagar a
  // tela inteira para pôr um spinner no lugar — o operador acabou de clicar
  // ali, cada botão tem o seu próprio indicador, e ver a página sumir e voltar
  // é pior que ver o número atualizar no lugar. De quebra, nenhum setState
  // roda de forma síncrona dentro do efeito abaixo.
  const carregar = useCallback(async () => {
    const r = await obterCampanha(campanhaId);
    setCarregando(false);
    if (!r.ok) {
      setErro(r.mensagem);
      return;
    }
    setErro(null);
    setCampanha(r.data.campanha);
    setDestinatarios(r.data.destinatarios);
  }, [campanhaId]);

  // Quem está logado, só para AVISAR sobre os quatro olhos antes do clique
  // (ver `souOCriador` abaixo). Mesmo padrão da página da inbox, que resolve o
  // usuário assim para rotular as notas próprias.
  const [usuarioId, setUsuarioId] = useState<string | null>(null);
  useEffect(() => {
    let cancelado = false;
    void (async () => {
      const {
        data: { user },
      } = await createClient().auth.getUser();
      if (!cancelado) setUsuarioId(user?.id ?? null);
    })();
    return () => {
      cancelado = true;
    };
  }, []);

  // IIFE assíncrona em vez de `void carregar()` direto — mesmo formato da
  // página da inbox. O corpo do efeito não pode disparar setState de forma
  // síncrona (`react-hooks/set-state-in-effect`), e `cancelado` evita gravar
  // estado depois que o componente saiu de cena.
  useEffect(() => {
    let cancelado = false;
    void (async () => {
      if (cancelado) return;
      await carregar();
    })();
    return () => {
      cancelado = true;
    };
  }, [carregar]);

  const limiteNumero = (() => {
    const t = limite.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isInteger(n) && n >= 1 ? n : null;
  })();
  const limiteInvalido = limite.trim().length > 0 && limiteNumero === null;

  const handleSimular = async () => {
    setSimulando(true);
    setErroPublico(null);
    const r = await gerarDestinatarios(campanhaId, true, limiteNumero);
    setSimulando(false);
    if (!r.ok) {
      setErroPublico(r.mensagem);
      return;
    }
    setUltimaSimulacao(r.data);
    setUltimaSimulacaoEm(new Date().toISOString());
    toast.success("Simulação concluída. Nenhum destinatário foi gravado.");
    void carregar();
  };

  const handleMaterializar = async () => {
    setConfirmarMaterializar(false);
    setMaterializando(true);
    setErroPublico(null);
    // `false` explícito: é a única chamada do app que materializa público.
    const r = await gerarDestinatarios(campanhaId, false, limiteNumero);
    setMaterializando(false);
    if (!r.ok) {
      setErroPublico(r.mensagem);
      return;
    }
    // Gravou: a simulação anterior perdeu a validade e não pode continuar
    // mandando na tela — o público real é quem responde agora.
    setUltimaSimulacao(null);
    setUltimaSimulacaoEm(null);
    toast.success(
      `Público gravado: ${r.data.linhas_gravadas ?? 0} linha(s). Nada foi enviado — a campanha ainda precisa de aprovação.`,
    );
    void carregar();
  };

  const executarAcao = async (acao: AcaoCampanha, motivoTexto?: string) => {
    setAcaoEmCurso(acao);
    setErroAcao(null);
    const r = await acaoCampanha(campanhaId, acao, motivoTexto);
    setAcaoEmCurso(null);
    if (!r.ok) {
      setErroAcao({ slug: r.slug, mensagem: r.mensagem });
      return;
    }
    setDialogoMotivo(null);
    setMotivo("");
    const feito: Record<AcaoCampanha, string> = {
      aprovar: "Campanha aprovada. O dispatch pode enfileirar lotes — nada sai sem os kill switches.",
      pausar: "Campanha pausada. O dispatch para de enfileirar novos lotes.",
      retomar: "Campanha retomada.",
      cancelar: `Campanha cancelada. ${r.data.itens_cancelados ?? 0} item(ns) pendente(s) cancelado(s).`,
    };
    toast.success(feito[acao]);
    void carregar();
  };

  if (carregando) {
    return (
      <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Carregando campanha...
      </div>
    );
  }

  if (erro || !campanha) {
    return (
      <div className="space-y-4">
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Não foi possível abrir a campanha</AlertTitle>
          <AlertDescription>{erro ?? "Campanha não encontrada."}</AlertDescription>
        </Alert>
        <VoltarParaLista />
      </div>
    );
  }

  const publico = resolverPublico(campanha, destinatarios);
  const gerarLiberado = podeGerarPublico(campanha.status);
  const aprovarLiberado = podeAprovar(campanha);
  // Aviso, NÃO bloqueio. A autoridade dos quatro olhos é a RPC, que compara o
  // ator com `criado_por` — desabilitar o botão por uma comparação feita no
  // navegador transformaria um palpite do cliente em regra, e bastaria
  // `criado_por` significar outra coisa amanhã para travar quem podia aprovar.
  // Avisar antes poupa o clique; recusar continua sendo trabalho do banco.
  const souOCriador = Boolean(usuarioId) && campanha.criado_por === usuarioId;

  return (
    <div className="space-y-5">
      <VoltarParaLista />

      <div className="flex flex-wrap items-center gap-2">
        <h1 className="font-heading text-xl font-semibold text-foreground">{campanha.nome}</h1>
        <Badge variant={badgeStatusCampanha(campanha.status)}>
          {rotuloStatusCampanha(campanha.status)}
        </Badge>
        {campanha.provider && <Badge variant="outline">{campanha.provider}</Badge>}
      </div>

      <TravasSaidaPainel travas={travas} />

      <PainelPublico
        publico={publico}
        campanha={campanha}
        destinatarios={destinatarios}
        ultimaSimulacao={ultimaSimulacao}
        ultimaSimulacaoEm={ultimaSimulacaoEm}
        gerarLiberado={gerarLiberado}
        simulando={simulando}
        materializando={materializando}
        limite={limite}
        limiteInvalido={limiteInvalido}
        erro={erroPublico}
        onLimiteChange={setLimite}
        onSimular={() => void handleSimular()}
        onMaterializar={() => setConfirmarMaterializar(true)}
      />

      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <h2 className="font-heading text-sm font-semibold text-foreground">Ciclo de vida</h2>

        {erroAcao && <ErroDeAcao erro={erroAcao} />}

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={!aprovarLiberado || acaoEmCurso !== null}
            onClick={() => void executarAcao("aprovar")}
          >
            {acaoEmCurso === "aprovar" ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : (
              <CheckCircle2 data-icon="inline-start" />
            )}
            Aprovar
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!podePausar(campanha.status) || acaoEmCurso !== null}
            onClick={() => setDialogoMotivo("pausar")}
          >
            <Pause data-icon="inline-start" />
            Pausar
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!podeRetomar(campanha.status) || acaoEmCurso !== null}
            onClick={() => void executarAcao("retomar")}
          >
            {acaoEmCurso === "retomar" ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : (
              <Play data-icon="inline-start" />
            )}
            Retomar
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={!podeCancelar(campanha.status) || acaoEmCurso !== null}
            onClick={() => setDialogoMotivo("cancelar")}
          >
            <Ban data-icon="inline-start" />
            Cancelar
          </Button>
        </div>

        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <ShieldQuestion className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Aprovação exige <strong className="text-foreground">quatro olhos</strong>: quem criou a
            campanha não pode aprová-la. Aprovar também não envia nada — só libera o dispatch para
            enfileirar lotes na outbox.
            {souOCriador && (
              <>
                {" "}
                <strong className="text-foreground">
                  Esta campanha foi criada por você, então a aprovação será recusada — peça a outra
                  pessoa da gestão.
                </strong>
              </>
            )}
          </span>
        </p>

        {!aprovarLiberado && gerarLiberado && !campanha.destinatarios_gerados_em && (
          <p className="text-xs text-muted-foreground">
            Para aprovar, grave o público antes: uma campanha sem destinatários materializados é
            recusada com <code>destinatarios_nao_gerados</code>.
          </p>
        )}
      </section>

      <FichaTecnica campanha={campanha} />

      <Dialog open={confirmarMaterializar} onOpenChange={setConfirmarMaterializar}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Gravar o público de verdade?</DialogTitle>
            <DialogDescription>
              Isto sai da simulação e ESCREVE os destinatários da campanha na tabela. A partir daí
              o público está fixado — mudar segmentação depois exige gerar de novo, e uma campanha
              já aprovada nem aceita mais isso.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p>
              Último cálculo:{" "}
              <strong className="text-foreground">{publico.elegiveis}</strong> elegível(is) e{" "}
              <strong className="text-foreground">{publico.suprimidos}</strong> suprimido(s).
            </p>
            {limiteNumero !== null && (
              <p className="text-muted-foreground">Limite aplicado: {limiteNumero}.</p>
            )}
            <p className="text-muted-foreground">
              Gravar não envia nada: a campanha continua precisando de aprovação, e o envio ainda
              depende dos kill switches.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmarMaterializar(false)}>
              Voltar
            </Button>
            <Button onClick={() => void handleMaterializar()}>
              <Database data-icon="inline-start" />
              Gravar público
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={dialogoMotivo !== null}
        onOpenChange={(v: boolean) => {
          if (!v) {
            setDialogoMotivo(null);
            setMotivo("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialogoMotivo === "cancelar" ? "Cancelar campanha" : "Pausar campanha"}
            </DialogTitle>
            <DialogDescription>
              {dialogoMotivo === "cancelar"
                ? "Cancelar é definitivo: além de mudar o status, os destinatários que ainda não saíram são cancelados."
                : "Pausar só faz o dispatch parar de enfileirar novos lotes. O que já está na outbox segue o destino que o worker der."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="motivo-acao">Motivo (opcional)</Label>
            <Textarea
              id="motivo-acao"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="Ex.: volume alto de reclamação"
              maxLength={500}
              className="min-h-20"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDialogoMotivo(null);
                setMotivo("");
              }}
            >
              Voltar
            </Button>
            <Button
              variant={dialogoMotivo === "cancelar" ? "destructive" : "default"}
              disabled={acaoEmCurso !== null}
              onClick={() => {
                if (dialogoMotivo) void executarAcao(dialogoMotivo, motivo);
              }}
            >
              {acaoEmCurso !== null && (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              )}
              Confirmar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function VoltarParaLista() {
  return (
    <Link
      href="/whatsapp-oficial/campanhas"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <ArrowLeft className="size-4" />
      Todas as campanhas
    </Link>
  );
}

/** `aprovador_igual_criador` ganha um bloco próprio: é a única recusa que o
 *  operador resolve chamando OUTRA PESSOA, e um toast de três segundos com o
 *  slug cru não comunica isso. */
function ErroDeAcao({ erro }: { erro: { slug: string; mensagem: string } }) {
  const quatroOlhos = erro.slug === "aprovador_igual_criador";
  return (
    <Alert variant={quatroOlhos ? "default" : "destructive"}>
      {quatroOlhos ? <ShieldQuestion /> : <AlertTriangle />}
      <AlertTitle>
        {quatroOlhos ? "Aprovação em quatro olhos" : "A ação não foi concluída"}
      </AlertTitle>
      <AlertDescription>
        {erro.mensagem}
        {quatroOlhos && (
          <p className="mt-1">
            A regra vive no banco, não na tela: a RPC compara o aprovador com{" "}
            <code>criado_por</code> e recusa quando são a mesma pessoa.
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}

function PainelPublico({
  publico,
  campanha,
  destinatarios,
  ultimaSimulacao,
  ultimaSimulacaoEm,
  gerarLiberado,
  simulando,
  materializando,
  limite,
  limiteInvalido,
  erro,
  onLimiteChange,
  onSimular,
  onMaterializar,
}: {
  publico: PublicoResolvido;
  campanha: CampanhaDetalhe;
  destinatarios: DestinatariosAgregado | null;
  ultimaSimulacao: GerarDestinatariosResultado | null;
  ultimaSimulacaoEm: string | null;
  gerarLiberado: boolean;
  simulando: boolean;
  materializando: boolean;
  limite: string;
  limiteInvalido: boolean;
  erro: string | null;
  onLimiteChange: (v: string) => void;
  onSimular: () => void;
  onMaterializar: () => void;
}) {
  // A simulação recém-rodada é mais nova que qualquer coisa recarregada e é a
  // que o operador acabou de pedir — ela manda enquanto estiver na tela.
  const supressoes = ultimaSimulacao
    ? resumirSupressoes(ultimaSimulacao.por_motivo)
    : publico.supressoes;
  const elegiveis = ultimaSimulacao ? ultimaSimulacao.elegiveis : publico.elegiveis;
  const suprimidos = ultimaSimulacao ? ultimaSimulacao.suprimidos : publico.suprimidos;
  const totalAvaliado = elegiveis + suprimidos;
  const fonte = ultimaSimulacao ? "dry_run" : publico.fonte;

  return (
    <section className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-sm font-semibold text-foreground">Público</h2>
        <Badge variant={fonte === "materializado" ? "default" : "secondary"}>
          {fonte === "materializado"
            ? "Gravado"
            : fonte === "dry_run"
              ? "Somente simulado"
              : "Não calculado"}
        </Badge>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-32 space-y-1.5">
          <Label htmlFor="limite-publico" className="text-xs text-muted-foreground">
            Limite (opcional)
          </Label>
          <Input
            id="limite-publico"
            type="number"
            min={1}
            inputMode="numeric"
            value={limite}
            onChange={(e) => onLimiteChange(e.target.value)}
            placeholder="sem limite"
            aria-invalid={limiteInvalido}
          />
        </div>
        <Button size="sm" onClick={onSimular} disabled={!gerarLiberado || simulando || limiteInvalido}>
          {simulando ? (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          ) : (
            <TestTube2 data-icon="inline-start" />
          )}
          Simular público (dry-run)
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onMaterializar}
          disabled={!gerarLiberado || materializando || limiteInvalido}
        >
          {materializando ? (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          ) : (
            <Database data-icon="inline-start" />
          )}
          Gravar público...
        </Button>
      </div>

      {limiteInvalido && (
        <p className="text-xs text-destructive">O limite precisa ser um inteiro maior que zero.</p>
      )}

      <p className="text-xs text-muted-foreground">
        Simular não grava nada — só recalcula quem entraria e por que cada um foi cortado. Gravar
        fixa os destinatários e pede confirmação.
      </p>

      {!gerarLiberado && (
        <p className="text-xs text-muted-foreground">
          Esta campanha está em <strong>{rotuloStatusCampanha(campanha.status)}</strong> e não
          aceita mais gerar público — só rascunho e aguardando aprovação aceitam.
        </p>
      )}

      {erro && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Não foi possível calcular o público</AlertTitle>
          <AlertDescription>{erro}</AlertDescription>
        </Alert>
      )}

      {/* Resultado da geração muda longe do botão e é a informação que decide
          a aprovação — precisa ser anunciado. */}
      <div aria-live="polite">
        {fonte === "nenhuma" ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
            <Users className="mx-auto size-5 text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">
              O público ainda não foi calculado. Rode a simulação para ver quantas pessoas entram e
              quantas são suprimidas.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Cartao rotulo="Entram" valor={elegiveis} destaque />
              <Cartao rotulo="Suprimidos" valor={suprimidos} />
              <Cartao rotulo="Avaliados" valor={totalAvaliado} />
            </div>

            <p className="text-xs text-muted-foreground">
              {fonte === "materializado"
                ? `Público gravado em ${dataCurta(publico.calculadoEm)}.`
                : `Simulação de ${dataCurta(ultimaSimulacaoEm ?? publico.calculadoEm)} — nada foi gravado.`}
              {publico.limiteAplicado != null && ` Limite aplicado: ${publico.limiteAplicado}.`}
              {ultimaSimulacao?.a_enfileirar != null &&
                ` Entrariam na fila: ${ultimaSimulacao.a_enfileirar}.`}
            </p>

            {publico.truncado && (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertTitle>Agregado incompleto</AlertTitle>
                <AlertDescription>
                  A campanha tem mais destinatários do que o teto de leitura desta tela. Os números
                  acima contam só até esse teto — trate-os como piso, não como total.
                </AlertDescription>
              </Alert>
            )}

            {suprimidos > 0 ? (
              <TabelaSupressao supressoes={supressoes} />
            ) : (
              <p className="text-sm text-muted-foreground">Ninguém foi suprimido neste cálculo.</p>
            )}

            {destinatarios && Object.keys(destinatarios.por_status).length > 0 && (
              <div className="space-y-1.5">
                <h3 className="text-xs tracking-wide text-muted-foreground uppercase">
                  Destinatários gravados por situação
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(destinatarios.por_status).map(([st, qtd]) => (
                    <Badge key={st} variant="outline">
                      {rotuloStatusDestinatario(st)}: {qtd}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function Cartao({
  rotulo,
  valor,
  destaque,
}: {
  rotulo: string;
  valor: number;
  destaque?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        destaque ? "border-primary bg-primary/5" : "border-border bg-muted/30",
      )}
    >
      <p className="text-xs tracking-wide text-muted-foreground uppercase">{rotulo}</p>
      <p className="mt-0.5 text-2xl font-semibold text-foreground tabular-nums">{valor}</p>
    </div>
  );
}

function TabelaSupressao({
  supressoes,
}: {
  supressoes: { slug: string; rotulo: string; total: number; percentual: number }[];
}) {
  if (supressoes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Houve supressões, mas o resumo por motivo não veio na resposta.
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      <h3 className="text-xs tracking-wide text-muted-foreground uppercase">
        Por que cada um foi suprimido
      </h3>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {supressoes.map((s) => {
          const descricao = descricaoMotivoSupressao(s.slug);
          return (
            <li key={s.slug} className="flex items-start gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{s.rotulo}</p>
                {descricao && <p className="text-xs text-muted-foreground">{descricao}</p>}
              </div>
              <div className="shrink-0 text-right">
                <p className="text-sm font-semibold text-foreground tabular-nums">{s.total}</p>
                <p className="text-xs text-muted-foreground tabular-nums">{s.percentual}%</p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FichaTecnica({ campanha }: { campanha: CampanhaDetalhe }) {
  const seg = (campanha.segmentacao ?? {}) as Record<string, unknown>;
  const segEntradas = Object.entries(seg).filter(([, v]) =>
    Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && v !== "",
  );

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <h2 className="font-heading text-sm font-semibold text-foreground">Configuração</h2>
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Campo rotulo="Política de consentimento" valor={campanha.politica_consentimento} />
        <Campo
          rotulo="Bases legais"
          valor={campanha.bases_legais?.length ? campanha.bases_legais.join(", ") : null}
        />
        <Campo rotulo="Política de handoff" valor={campanha.politica_handoff} />
        <Campo
          rotulo="Cooldown"
          valor={campanha.cooldown_dias != null ? `${campanha.cooldown_dias} dia(s)` : null}
        />
        <Campo
          rotulo="Cadência"
          valor={campanha.cadencia_segundos != null ? `${campanha.cadencia_segundos}s` : null}
        />
        <Campo rotulo="Lote máximo" valor={campanha.lote_max?.toString() ?? null} />
        <Campo rotulo="Limite diário" valor={campanha.limite_diario?.toString() ?? "sem limite"} />
        <Campo
          rotulo="Janela"
          valor={
            campanha.janela_inicio && campanha.janela_fim
              ? `${campanha.janela_inicio}–${campanha.janela_fim}${
                  campanha.janela_dias?.length ? ` (dias ${campanha.janela_dias.join(", ")})` : ""
                }`
              : null
          }
        />
        <Campo rotulo="Template" valor={campanha.template_id ? "vinculado" : "sem template"} />
        <Campo
          rotulo="Mensagem livre"
          valor={campanha.mensagem_livre ? "definida" : null}
        />
        <Campo rotulo="Criada em" valor={dataCurta(campanha.created_at)} />
        <Campo rotulo="Aprovada em" valor={campanha.aprovado_em ? dataCurta(campanha.aprovado_em) : null} />
        <Campo
          rotulo="Público gravado em"
          valor={campanha.destinatarios_gerados_em ? dataCurta(campanha.destinatarios_gerados_em) : null}
        />
        <Campo
          rotulo="Última simulação"
          valor={campanha.dry_run_em ? dataCurta(campanha.dry_run_em) : null}
        />
        {campanha.motivo_cancelamento && (
          <Campo rotulo="Motivo do cancelamento" valor={campanha.motivo_cancelamento} />
        )}
      </dl>

      <div>
        <p className="text-[10px] tracking-wide text-muted-foreground uppercase">Segmentação</p>
        {segEntradas.length === 0 ? (
          <p className="mt-0.5 text-sm text-muted-foreground">
            Sem filtros — todo lead do tenant é avaliado.
          </p>
        ) : (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {segEntradas.map(([chave, valor]) => (
              <Badge key={chave} variant="outline">
                {chave}: {Array.isArray(valor) ? valor.join(", ") : String(valor)}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function Campo({ rotulo, valor }: { rotulo: string; valor: string | null }) {
  return (
    <div>
      <dt className="text-[10px] tracking-wide text-muted-foreground uppercase">{rotulo}</dt>
      <dd className="mt-0.5 text-foreground">
        {valor ?? <span className="text-muted-foreground">—</span>}
      </dd>
    </div>
  );
}
