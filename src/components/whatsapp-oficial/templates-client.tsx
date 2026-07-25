"use client";

/**
 * Catálogo de templates de um canal: filtros, sincronização com a Meta e
 * preview.
 *
 * A tela responde uma pergunta que hoje só o banco responde — "o que eu posso
 * mandar agora?". Daí o destaque de `aprovado` (o ÚNICO status que a RPC de
 * enfileiramento aceita) e o realce dos status quebrados
 * (rejeitado/pausado/desabilitado), que são os que fazem um envio falhar sem
 * o operador entender o motivo.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { listarTemplates, sincronizarTemplates } from "@/lib/whatsapp-oficial/gestao-actions";
import {
  rotuloStatusTemplate,
  templateEmAlerta,
  templatePodeEnviar,
} from "@/lib/whatsapp-oficial/gestao-erros";
import { CanalPicker } from "./canal-picker";
import { TemplatePreviewPanel } from "./template-preview-panel";
import type {
  TemplateSyncResultado,
  WhatsAppCanal,
  WhatsAppTemplate,
} from "@/types/whatsapp-oficial";

const STATUS_FILTRO = [
  { value: "todos", label: "Todos os status" },
  { value: "aprovado", label: "Aprovados" },
  { value: "pendente", label: "Em análise" },
  { value: "rejeitado", label: "Rejeitados" },
  { value: "pausado", label: "Pausados" },
  { value: "desabilitado", label: "Desabilitados" },
  { value: "em_apelacao", label: "Em apelação" },
  { value: "exclusao_pendente", label: "Exclusão pendente" },
  { value: "rascunho", label: "Rascunhos" },
] as const;

function badgeStatus(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "aprovado") return "default";
  if (status === "rejeitado" || status === "desabilitado") return "destructive";
  if (status === "pausado") return "secondary";
  return "outline";
}

function badgeQualidade(score: string | null): "default" | "secondary" | "destructive" | null {
  if (!score) return null;
  const s = score.toUpperCase();
  if (s === "GREEN") return "default";
  if (s === "YELLOW") return "secondary";
  if (s === "RED") return "destructive";
  return null;
}

export function TemplatesClient({ canais }: { canais: WhatsAppCanal[] }) {
  const [canalId, setCanalId] = useState(canais[0]?.id ?? "");
  const [status, setStatus] = useState<string>("todos");
  const [busca, setBusca] = useState("");
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [selecionadoId, setSelecionadoId] = useState<string | null>(null);
  const [sincronizando, setSincronizando] = useState(false);
  const [resultadoSync, setResultadoSync] = useState<TemplateSyncResultado | null>(null);
  const [erroSync, setErroSync] = useState<string | null>(null);

  const canal = useMemo(() => canais.find((c) => c.id === canalId) ?? null, [canais, canalId]);
  const abortRef = useRef<AbortController | null>(null);

  const carregar = useCallback(async (id: string, filtroStatus: string) => {
    if (!id) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setCarregando(true);
    setErro(null);
    try {
      const r = await listarTemplates({ canalId: id, status: filtroStatus }, controller.signal);
      if (controller.signal.aborted) return;
      if (!r.ok) {
        setErro(r.mensagem);
        setTemplates([]);
      } else {
        setTemplates(r.data.templates ?? []);
      }
    } catch {
      return; // abort — troca de canal/filtro
    } finally {
      if (!controller.signal.aborted) setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar(canalId, status);
  }, [canalId, status, carregar]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // O template escolhido pertence ao canal: trocar de canal tem de zerar a
  // seleção, senão o preview segue mostrando um template que sumiu da lista.
  useEffect(() => {
    setSelecionadoId(null);
    setResultadoSync(null);
    setErroSync(null);
  }, [canalId]);

  const filtrados = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter(
      (t) =>
        t.nome.toLowerCase().includes(q) ||
        (t.corpo_texto ?? "").toLowerCase().includes(q) ||
        (t.categoria ?? "").toLowerCase().includes(q),
    );
  }, [templates, busca]);

  const selecionado = useMemo(
    () => templates.find((t) => t.id === selecionadoId) ?? null,
    [templates, selecionadoId],
  );

  const podeSincronizar = canal?.provider === "meta_cloud";

  const handleSync = async () => {
    if (!canalId) return;
    setSincronizando(true);
    setResultadoSync(null);
    setErroSync(null);
    const r = await sincronizarTemplates(canalId);
    setSincronizando(false);
    if (!r.ok) {
      // `detalhe` é o texto que a rota monta para credencial/provider — mais
      // específico que a tradução do slug, então ele ganha quando existe.
      const detalhe = typeof r.detalhes.detalhe === "string" ? r.detalhes.detalhe : null;
      setErroSync(detalhe ?? r.mensagem);
      return;
    }
    setResultadoSync(r.data);
    toast.success("Catálogo sincronizado com a Meta.");
    void carregar(canalId, status);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CanalPicker canais={canais} canalId={canalId} onChange={setCanalId} />
        <Button size="sm" onClick={() => void handleSync()} disabled={sincronizando || !podeSincronizar}>
          {sincronizando ? (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          ) : (
            <RefreshCw data-icon="inline-start" />
          )}
          Sincronizar com a Meta
        </Button>
      </div>

      {!podeSincronizar && canal && (
        <p className="text-xs text-muted-foreground">
          Só canais <code>meta_cloud</code> têm catálogo aprovado na Meta para sincronizar. Este
          canal usa <code>{canal.provider}</code>.
        </p>
      )}

      {/* `aria-live` para o resultado do sync: ele aparece longe do botão que
          o disparou e é a única confirmação de uma ação que pode ter mexido em
          centenas de linhas. */}
      <div aria-live="polite" className="empty:hidden">
        {erroSync && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>A sincronização falhou</AlertTitle>
            <AlertDescription>
              {erroSync} Nenhum template foi alterado — o sync não faz commit parcial.
            </AlertDescription>
          </Alert>
        )}
        {resultadoSync && <ResultadoSync resultado={resultadoSync} />}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1 space-y-1.5">
          <Label htmlFor="busca-template" className="text-xs text-muted-foreground">
            Buscar
          </Label>
          <div className="relative">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="busca-template"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Nome, texto do corpo ou categoria..."
              className="pl-9"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="filtro-status" className="text-xs text-muted-foreground">
            Status
          </Label>
          <Select value={status} onValueChange={(v) => v && setStatus(String(v))}>
            <SelectTrigger id="filtro-status" className="min-w-44">
              <SelectValue>
                {(v: string | null) =>
                  STATUS_FILTRO.find((s) => s.value === v)?.label ?? "Todos os status"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTRO.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {carregando ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Carregando catálogo...
        </div>
      ) : erro ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Não foi possível carregar o catálogo</AlertTitle>
          <AlertDescription>{erro}</AlertDescription>
        </Alert>
      ) : filtrados.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {templates.length === 0
              ? "Nenhum template neste canal ainda. Sincronize com a Meta para trazer o catálogo aprovado."
              : "Nenhum template corresponde à busca ou ao filtro."}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <ul className="space-y-2">
            {filtrados.map((t) => (
              <li key={t.id}>
                <TemplateCard
                  template={t}
                  selecionado={t.id === selecionadoId}
                  onSelect={() => setSelecionadoId(t.id)}
                />
              </li>
            ))}
          </ul>
          <div className="lg:sticky lg:top-0 lg:self-start">
            <TemplatePreviewPanel template={selecionado} />
          </div>
        </div>
      )}
    </div>
  );
}

function ResultadoSync({ resultado }: { resultado: TemplateSyncResultado }) {
  return (
    <Alert variant={resultado.truncado ? "destructive" : "default"}>
      {resultado.truncado ? <AlertTriangle /> : <CheckCircle2 />}
      <AlertTitle>
        {resultado.truncado
          ? "Sincronizado, mas o catálogo veio INCOMPLETO"
          : "Catálogo sincronizado"}
      </AlertTitle>
      <AlertDescription>
        <p>
          {resultado.total} template{resultado.total === 1 ? "" : "s"} lido
          {resultado.total === 1 ? "" : "s"} da Meta — {resultado.inseridos} novo
          {resultado.inseridos === 1 ? "" : "s"}, {resultado.atualizados} atualizado
          {resultado.atualizados === 1 ? "" : "s"}, {resultado.inalterados} sem mudança
          {resultado.ignorados > 0 && `, ${resultado.ignorados} ignorado(s) por falta de nome ou idioma`}
          .
        </p>
        {resultado.truncado && (
          <p className="mt-2 font-medium text-destructive">
            {resultado.aviso ??
              "A Meta ainda tinha mais páginas depois do teto do sync. O que passou desse teto NÃO foi sincronizado e pode aparecer desatualizado ou ausente no catálogo."}
          </p>
        )}
        {resultado.erros.length > 0 && (
          <p className="mt-2">
            {resultado.erros.length} linha(s) com erro durante a gravação — verifique o log do
            servidor.
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}

function TemplateCard({
  template,
  selecionado,
  onSelect,
}: {
  template: WhatsAppTemplate;
  selecionado: boolean;
  onSelect: () => void;
}) {
  const enviavel = templatePodeEnviar(template.status_aprovacao);
  const alerta = templateEmAlerta(template.status_aprovacao);
  const qualidade = badgeQualidade(template.quality_score);
  const totalVariaveis =
    (template.variaveis?.cabecalho.length ?? 0) + (template.variaveis?.corpo.length ?? 0);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selecionado}
      className={cn(
        "w-full rounded-lg border bg-card p-3 text-left transition-colors hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
        selecionado ? "border-primary" : "border-border",
        // Borda esquerda grossa: é o sinal que se lê varrendo a lista, antes
        // de qualquer badge. Verde = pode mandar, vermelho = quebrado.
        enviavel && "border-l-4 border-l-primary",
        alerta && "border-l-4 border-l-destructive",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">{template.nome}</span>
        <Badge variant={badgeStatus(template.status_aprovacao)}>
          {rotuloStatusTemplate(template.status_aprovacao)}
        </Badge>
        {!enviavel && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <CircleSlash className="size-3" />
            não pode ser enviado
          </span>
        )}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Badge variant="outline">{template.idioma}</Badge>
        {template.categoria && <Badge variant="outline">{template.categoria}</Badge>}
        {qualidade && (
          <Badge variant={qualidade}>Qualidade {template.quality_score}</Badge>
        )}
        {!template.quality_score && <span>Qualidade não informada</span>}
        <span>·</span>
        <span>
          {totalVariaveis === 0
            ? "sem variáveis"
            : `${totalVariaveis} variável${totalVariaveis === 1 ? "" : "eis"}`}
        </span>
        {(template.variaveis?.botoes.length ?? 0) > 0 && (
          <>
            <span>·</span>
            <span>{template.variaveis?.botoes.length} botão(ões)</span>
          </>
        )}
      </div>

      {template.corpo_texto && (
        <p className="mt-2 line-clamp-2 text-xs break-words whitespace-pre-wrap text-muted-foreground">
          {template.corpo_texto}
        </p>
      )}

      {template.motivo_rejeicao && (
        <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          <strong>Motivo da rejeição:</strong> {template.motivo_rejeicao}
        </p>
      )}

      <p className="mt-2 text-[10px] text-muted-foreground">
        {template.sincronizado_em
          ? `Sincronizado em ${format(new Date(template.sincronizado_em), "dd/MM/yyyy HH:mm", { locale: ptBR })}`
          : "Nunca sincronizado"}
      </p>
    </button>
  );
}
