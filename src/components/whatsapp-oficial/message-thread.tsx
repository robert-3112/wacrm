"use client";

/**
 * Conversation thread pane for the official-channel inbox (Fase 6, mission
 * items 2 + 6 — bubbles/composer + handoff/optout/encerrar-reabrir
 * actions).
 *
 * ADAPTED IN SPIRIT (not code) from `src/components/inbox/message-thread.tsx`
 * (WACRM original): header-with-status-control-above-a-scrollable-bubble-
 * list-above-a-composer is the same shape, but every action in the header
 * here is a Fase 5/6 write route this schema actually has (handoff/optout/
 * status), not the WACRM assign/status-dropdown/session-timer/AI-banner
 * set, none of which exist in this schema. `whatsapp_conversations.status`
 * is a triage field the Hub owns outright (see the `status` route's doc
 * comment) — this component only exposes the "encerrar/reabrir" toggle the
 * mission asks for, not the intermediate `pendente` state (that's set by
 * the inbound-message RPC server-side, matching the mission wording
 * literally: "encerrar-reabrir", not a three-way status editor).
 */

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, CheckCircle2, Loader2, Repeat, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { leadDisplayName } from "@/lib/whatsapp-oficial/inbox-data";
import { registerHandoff, registerOptout, updateConversationStatus } from "@/lib/whatsapp-oficial/inbox-actions";
import { MessageBubble } from "./message-bubble";
import { MessageComposer } from "./message-composer";
import type {
  WhatsAppConversation,
  WhatsAppConversationStatus,
  WhatsAppMessage,
} from "@/types/whatsapp-oficial";

const STATUS_LABEL: Record<WhatsAppConversationStatus, string> = {
  aberta: "Aberta",
  pendente: "Pendente",
  encerrada: "Encerrada",
};

interface MessageThreadProps {
  conversation: WhatsAppConversation | null;
  messages: WhatsAppMessage[];
  loading: boolean;
  onMessageSent: (message: WhatsAppMessage) => void;
  /** Fired after handoff/optout/status actions so the parent can re-pull
   *  the conversation (its `lead` join in particular) — those RPCs touch
   *  `public.leads`, which realtime here doesn't watch directly. */
  onConversationChanged: () => void;
  /** Mobile-only "back to list" affordance — the page hides the
   *  conversation list pane below `lg` while a thread is open (see
   *  `(dashboard-oficial)/whatsapp-oficial/inbox/page.tsx`), so this is the only way back
   *  without a browser-level back navigation. Rendered only when provided. */
  onBack?: () => void;
  /** Repassado ao composer: com o envio real desligado a mensagem NÃO chega ao
   *  cliente, e o operador precisa saber disso antes de digitar. */
  envioReal: boolean;
}

export function MessageThread({
  conversation,
  messages,
  loading,
  onMessageSent,
  onConversationChanged,
  onBack,
  envioReal,
}: MessageThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [optoutOpen, setOptoutOpen] = useState(false);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, conversation?.id]);

  if (!conversation) {
    return (
      <div className="flex h-full flex-1 items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Selecione uma conversa para começar.</p>
      </div>
    );
  }

  const name = leadDisplayName(conversation);
  const phone = conversation.lead?.whatsapp;
  const isClosed = conversation.status === "encerrada";
  const isOptedOut = Boolean(conversation.optout_em);

  const composerDisabled = isClosed || isOptedOut;
  const composerDisabledReason = isOptedOut
    ? "Este contato optou por não receber mensagens (opt-out) — envio bloqueado."
    : isClosed
      ? "Conversa encerrada — reabra para responder."
      : undefined;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-background">
      <ThreadHeader
        conversation={conversation}
        name={name}
        phone={phone}
        onOpenHandoff={() => setHandoffOpen(true)}
        onOpenOptout={() => setOptoutOpen(true)}
        onConversationChanged={onConversationChanged}
        onBack={onBack}
      />

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <p className="text-sm text-muted-foreground">Nenhuma mensagem ainda.</p>
          </div>
        ) : (
          messages.map((message) => <MessageBubble key={message.id} message={message} />)
        )}
      </div>

      <MessageComposer
        conversationId={conversation.id}
        disabled={composerDisabled}
        disabledReason={composerDisabledReason}
        envioReal={envioReal}
        onSent={onMessageSent}
      />

      <HandoffDialog
        open={handoffOpen}
        onOpenChange={setHandoffOpen}
        conversationId={conversation.id}
        onDone={onConversationChanged}
      />
      <OptoutDialog
        open={optoutOpen}
        onOpenChange={setOptoutOpen}
        conversationId={conversation.id}
        leadName={name}
        onDone={onConversationChanged}
      />
    </div>
  );
}

function ThreadHeader({
  conversation,
  name,
  phone,
  onOpenHandoff,
  onOpenOptout,
  onConversationChanged,
  onBack,
}: {
  conversation: WhatsAppConversation;
  name: string;
  phone: string | null | undefined;
  onOpenHandoff: () => void;
  onOpenOptout: () => void;
  onConversationChanged: () => void;
  onBack?: () => void;
}) {
  const [togglingStatus, setTogglingStatus] = useState(false);
  const isClosed = conversation.status === "encerrada";

  const handleToggleStatus = async () => {
    setTogglingStatus(true);
    const nextStatus: WhatsAppConversationStatus = isClosed ? "aberta" : "encerrada";
    const result = await updateConversationStatus(conversation.id, nextStatus);
    setTogglingStatus(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(isClosed ? "Conversa reaberta." : "Conversa encerrada.");
    onConversationChanged();
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        {onBack && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="lg:hidden"
            onClick={onBack}
            aria-label="Voltar para a lista de conversas"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
        )}
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
          {name.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-foreground">{name}</span>
            <Badge variant={isClosed ? "outline" : "secondary"} className="shrink-0">
              {STATUS_LABEL[conversation.status]}
            </Badge>
            {conversation.optout_em && (
              <Badge variant="destructive" className="shrink-0">
                Opt-out
              </Badge>
            )}
          </div>
          {phone && <span className="text-xs text-muted-foreground">{phone}</span>}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          onClick={onOpenHandoff}
          disabled={Boolean(conversation.optout_em)}
        >
          <CheckCircle2 data-icon="inline-start" />
          Handoff
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onOpenOptout}
          disabled={Boolean(conversation.optout_em)}
        >
          <UserX data-icon="inline-start" />
          Opt-out
        </Button>
        <Button variant="outline" size="sm" disabled={togglingStatus} onClick={() => void handleToggleStatus()}>
          {togglingStatus ? (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          ) : (
            <Repeat data-icon="inline-start" />
          )}
          {isClosed ? "Reabrir" : "Encerrar"}
        </Button>
      </div>
    </div>
  );
}

function HandoffDialog({
  open,
  onOpenChange,
  conversationId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  onDone: () => void;
}) {
  const [intencao, setIntencao] = useState("");
  const [empreendimento, setEmpreendimento] = useState("");
  const [regiao, setRegiao] = useState("");
  const [interesse, setInteresse] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setIntencao("");
    setEmpreendimento("");
    setRegiao("");
    setInteresse("");
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    const result = await registerHandoff(conversationId, {
      intencao: intencao.trim() || undefined,
      empreendimentoInteresseSlug: empreendimento.trim() || undefined,
      regiaoInteresse: regiao.trim() || undefined,
      interesse: interesse.trim() || undefined,
    });
    setSubmitting(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success("Handoff registrado — lead qualificado.");
    reset();
    onOpenChange(false);
    onDone();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Registrar handoff</DialogTitle>
          <DialogDescription>
            Avança o lead para qualificado. Os campos abaixo são opcionais — preencha o que já
            souber da conversa.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="handoff-intencao">Intenção</Label>
            <Input
              id="handoff-intencao"
              value={intencao}
              onChange={(e) => setIntencao(e.target.value)}
              placeholder="Ex.: comprar, investir, alugar"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="handoff-empreendimento">Empreendimento de interesse</Label>
            <Input
              id="handoff-empreendimento"
              value={empreendimento}
              onChange={(e) => setEmpreendimento(e.target.value)}
              placeholder="Slug do empreendimento"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="handoff-regiao">Região de interesse</Label>
            <Input
              id="handoff-regiao"
              value={regiao}
              onChange={(e) => setRegiao(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="handoff-interesse">Observações</Label>
            <Input
              id="handoff-interesse"
              value={interesse}
              onChange={(e) => setInteresse(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancelar
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting}>
            {submitting && <Loader2 data-icon="inline-start" className="animate-spin" />}
            Confirmar handoff
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OptoutDialog({
  open,
  onOpenChange,
  conversationId,
  leadName,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  leadName: string;
  onDone: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    setSubmitting(true);
    const result = await registerOptout(conversationId);
    setSubmitting(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success("Opt-out registrado — o contato não receberá mais mensagens.");
    onOpenChange(false);
    onDone();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Registrar opt-out</DialogTitle>
          <DialogDescription>
            Marca <strong>{leadName}</strong> como opt-out (não deseja mais receber mensagens) em
            todas as conversas do canal oficial. Esta ação não pode ser desfeita pela inbox.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancelar
          </Button>
          <Button variant="destructive" onClick={() => void handleSubmit()} disabled={submitting}>
            {submitting && <Loader2 data-icon="inline-start" className="animate-spin" />}
            Confirmar opt-out
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
