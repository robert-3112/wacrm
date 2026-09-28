"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, CheckCircle2, Loader2, MessageSquareText, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { montarValoresPreview, previewTemplate } from "@/lib/whatsapp-oficial/gestao-actions";
import { traduzirErro } from "@/lib/whatsapp-oficial/gestao-erros";
import type {
  TemplatePreviewResposta, TemplateVariaveis, WhatsAppCanal, WhatsAppTemplate,
} from "@/types/whatsapp-oficial";

type Contact = { id: string; nome: string; whatsapp: string };
type Values = { corpo: Record<number, string>; cabecalho: Record<number, string> };
type QueueResult = { conversationId: string; messageId: string; replayed: boolean };

const EMPTY_VALUES: Values = { corpo: {}, cabecalho: {} };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The first-contact flow previews exactly the payload it can send today. */
function isSimpleTextTemplate(template: WhatsAppTemplate): boolean {
  const types = template.tipos_componentes;
  if (template.status_aprovacao !== "aprovado" || !Array.isArray(types) ||
    types.some((type) => !["HEADER", "BODY", "FOOTER"].includes(type))) return false;
  if (template.cabecalho_formato && template.cabecalho_formato !== "TEXT") return false;
  const variables = template.variaveis;
  return !variables?.botoes?.length && (variables?.cabecalho?.length ?? 0) <= 1;
}

function intentId(key: string, fingerprint: string): string {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? "null") as { fingerprint?: string; id?: string } | null;
    if (saved?.fingerprint === fingerprint && typeof saved.id === "string" && UUID.test(saved.id)) return saved.id;
  } catch { /* damaged browser storage: replace it */ }
  const id = crypto.randomUUID();
  try { sessionStorage.setItem(key, JSON.stringify({ fingerprint, id })); } catch { /* in-memory fallback below */ }
  return id;
}

async function fingerprintFor(payload: unknown): Promise<string> {
  // Keep template values out of sessionStorage while preserving the request ID
  // across a lost response and a page reload.
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function IniciarConversa({ contato, canal }: { contato: Contact; canal: WhatsAppCanal }) {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [templateId, setTemplateId] = useState("");
  const [values, setValues] = useState<Values>(EMPTY_VALUES);
  const [preview, setPreview] = useState<TemplatePreviewResposta | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState<QueueResult | null>(null);
  const lastIntent = useRef<{ fingerprint: string; id: string } | null>(null);
  const previewVersion = useRef(0);

  const selected = useMemo(() => templates.find((template) => template.id === templateId) ?? null, [templates, templateId]);
  const required: TemplateVariaveis = selected?.variaveis ?? { corpo: [], cabecalho: [], botoes: [] };

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    previewVersion.current += 1;
    setPreview(null);
    void fetch(`/api/whatsapp-oficial/templates?canalId=${encodeURIComponent(canal.id)}&status=aprovado`, {
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error("Não foi possível carregar os templates aprovados.");
      const body = await response.json() as { templates?: WhatsAppTemplate[] };
      setTemplates((body.templates ?? []).filter(isSimpleTextTemplate));
      previewVersion.current += 1;
      setPreview(null);
    }).catch(() => {
      if (!controller.signal.aborted) setError("Não foi possível carregar os templates aprovados.");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [open, canal.id]);

  const changeTemplate = (id: string) => {
    previewVersion.current += 1;
    setPreviewing(false);
    setTemplateId(id);
    setValues(EMPTY_VALUES);
    setPreview(null);
    setError(null);
    setQueued(null);
  };

  const changeValue = (where: "corpo" | "cabecalho", index: number, value: string) => {
    previewVersion.current += 1;
    setPreviewing(false);
    setValues((old) => ({ ...old, [where]: { ...old[where], [index]: value } }));
    setPreview(null);
    setError(null);
  };

  const valuesForPreview = () => montarValoresPreview(required, values);

  const showPreview = async () => {
    if (!selected || previewing) return;
    const version = ++previewVersion.current;
    setPreviewing(true);
    setError(null);
    const result = await previewTemplate(selected.id, valuesForPreview());
    if (version !== previewVersion.current) return;
    setPreviewing(false);
    if (!result.ok) { setError(result.mensagem); return; }
    setPreview(result.data);
  };

  const send = async () => {
    if (!selected || preview?.templateId !== selected.id || !preview.validacao.ok || sending || queued) return;
    const variables = valuesForPreview();
    const payload = {
      canalId: canal.id,
      templateId: selected.id,
      variaveis: {
        ...(variables.corpo ? { body: variables.corpo } : {}),
        ...(variables.cabecalho ? { headerText: variables.cabecalho[0] } : {}),
      },
    };
    const storageKey = `whathub-iniciar:${contato.id}:${canal.id}`;
    setSending(true);
    setError(null);
    try {
      const fingerprint = await fingerprintFor(payload);
      const clientRequestId = lastIntent.current?.fingerprint === fingerprint
        ? lastIntent.current.id : intentId(storageKey, fingerprint);
      lastIntent.current = { fingerprint, id: clientRequestId };
      const response = await fetch(`/api/whatsapp-oficial/contatos/${encodeURIComponent(contato.id)}/iniciar`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, clientRequestId }),
      });
      const result = await response.json() as Record<string, unknown>;
      if (!response.ok) {
        const slug = typeof result.error === "string" ? result.error : "Internal server error";
        if (slug === "idempotency_conflict") {
          lastIntent.current = null;
          try { sessionStorage.removeItem(storageKey); } catch { /* storage unavailable */ }
        }
        setError(traduzirErro(slug, response.status));
        return;
      }
      if (typeof result.conversationId !== "string" || typeof result.messageId !== "string") {
        setError("O resultado não foi confirmado. Consulte a conversa antes de tentar novamente.");
        return;
      }
      lastIntent.current = null;
      try { sessionStorage.removeItem(storageKey); } catch { /* storage unavailable */ }
      setQueued({ conversationId: result.conversationId, messageId: result.messageId, replayed: result.replayed === true });
    } catch {
      setError("Não foi possível confirmar o resultado. Tente novamente sem alterar os dados; o sistema reutilizará a mesma solicitação quando houver uma pendente.");
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" className="gap-1.5" />}>
        <MessageSquareText className="size-3.5" aria-hidden="true" /> Iniciar conversa
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Iniciar pelo WhatsApp oficial</DialogTitle>
          <DialogDescription>
            Escolha um template aprovado, confira o conteúdo e enfileire uma mensagem para este contato.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 rounded-xl border border-border bg-muted/30 p-4 text-sm sm:grid-cols-2">
          <div>
            <span className="text-muted-foreground text-xs">Remetente</span>
            <p className="font-medium">{canal.nome}</p>
            <p className="text-muted-foreground text-xs">{canal.numero_display ?? "Número oficial"}</p>
          </div>
          <div>
            <span className="text-muted-foreground text-xs">Destinatário</span>
            <p className="font-medium">{contato.nome}</p>
            <p className="text-muted-foreground text-xs">{contato.whatsapp}</p>
          </div>
        </div>

        {queued ? (
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-4" role="status">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
              <div>
                <p className="font-medium">Mensagem na fila</p>
                <p className="text-muted-foreground mt-1 text-xs">
                  {queued.replayed ? "Esta solicitação já estava na fila." : "O envio será processado pelo canal oficial."} A entrega aparece na conversa quando a Meta confirmar.
                </p>
                <Link href="/whatsapp-oficial/inbox" className="text-primary mt-3 inline-flex items-center gap-1 text-sm font-medium underline-offset-4 hover:underline">
                  Abrir conversas <ArrowUpRight className="size-4" aria-hidden="true" />
                </Link>
                <Button type="button" variant="link" className="mt-2 block h-auto p-0 text-xs" onClick={() => {
                  setQueued(null);
                  setPreview(null);
                }}>
                  Preparar outra mensagem
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor={`iniciar-template-${contato.id}`}>Template aprovado</Label>
              <select id={`iniciar-template-${contato.id}`} value={templateId}
                onChange={(event) => changeTemplate(event.target.value)} disabled={loading || sending}
                className="border-input bg-background focus-visible:ring-ring/50 h-10 w-full rounded-lg border px-3 text-sm focus-visible:ring-3 focus-visible:outline-none">
                <option value="">{loading ? "Carregando…" : "Selecione um template de texto"}</option>
                {templates.map((template) => <option key={template.id} value={template.id}>{template.nome} · {template.idioma}</option>)}
              </select>
              {!loading && templates.length === 0 && !error &&
                <p className="text-muted-foreground text-xs">Nenhum template de texto aprovado disponível neste canal.</p>}
            </div>
            {selected && <div className="space-y-3">
              {required.cabecalho.map((index) =>
                <div key={`header-${index}`} className="space-y-1.5">
                  <Label htmlFor={`iniciar-header-${contato.id}-${index}`}>Cabeçalho {`{{${index}}}`}</Label>
                  <Input id={`iniciar-header-${contato.id}-${index}`} maxLength={256}
                    disabled={sending}
                    value={values.cabecalho[index] ?? ""}
                    onChange={(event) => changeValue("cabecalho", index, event.target.value)} />
                </div>)}
              {required.corpo.map((index) =>
                <div key={`body-${index}`} className="space-y-1.5">
                  <Label htmlFor={`iniciar-body-${contato.id}-${index}`}>Mensagem {`{{${index}}}`}</Label>
                  <Input id={`iniciar-body-${contato.id}-${index}`} maxLength={256}
                    disabled={sending}
                    value={values.corpo[index] ?? ""}
                    onChange={(event) => changeValue("corpo", index, event.target.value)} />
                </div>)}
              <Button type="button" variant="outline" onClick={() => void showPreview()} disabled={previewing || sending}>
                {previewing && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
                Conferir mensagem
              </Button>
            </div>}
            {preview && <div className="rounded-xl border border-border bg-card p-4" aria-live="polite">
              <p className="text-muted-foreground mb-2 text-xs font-medium">Prévia para {contato.nome}</p>
              {preview.preview.cabecalho && <p className="font-medium">{preview.preview.cabecalho}</p>}
              <p className="whitespace-pre-wrap text-sm">{preview.preview.corpo}</p>
              {preview.preview.rodape && <p className="text-muted-foreground mt-2 text-xs">{preview.preview.rodape}</p>}
              {!preview.validacao.ok && <p className="text-destructive mt-3 text-xs">Preencha todas as variáveis antes de enfileirar.</p>}
            </div>}
            <p className="text-muted-foreground text-xs">
              Consentimento, descadastro e canal são revalidados no momento do envio. O piloto só aceita destinatários autorizados.
            </p>
            {error && <p className="text-destructive text-sm" role="alert">{error}</p>}
            <DialogFooter>
              <Button type="button" onClick={() => void send()} disabled={!selected || preview?.templateId !== selected.id || !preview.validacao.ok || sending}>
                {sending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Send className="size-4" aria-hidden="true" />}
                Enfileirar mensagem
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
