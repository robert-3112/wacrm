"use client";

/**
 * Lista de campanhas do canal + criação.
 *
 * A lista NÃO mostra "enviados" como sinônimo de "entregues": as colunas de
 * contagem que a rota devolve contam itens que passaram pelo worker, e no modo
 * shadow eles foram simulados. Por isso o rótulo é "enfileirados" — a mesma
 * disciplina de vocabulário que a rota de envio aplica ao responder
 * `enfileirado: true`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { AlertTriangle, ChevronRight, Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { listarCampanhas, listarTemplates } from "@/lib/whatsapp-oficial/gestao-actions";
import { rotuloStatusCampanha } from "@/lib/whatsapp-oficial/gestao-erros";
import { CampanhaNovaDialog } from "./campanha-nova-dialog";
import { CanalPicker } from "./canal-picker";
import { badgeStatusCampanha } from "./gestao-shell";
import type {
  CampanhaResumo,
  WhatsAppCanal,
  WhatsAppTemplate,
} from "@/types/whatsapp-oficial";

const STATUS_FILTRO = [
  { value: "todos", label: "Todos os status" },
  { value: "rascunho", label: "Rascunho" },
  { value: "aguardando_aprovacao", label: "Aguardando aprovação" },
  { value: "aprovado", label: "Aprovada" },
  { value: "enviando", label: "Enfileirando" },
  { value: "pausado", label: "Pausada" },
  { value: "concluido", label: "Concluída" },
  { value: "cancelado", label: "Cancelada" },
] as const;

export function CampanhasClient({ canais }: { canais: WhatsAppCanal[] }) {
  const router = useRouter();
  const [canalId, setCanalId] = useState(canais[0]?.id ?? "");
  const [status, setStatus] = useState<string>("todos");
  const [campanhas, setCampanhas] = useState<CampanhaResumo[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [templatesCarregando, setTemplatesCarregando] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  const carregar = useCallback(async (id: string, filtroStatus: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setCarregando(true);
    setErro(null);
    try {
      const r = await listarCampanhas(
        { canalId: id || undefined, status: filtroStatus },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (!r.ok) {
        setErro(r.mensagem);
        setCampanhas([]);
      } else {
        setCampanhas(r.data.campanhas ?? []);
      }
    } catch {
      return; // abort
    } finally {
      if (!controller.signal.aborted) setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar(canalId, status);
  }, [canalId, status, carregar]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Templates só servem ao formulário de criação — carregados em paralelo e
  // sem bloquear a lista: uma falha aqui não pode impedir de VER as campanhas.
  useEffect(() => {
    if (!canalId) {
      setTemplates([]);
      return;
    }
    const controller = new AbortController();
    setTemplatesCarregando(true);
    void (async () => {
      try {
        const r = await listarTemplates({ canalId, status: "aprovado" }, controller.signal);
        if (controller.signal.aborted) return;
        setTemplates(r.ok ? (r.data.templates ?? []) : []);
      } catch {
        return;
      } finally {
        if (!controller.signal.aborted) setTemplatesCarregando(false);
      }
    })();
    return () => controller.abort();
  }, [canalId]);

  const vazio = !carregando && !erro && campanhas.length === 0;
  const rotuloStatusFiltro = useMemo(
    () => STATUS_FILTRO.find((s) => s.value === status)?.label ?? "Todos os status",
    [status],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CanalPicker canais={canais} canalId={canalId} onChange={setCanalId} />
        <CampanhaNovaDialog
          canais={canais}
          canalId={canalId}
          templates={templates}
          templatesCarregando={templatesCarregando}
          onCriada={(id) => router.push(`/whatsapp-oficial/campanhas/${id}`)}
        />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="filtro-status-campanha" className="text-xs text-muted-foreground">
            Status
          </Label>
          <Select value={status} onValueChange={(v) => v && setStatus(String(v))}>
            <SelectTrigger id="filtro-status-campanha" className="min-w-48">
              <SelectValue>{() => rotuloStatusFiltro}</SelectValue>
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
          Carregando campanhas...
        </div>
      ) : erro ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Não foi possível carregar as campanhas</AlertTitle>
          <AlertDescription>{erro}</AlertDescription>
        </Alert>
      ) : vazio ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {status === "todos"
              ? "Nenhuma campanha neste canal ainda. Criar uma campanha só grava um rascunho — nada é enviado."
              : `Nenhuma campanha com status "${rotuloStatusFiltro.toLowerCase()}".`}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {campanhas.map((c) => (
            <li key={c.id}>
              <LinhaCampanha campanha={c} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LinhaCampanha({ campanha }: { campanha: CampanhaResumo }) {
  const publico = campanha.total_destinatarios ?? 0;
  const suprimidos = campanha.total_suprimidos ?? 0;
  const enfileirados = campanha.total_enviados ?? 0;

  return (
    <Link
      href={`/whatsapp-oficial/campanhas/${campanha.id}`}
      className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 transition-colors hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-foreground">{campanha.nome}</span>
          <Badge variant={badgeStatusCampanha(campanha.status)}>
            {rotuloStatusCampanha(campanha.status)}
          </Badge>
          {campanha.provider && <Badge variant="outline">{campanha.provider}</Badge>}
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            Criada em {format(new Date(campanha.created_at), "dd/MM/yyyy HH:mm", { locale: ptBR })}
          </span>
          {campanha.destinatarios_gerados_em ? (
            <span>
              Público: <strong className="text-foreground">{publico}</strong> · {suprimidos}{" "}
              suprimido{suprimidos === 1 ? "" : "s"}
            </span>
          ) : campanha.dry_run_em ? (
            <span>Público apenas simulado (dry-run), ainda não gravado</span>
          ) : (
            <span>Público não gerado</span>
          )}
          {enfileirados > 0 && (
            <span>
              {enfileirados} enfileirado{enfileirados === 1 ? "" : "s"}
            </span>
          )}
          {campanha.aprovado_em && (
            <span>
              Aprovada em{" "}
              {format(new Date(campanha.aprovado_em), "dd/MM/yyyy HH:mm", { locale: ptBR })}
            </span>
          )}
        </div>
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </Link>
  );
}
