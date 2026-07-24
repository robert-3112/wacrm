"use client";

/**
 * Conversation list pane for the official-channel inbox (Fase 6, mission
 * item 1 — "lista de conversas com filtros ... e busca").
 *
 * ADAPTED IN SPIRIT (not code) from `src/components/inbox/conversation-list.tsx`
 * (WACRM original): same shape (search input + filter control above a
 * scrollable list of avatar/name/preview/timestamp rows), but the filter
 * vocabulary, data shape and search predicate all come from
 * `src/lib/whatsapp-oficial/inbox-data.ts` (this schema's
 * `InboxFilter`/`matchesInboxFilter`/`matchesSearch`, not the WACRM
 * `ConversationStatus`/contact-tag filtering it originally had — no tags/
 * companies concept exists here). The list itself is owned by the parent
 * page (fetched once + kept live via realtime); this component only
 * filters/searches/renders what it's given, mirroring the WACRM original's
 * "client-side filter over an already-fetched array" trade-off (see
 * `inbox-data.ts`'s module doc comment).
 */

import { useMemo, useState } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import { ptBR } from "date-fns/locale";
import { ChevronDown, Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { leadDisplayName, matchesInboxFilter, matchesSearch } from "@/lib/whatsapp-oficial/inbox-data";
import type { InboxFilter, WhatsAppConversation, WhatsAppConversationStatus } from "@/types/whatsapp-oficial";

const FILTER_OPTIONS: { value: InboxFilter; label: string }[] = [
  { value: "todas", label: "Todas" },
  { value: "aberta", label: "Abertas" },
  { value: "pendente", label: "Pendentes" },
  { value: "encerrada", label: "Encerradas" },
  { value: "sem_dono", label: "Sem dono" },
  { value: "urgente", label: "Urgentes" },
];

const STATUS_DOT: Record<WhatsAppConversationStatus, string> = {
  aberta: "bg-primary",
  pendente: "bg-amber-500",
  encerrada: "bg-muted-foreground",
};

interface ConversationListProps {
  conversations: WhatsAppConversation[];
  loading: boolean;
  activeConversationId: string | null;
  onSelect: (conversation: WhatsAppConversation) => void;
}

export function ConversationList({
  conversations,
  loading,
  activeConversationId,
  onSelect,
}: ConversationListProps) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("todas");

  const filtered = useMemo(() => {
    return conversations.filter(
      (c) => matchesInboxFilter(c, filter) && matchesSearch(c, search),
    );
  }, [conversations, filter, search]);

  const activeFilterLabel = FILTER_OPTIONS.find((f) => f.value === filter)?.label ?? "Todas";

  return (
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-80">
      <div className="space-y-2 border-b border-border p-3">
        <div className="relative">
          <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome ou telefone..."
            className="bg-muted pl-9"
          />
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger className="inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
            {activeFilterLabel}
            <ChevronDown className="h-3 w-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {FILTER_OPTIONS.map((opt) => (
              <DropdownMenuItem
                key={opt.value}
                onClick={() => setFilter(opt.value)}
                className={cn("text-sm", filter === opt.value ? "text-primary" : undefined)}
              >
                {opt.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* `min-h-0` is load-bearing — see the equivalent note in the WACRM
          original: without it a flex child defaults to min-height:auto and
          grows to fit every conversation instead of scrolling. */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">
              {conversations.length === 0
                ? "Nenhuma conversa ainda."
                : "Nenhuma conversa corresponde ao filtro/busca."}
            </p>
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                isActive={conversation.id === activeConversationId}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

function ConversationRow({
  conversation,
  isActive,
  onSelect,
}: {
  conversation: WhatsAppConversation;
  isActive: boolean;
  onSelect: (conversation: WhatsAppConversation) => void;
}) {
  const name = leadDisplayName(conversation);
  const initials = name.charAt(0).toUpperCase();
  const urgente = conversation.lead?.urgente === true;
  const semDono = !conversation.lead?.corretor_id;
  const unread = conversation.nao_lidas_corretor > 0;

  const timeAgo = conversation.ultima_mensagem_em
    ? formatDistanceToNowStrict(new Date(conversation.ultima_mensagem_em), { locale: ptBR })
    : "";

  return (
    <button
      type="button"
      onClick={() => onSelect(conversation)}
      className={cn(
        "flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50",
        isActive && "border-l-2 border-primary bg-muted/70",
      )}
    >
      <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
        {initials}
        <span
          className={cn(
            "absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-card",
            STATUS_DOT[conversation.status],
          )}
          title={conversation.status}
        />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">{name}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo}</span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted-foreground">
            {conversation.ultima_mensagem_preview || "Sem mensagens ainda"}
          </p>
          <div className="flex shrink-0 items-center gap-1">
            {urgente && (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive"
                title="Urgente"
              />
            )}
            {unread && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {conversation.nao_lidas_corretor}
              </span>
            )}
          </div>
        </div>
        {semDono && (
          <span className="mt-1 inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            Sem dono
          </span>
        )}
      </div>
    </button>
  );
}
