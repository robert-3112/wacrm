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
 * scope: no deep-link URL sync, no contact-panel collapse toggle, no
 * WhatsApp-connection banner — none of those are mission requirements, and
 * this inbox is small enough (one tenant, one official channel) that they
 * would be complexity without a corresponding need.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import {
  fetchConversationById,
  fetchConversations,
  fetchMessages,
} from "@/lib/whatsapp-oficial/inbox-data";
import { markConversationRead } from "@/lib/whatsapp-oficial/inbox-actions";
import { useWhatsAppOficialRealtime } from "@/hooks/use-whatsapp-oficial-realtime";
import { ConversationList } from "@/components/whatsapp-oficial/conversation-list";
import { MessageThread } from "@/components/whatsapp-oficial/message-thread";
import { LeadSidebar } from "@/components/whatsapp-oficial/lead-sidebar";
import { cn } from "@/lib/utils";
import type { WhatsAppConversation, WhatsAppMessage } from "@/types/whatsapp-oficial";

export default function WhatsAppOficialInboxPage() {
  const [conversations, setConversations] = useState<WhatsAppConversation[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<WhatsAppMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId],
  );

  // Mirrors `activeId` for the realtime message handler below, which is
  // registered once (empty dep) and would otherwise close over a stale
  // value — same pattern the WACRM original documents on its
  // `knownConvIdsRef`.
  const activeIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  // Current user id — used by the notes panel to label the caller's own
  // notes "Você" instead of resolving their name through `corretores`.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!cancelled) setCurrentUserId(user?.id ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Initial conversation list load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data, error } = await fetchConversations(supabase);
      if (cancelled) return;
      if (error) toast.error("Não foi possível carregar as conversas.");
      setConversations(data);
      setConversationsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Messages fetch whenever the selected conversation changes.
  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    setMessagesLoading(true);
    (async () => {
      const supabase = createClient();
      const { data, error } = await fetchMessages(supabase, activeId);
      if (cancelled) return;
      if (error) toast.error("Não foi possível carregar as mensagens.");
      setMessages(data);
      setMessagesLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  // Mark-as-read: fires once per conversation selection that has unread
  // messages. Optimistically zeroes the local badge immediately (matches
  // the server-side effect of the route it calls) so the count doesn't
  // flicker while the request is in flight.
  useEffect(() => {
    if (!activeConversation || activeConversation.nao_lidas_corretor <= 0) return;
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
  }, [activeConversation?.id]);

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
        if (msg.conversation_id !== activeIdRef.current) return;
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
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

  const handleSelectConversation = useCallback((conversation: WhatsAppConversation) => {
    setActiveId((prev) => (prev === conversation.id ? prev : conversation.id));
  }, []);

  const handleBack = useCallback(() => {
    setActiveId(null);
  }, []);

  const handleMessageSent = useCallback((message: WhatsAppMessage) => {
    setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
  }, []);

  const handleConversationChanged = useCallback(() => {
    if (activeIdRef.current) void hydrateConversation(activeIdRef.current);
  }, [hydrateConversation]);

  const hasActiveConversation = Boolean(activeId);

  return (
    <div className="flex h-full overflow-hidden">
      <div
        className={cn(
          "h-full lg:flex lg:flex-none",
          hasActiveConversation ? "hidden lg:flex" : "flex flex-1",
        )}
      >
        <ConversationList
          conversations={conversations}
          loading={conversationsLoading}
          activeConversationId={activeId}
          onSelect={handleSelectConversation}
        />
      </div>

      <div
        className={cn(
          "h-full min-w-0 flex-1 lg:flex",
          hasActiveConversation ? "flex" : "hidden lg:flex",
        )}
      >
        <MessageThread
          conversation={activeConversation}
          messages={messages}
          loading={messagesLoading}
          onMessageSent={handleMessageSent}
          onConversationChanged={handleConversationChanged}
          onBack={handleBack}
        />
      </div>

      <LeadSidebar conversation={activeConversation} currentUserId={currentUserId} />
    </div>
  );
}
