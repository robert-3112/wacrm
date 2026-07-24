"use client";

/**
 * Realtime subscription for the official-channel inbox (Fase 6).
 *
 * ADAPTED from `src/hooks/use-realtime.ts` (WACRM original — harvest matrix
 * area 7, "Realtime — hook de subscription global", classified "Reutilizar":
 * the technique itself — a single channel with unfiltered `postgres_changes`
 * subscriptions, security delegated entirely to RLS — carries over 1:1. What
 * changed is the tables (`whatsapp_conversations`/`whatsapp_messages`
 * instead of `conversations`/`messages`) and the payload types. Simplified
 * relative to the original's `page.tsx` consumer: this inbox's expected
 * event volume (one tenant's official WhatsApp channel) doesn't need the
 * WACRM version's in-flight-hydrate dedup bookkeeping — callers just re-fetch
 * the single row that changed (see `fetchConversationById` in
 * `lib/whatsapp-oficial/inbox-data.ts`), which is cheap at this scale.
 *
 * Security note (unchanged from the original, restated here because it's
 * the whole reason this hook is safe to ship with a completely unfiltered
 * subscription): Supabase Realtime enforces the SAME row-level-security
 * policies as a normal query. A corretor's session only receives
 * `postgres_changes` events for conversations/messages their RLS policy
 * would let them SELECT — the same `whatsapp_conversations_select`/
 * `whatsapp_messages_select` policies documented in
 * `docs/WHATSAPP-OFFICIAL-ARCHITECTURE.md`.
 */

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";
import type { WhatsAppConversation, WhatsAppMessage } from "@/types/whatsapp-oficial";

interface RealtimeEvent<T> {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: T;
  old: Partial<T>;
}

interface UseWhatsAppOficialRealtimeOptions {
  onConversationEvent?: (event: RealtimeEvent<WhatsAppConversation>) => void;
  onMessageEvent?: (event: RealtimeEvent<WhatsAppMessage>) => void;
  enabled?: boolean;
}

export function useWhatsAppOficialRealtime({
  onConversationEvent,
  onMessageEvent,
  enabled = true,
}: UseWhatsAppOficialRealtimeOptions) {
  const [isConnected, setIsConnected] = useState(false);
  const channelRef = useRef<RealtimeChannel | null>(null);

  // Latest callbacks live in refs so the subscription effect below doesn't
  // need to re-run (and re-subscribe) every time the parent re-renders with
  // fresh closures — same reasoning as the WACRM original.
  const onConversationRef = useRef(onConversationEvent);
  const onMessageRef = useRef(onMessageEvent);
  useEffect(() => {
    onConversationRef.current = onConversationEvent;
    onMessageRef.current = onMessageEvent;
  });

  useEffect(() => {
    if (!enabled) return;

    const supabase = createClient();
    const channel = supabase
      .channel("whatsapp-oficial-inbox")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "whatsapp_conversations" },
        (payload) => {
          onConversationRef.current?.({
            eventType: payload.eventType as RealtimeEvent<WhatsAppConversation>["eventType"],
            new: payload.new as WhatsAppConversation,
            old: payload.old as Partial<WhatsAppConversation>,
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "whatsapp_messages" },
        (payload) => {
          onMessageRef.current?.({
            eventType: payload.eventType as RealtimeEvent<WhatsAppMessage>["eventType"],
            new: payload.new as WhatsAppMessage,
            old: payload.old as Partial<WhatsAppMessage>,
          });
        },
      )
      .subscribe((status) => setIsConnected(status === "SUBSCRIBED"));

    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
      setIsConnected(false);
    };
  }, [enabled]);

  return { isConnected };
}
