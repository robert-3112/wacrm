"use client";

/**
 * Right-hand sidebar for the official-channel inbox (Fase 6, mission items
 * 4 + 5 — internal notes panel + lead data sidebar with an "abrir no CRM"
 * link). Combined into one component (two `Tabs` panels) rather than two
 * stacked panels — screen space in a 3-pane inbox is tight, and both panels
 * can grow long (many notes; a lead with lots of fields), so two
 * independently-scrolling stacked regions would fight for height. Tabs
 * (`@/components/ui/tabs`, already in the design system) solves that
 * cleanly.
 *
 * WRITTEN FROM SCRATCH for this mission — no equivalent single component in
 * the WACRM original (its `ContactSidebar` mixes deals/tags/notes across a
 * completely different schema, see that file's own extensive doc comments
 * on this mission's harvest matrix). The lead fields shown here
 * (nome/telefone/etapa/temperatura/empreendimento) are exactly
 * `WhatsAppLeadSummary` — this component intentionally does NOT fetch or
 * show anything beyond that summary; the CRM (Lovable app) owns the full
 * lead record (see the "abrir no CRM" link below).
 */

import { useCallback, useEffect, useState } from "react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { ExternalLink, Loader2, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { fetchAuthorNames, fetchInternalNotes } from "@/lib/whatsapp-oficial/inbox-data";
import { addInternalNote } from "@/lib/whatsapp-oficial/inbox-actions";
import { toast } from "sonner";
import type { WhatsAppConversation, WhatsAppInternalNote } from "@/types/whatsapp-oficial";

/** Base URL do CRM da SUNT (app Lovable), que é dono da ficha completa do lead. */
const CRM_BASE_URL = process.env.NEXT_PUBLIC_SUNT_CRM_URL;

/**
 * Modelo da URL da ficha, com `{leadId}` onde entra o id.
 * Ex.: `https://litoral-leads.lovable.app/app/leads/{leadId}`
 *
 * POR QUE ISTO E CONFIGURAVEL e nao um caminho fixo: o CRM e um app React de
 * rotas do lado do cliente. Toda URL responde 200 com a mesma casca — inclusive
 * as que nao existem —, entao um caminho errado nao da 404: leva o operador
 * para uma tela em branco. Era o que acontecia: o codigo cravava `/leads/{id}`,
 * mas o app usa prefixo `/app/` (visto no link de aceite que o n8n manda).
 *
 * Como o padrao so pode ser confirmado por quem abre o CRM, ele vira
 * configuracao: ajustar e trocar uma variavel de ambiente, sem mexer em codigo.
 * Enquanto nao estiver definido, o botao leva para a HOME do CRM — menos
 * direto, mas nunca quebrado.
 */
const CRM_LEAD_URL_TEMPLATE = process.env.NEXT_PUBLIC_SUNT_CRM_LEAD_URL;

function crmLeadUrl(leadId: string): string | null {
  if (CRM_LEAD_URL_TEMPLATE?.includes("{leadId}")) {
    return CRM_LEAD_URL_TEMPLATE.replace("{leadId}", encodeURIComponent(leadId));
  }
  if (!CRM_BASE_URL) return null;
  return CRM_BASE_URL.replace(/\/+$/, "");
}

interface LeadSidebarProps {
  conversation: WhatsAppConversation | null;
  currentUserId: string | null;
}

export function LeadSidebar({ conversation, currentUserId }: LeadSidebarProps) {
  if (!conversation) {
    return (
      <div className="hidden h-full w-72 shrink-0 items-center justify-center border-l border-border bg-card p-4 text-center lg:flex">
        <p className="text-sm text-muted-foreground">
          Selecione uma conversa para ver os detalhes do lead.
        </p>
      </div>
    );
  }

  return (
    <div className="hidden h-full w-72 shrink-0 flex-col border-l border-border bg-card lg:flex">
      <Tabs defaultValue="detalhes" className="flex h-full flex-col gap-0">
        <div className="border-b border-border p-2">
          <TabsList className="w-full">
            <TabsTrigger value="detalhes" className="flex-1">
              Detalhes
            </TabsTrigger>
            <TabsTrigger value="notas" className="flex-1">
              Notas
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="detalhes" className="min-h-0 flex-1">
          <LeadDetailsPanel conversation={conversation} />
        </TabsContent>

        <TabsContent value="notas" className="flex min-h-0 flex-1 flex-col">
          <InternalNotesPanel conversationId={conversation.id} currentUserId={currentUserId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function LeadDetailsPanel({ conversation }: { conversation: WhatsAppConversation }) {
  const lead = conversation.lead;
  const href = lead ? crmLeadUrl(lead.id) : null;

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-4">
        <div className="flex flex-col items-center text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted text-lg font-semibold text-foreground">
            {(lead?.nome || conversation.wa_contact_name || "?").charAt(0).toUpperCase()}
          </div>
          <h3 className="mt-3 text-sm font-semibold text-foreground">
            {lead?.nome || conversation.wa_contact_name || "Contato sem nome"}
          </h3>
          {lead?.whatsapp && (
            <p className="text-xs text-muted-foreground">{lead.whatsapp}</p>
          )}
        </div>

        {!lead ? (
          <p className="text-center text-xs text-muted-foreground">
            Nenhum lead vinculado a esta conversa.
          </p>
        ) : (
          <dl className="space-y-3 text-sm">
            <Field label="Etapa">
              {lead.etapa ? <Badge variant="secondary">{lead.etapa}</Badge> : <Muted />}
            </Field>
            <Field label="Temperatura">
              {lead.temperatura ? <Badge variant="outline">{lead.temperatura}</Badge> : <Muted />}
            </Field>
            <Field label="Empreendimento de interesse">
              {lead.empreendimento_interesse_slug ?? <Muted />}
            </Field>
            <Field label="Corretor responsável">
              {lead.corretor?.nome ?? <span className="text-muted-foreground">Sem dono</span>}
            </Field>
            <Field label="Urgente">
              {lead.urgente ? (
                <Badge variant="destructive">Urgente</Badge>
              ) : (
                <Muted />
              )}
            </Field>
            {conversation.optout_em && (
              <Field label="Opt-out em">
                {format(new Date(conversation.optout_em), "dd/MM/yyyy HH:mm", { locale: ptBR })}
              </Field>
            )}
          </dl>
        )}

        {lead && (
          href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(buttonVariants({ variant: "outline" }), "w-full")}
            >
              <ExternalLink data-icon="inline-start" />
              Abrir no CRM
            </a>
          ) : (
            <p className="text-center text-[10px] text-muted-foreground">
              Link do CRM não configurado (NEXT_PUBLIC_SUNT_CRM_URL).
            </p>
          )
        )}
      </div>
    </ScrollArea>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="mt-0.5 text-foreground">{children}</dd>
    </div>
  );
}

function Muted() {
  return <span className="text-muted-foreground">—</span>;
}

function InternalNotesPanel({
  conversationId,
  currentUserId,
}: {
  conversationId: string;
  currentUserId: string | null;
}) {
  const [notes, setNotes] = useState<WhatsAppInternalNote[]>([]);
  const [authorNames, setAuthorNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    const supabase = createClient();
    const { data, error } = await fetchInternalNotes(supabase, id);
    if (error) {
      toast.error("Não foi possível carregar as notas internas.");
      setLoading(false);
      return;
    }
    setNotes(data);
    setLoading(false);
    const names = await fetchAuthorNames(
      supabase,
      data.map((n) => n.autor_id).filter((v): v is string => Boolean(v)),
    );
    setAuthorNames(names);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(conversationId);
  }, [conversationId, load]);

  const handleAddNote = async () => {
    const conteudo = draft.trim();
    if (!conteudo) return;
    setSaving(true);
    const result = await addInternalNote(conversationId, conteudo);
    setSaving(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setNotes((prev) => [result.data.note, ...prev]);
    setDraft("");
  };

  const authorLabel = (note: WhatsAppInternalNote): string => {
    if (!note.autor_id) return "Equipe";
    if (note.autor_id === currentUserId) return "Você";
    return authorNames[note.autor_id] ?? "Equipe";
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-3">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : notes.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              Nenhuma nota interna ainda.
            </p>
          ) : (
            notes.map((note) => (
              <div key={note.id} className="rounded-lg bg-muted/50 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-foreground">{authorLabel(note)}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {format(new Date(note.created_at), "dd/MM HH:mm", { locale: ptBR })}
                  </span>
                </div>
                <p className="mt-1 text-xs break-words whitespace-pre-wrap text-foreground">
                  {note.conteudo}
                </p>
              </div>
            ))
          )}
        </div>
      </ScrollArea>

      <div className="border-t border-border p-3">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Nota interna — nunca é enviada ao contato."
          className="min-h-16 text-sm"
          maxLength={4000}
        />
        <Button
          size="sm"
          className="mt-2 w-full"
          disabled={!draft.trim() || saving}
          onClick={() => void handleAddNote()}
        >
          {saving ? (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          ) : (
            <Send data-icon="inline-start" />
          )}
          Adicionar nota
        </Button>
      </div>
    </div>
  );
}
