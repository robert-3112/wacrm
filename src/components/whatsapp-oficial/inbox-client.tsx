"use client";

/**
 * Shared inbox page for the official-channel WhatsApp Hub (Fase 6 —
 * "SUNT WhatsApp Hub"). Owns the three-pane layout (conversation list /
 * thread / lead sidebar) and all the state the panes need: the
 * conversation + message lists (read directly from Supabase via
 * `lib/whatsapp-oficial/inbox-data.ts` — RLS-scoped, no server route
 * needed for reads, see that module's doc comment), kept live via
 * `useWhatsAppOficialRealtime`.
 *
 * WRITTEN FROM SCRATCH for this mission. Structurally similar to
 * `src/app/(dashboard)/inbox/page.tsx` (WACRM original — three-pane layout,
 * a `hydrateConversation` self-heal fetch on realtime events whose payload
 * doesn't carry the `lead` join, a mobile single-pane fallback) but
 * rebuilt against this schema's data shape and the mission's reduced
 * scope: no deep-link URL sync or WhatsApp-connection banner. The list can
 * contain multiple channels; details and notes remain accessible on mobile.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import {
  buildInboxItems,
  fetchConversationById,
  fetchInboxSnapshot,
  fetchMessages,
  fetchPairedMessages,
  mergePairedMessages,
} from "@/lib/whatsapp-oficial/inbox-data";
import type { InboxItem } from "@/lib/whatsapp-oficial/inbox-data";
import { markConversationRead } from "@/lib/whatsapp-oficial/inbox-actions";
import { useWhatsAppOficialRealtime } from "@/hooks/use-whatsapp-oficial-realtime";
import { ConversationList } from "./conversation-list";
import { MessageThread } from "./message-thread";
import { PairCandidateAction } from "./pair-candidate-action";
import { LeadSidebar } from "./lead-sidebar";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ContactRound } from "lucide-react";
import type { WhatsAppConversation, WhatsAppConversationPair, WhatsAppMessage } from "@/types/whatsapp-oficial";

export function InboxClient({ envioReal }: { envioReal: boolean }) {
  const [conversations, setConversations] = useState<WhatsAppConversation[]>([]);
  const [pairs, setPairs] = useState<WhatsAppConversationPair[]>([]);
  const [inboxStatus, setInboxStatus] = useState<"loading" | "ready" | "error">("loading");
  const reloadInFlight = useRef(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<WhatsAppMessage[]>([]);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [channelNames, setChannelNames] = useState<Record<string, string>>({});
  const [detailsOpen, setDetailsOpen] = useState(false);

  // Dismiss the mobile drawer if the viewport grows to the three-pane layout.
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1280px)");
    const closeOnDesktop = () => { if (desktop.matches) setDetailsOpen(false); };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  const channelIdsKey = useMemo(
    () => [...new Set(conversations.map((conversation) => conversation.canal_id))].sort().join(","),
    [conversations],
  );

  // Channel metadata is safe to display. A corretor may lack SELECT access
  // to whatsapp_channels; the list still works with neutral channel labels.
  useEffect(() => {
    if (!channelIdsKey) return;
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("whatsapp_channels")
        .select("id, nome, numero_display")
        .in("id", channelIdsKey.split(","));
      if (cancelled || !data) return;
      setChannelNames(Object.fromEntries(data.map((channel) => [
        channel.id,
        [channel.nome, channel.numero_display].filter(Boolean).join(" · "),
      ])));
    })();
    return () => { cancelled = true; };
  }, [channelIdsKey]);

  const items = useMemo(() => buildInboxItems(conversations, pairs), [conversations, pairs]);
  const activeItem = useMemo(() => items.find((item) => item.id === activeId) ?? null, [items, activeId]);
  const activeConversation = activeItem?.kind === "single" ? activeItem.conversation : null;
  const activePair = activeItem?.kind === "pair" ? activeItem : null;

  // Mirrors `activeId` for the realtime message handler below, which is
  // registered once (empty dep) and would otherwise close over a stale
  // value — same pattern the WACRM original documents on its
  // `knownConvIdsRef`.
  const activeIdRef = useRef<string | null>(null);
  const activeMemberIdsRef = useRef<string[]>([]);
  useEffect(() => {
    activeIdRef.current = activeId;
    activeMemberIdsRef.current = activeItem?.kind === "pair"
      ? [activeItem.outbound.id, activeItem.inbound.id]
      : activeItem ? [activeItem.conversation.id] : [];
  }, [activeId, activeItem]);

  // A newly verified link replaces its two individual rows without losing selection.
  useEffect(() => {
    if (!activeId || activeItem) return;
    const replacement = items.find((item) => item.kind === "pair" &&
      (item.outbound.id === activeId || item.inbound.id === activeId));
    if (replacement) setActiveId(replacement.id);
    else if (inboxStatus === "ready") setActiveId(null);
  }, [activeId, activeItem, items, inboxStatus]);

  const reloadInbox = useCallback(async (showLoading = false) => {
    if (reloadInFlight.current) return;
    reloadInFlight.current = true;
    if (showLoading) setInboxStatus("loading");
    try {
      const result = await fetchInboxSnapshot(createClient());
      if (!result.data) {
        // Keep the previous rows in memory, but hide every action until a
        // complete authenticated snapshot proves the link state again.
        setInboxStatus("error");
        return;
      }
      setConversations(result.data.conversations);
      setPairs(result.data.pairs);
      setInboxStatus("ready");
    } catch {
      setInboxStatus("error");
    } finally {
      reloadInFlight.current = false;
    }
  }, []);

  // Current user id — used by the notes panel to label the caller's own
  // notes "Você" instead of resolving their name through `corretores`.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (cancelled) return;
      setCurrentUserId(user?.id ?? null);
      if (user) {
        const { data, error } = await supabase.rpc('crm_is_gestao');
        if (!cancelled) setCanManage(!error && data === true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // A complete pair index is required before any standalone actions appear.
  useEffect(() => {
    void reloadInbox();
  }, [reloadInbox]);

  // Links are created by the verified webhook, not by a conversation mutation.
  useEffect(() => {
    const timer = window.setInterval(async () => {
      void reloadInbox();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [reloadInbox]);

  // Messages fetch whenever the selected conversation changes.
  useEffect(() => {
    if (!activeItem) {
      setMessages([]);
      setMessagesError(null);
      return;
    }
    let cancelled = false;
    setMessagesLoading(true);
    (async () => {
      const supabase = createClient();
      const { data, error } = activeItem.kind === "pair"
        ? await fetchPairedMessages(supabase, activeItem.pair)
        : await fetchMessages(supabase, activeItem.conversation.id);
      if (cancelled) return;
      if (error) toast.error("Não foi possível carregar as mensagens.");
      setMessagesError(error);
      setMessages(data);
      setMessagesLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  // Pair membership is immutable; depend on the selected identity rather than every realtime row update.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // Mark-as-read: fires once per conversation selection that has unread
  // messages. Optimistically zeroes the local badge immediately (matches
  // the server-side effect of the route it calls) so the count doesn't
  // flicker while the request is in flight.
  useEffect(() => {
    if (inboxStatus !== "ready" || !activeConversation || activeConversation.nao_lidas_corretor <= 0) return;
    const id = activeConversation.id;
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, nao_lidas_corretor: 0 } : c)),
    );
    void markConversationRead(id);
    // Only re-fires when the *selected conversation* changes, not on every
    // unrelated conversations-array update (e.g. another conv's realtime
    // UPDATE) — activeConversation.nao_lidas_corretor is intentionally
    // excluded so this doesn't loop against the optimistic zero above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversation?.id, inboxStatus]);

  // Re-fetch a single conversation (with its `lead`/`corretor` join) and
  // merge it into state. Realtime `postgres_changes` payloads only carry
  // the row's own columns — see `inbox-data.ts#fetchConversationById`'s
  // doc comment — and handoff/optout mutate `public.leads`, which this
  // page doesn't subscribe to directly, so thread actions call this too.
  const hydratingRef = useRef<Set<string>>(new Set());
  const hydrateConversation = useCallback(async (id: string) => {
    if (hydratingRef.current.has(id)) return;
    hydratingRef.current.add(id);
    try {
      const supabase = createClient();
      const fresh = await fetchConversationById(supabase, id);
      if (!fresh) return;
      setConversations((prev) => {
        const exists = prev.some((c) => c.id === id);
        if (exists) return prev.map((c) => (c.id === id ? fresh : c));
        return [fresh, ...prev];
      });
    } finally {
      hydratingRef.current.delete(id);
    }
  }, []);

  const handleConversationEvent = useCallback(
    (event: { eventType: "INSERT" | "UPDATE" | "DELETE"; new: WhatsAppConversation }) => {
      if (event.eventType === "DELETE") return;
      void hydrateConversation(event.new.id);
    },
    [hydrateConversation],
  );

  const handleMessageEvent = useCallback(
    (event: { eventType: "INSERT" | "UPDATE" | "DELETE"; new: WhatsAppMessage }) => {
      const msg = event.new;
      if (event.eventType === "INSERT") {
        if (!activeMemberIdsRef.current.includes(msg.conversation_id)) return;
        setMessages((prev) => prev.some((m) => m.id === msg.id) ? prev : mergePairedMessages(prev, [msg]));
      } else if (event.eventType === "UPDATE") {
        setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, ...msg } : m)));
      }
    },
    [],
  );

  useWhatsAppOficialRealtime({
    onConversationEvent: handleConversationEvent,
    onMessageEvent: handleMessageEvent,
  });

  const handleSelectConversation = useCallback((item: InboxItem) => {
    activeIdRef.current = item.id;
    activeMemberIdsRef.current = item.kind === "pair" ? [item.outbound.id, item.inbound.id] : [item.conversation.id];
    setActiveId((prev) => (prev === item.id ? prev : item.id));
    setDetailsOpen(false);
  }, []);

  const handleBack = useCallback(() => {
    activeIdRef.current = null;
    activeMemberIdsRef.current = [];
    setActiveId(null);
    setDetailsOpen(false);
  }, []);

  const handleMessageSent = useCallback((message: WhatsAppMessage) => {
    // A slow upload can finish after the agent switches conversations.
    if (message.conversation_id !== activeIdRef.current) return;
    setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
  }, []);

  const handlePairReplyQueued = useCallback(() => {
    if (!activePair) return;
    const selectedId = activePair.id;
    void (async () => {
      const result = await fetchPairedMessages(createClient(), activePair.pair);
      if (activeIdRef.current === selectedId) {
        setMessages(result.data);
        setMessagesError(result.error);
      }
      await reloadInbox();
    })();
  }, [activePair, reloadInbox]);

  const handleConversationChanged = useCallback(() => {
    if (activeIdRef.current) void hydrateConversation(activeIdRef.current);
  }, [hydrateConversation]);

  const hasActiveConversation = Boolean(activeItem);

  if (inboxStatus !== "ready") {
    return <div className="flex h-full items-center justify-center bg-background px-6 text-center">
      {inboxStatus === "loading" ? <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><span className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />Verificando conversas e vínculos…</div>
        : <div role="alert" className="max-w-sm space-y-3">
          <p className="text-sm font-medium">Não foi possível confirmar os vínculos das conversas. Atendimento pausado nesta tela.</p>
          <Button variant="outline" onClick={() => void reloadInbox(true)}>Tentar novamente</Button>
        </div>}
    </div>;
  }

  return (
    <div className="flex h-full overflow-hidden">
      <div
        className={cn(
          "h-full xl:flex xl:flex-none",
          hasActiveConversation ? "hidden xl:flex" : "flex flex-1",
        )}
      >
        <ConversationList
          conversations={items}
          loading={false}
          activeConversationId={activeId}
          channelNames={channelNames}
          onSelect={handleSelectConversation}
        />
      </div>

      <div
        className={cn(
          "h-full min-w-0 flex-1 flex-col xl:flex",
          hasActiveConversation ? "flex" : "hidden xl:flex",
        )}
      >
        {activeConversation && (
          <div className="flex shrink-0 justify-end border-b border-border bg-card px-3 py-1.5 xl:hidden">
            <Button variant="outline" size="sm" onClick={() => setDetailsOpen(true)}>
              <ContactRound aria-hidden="true" /> Detalhes e notas
            </Button>
          </div>
        )}
        {activeConversation && canManage && <div className="flex shrink-0 justify-end border-b border-border bg-card px-3 py-2">
          <PairCandidateAction key={activeConversation.id} conversationId={activeConversation.id}
            onLinked={() => { setInboxStatus('loading'); window.location.reload(); }} />
        </div>}
        <div className="min-h-0 flex-1">
          <MessageThread
            envioReal={envioReal}
            conversation={activeConversation}
            linkedPair={activePair}
            messages={messages}
            messagesError={messagesError}
            loading={messagesLoading}
            onMessageSent={handleMessageSent}
            onPairReplyQueued={handlePairReplyQueued}
            onConversationChanged={handleConversationChanged}
            onBack={handleBack}
          />
        </div>
      </div>

      {!activePair && <LeadSidebar conversation={activeConversation} currentUserId={currentUserId}
        mobileOpen={detailsOpen} onMobileOpenChange={setDetailsOpen} />}
    </div>
  );
}
