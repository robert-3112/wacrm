"use client";

/**
 * Text-only composer for the official-channel inbox (Fase 6, mission item
 * 3). Calls the already-existing `POST /api/whatsapp-oficial/messages/send`
 * route (`src/lib/whatsapp-oficial/inbox-actions.ts#sendTextMessage`) —
 * that route ONLY inserts the message + enqueues `whatsapp_outbox`, it does
 * not call the Meta Graph API itself (see that route's doc comment), so a
 * successful response here means "queued", not "delivered"; delivery
 * status arrives later via the webhook → realtime → `MessageBubble`'s
 * status ticks.
 *
 * WRITTEN FROM SCRATCH for this mission — deliberately NOT a port of
 * `src/components/inbox/message-composer.tsx` (WACRM original): that
 * component's attach menu, voice recorder, AI draft button, template
 * picker and interactive-message builder are all out of scope here (no
 * media send in this phase, no templates/AI/interactive concept in this
 * schema at all). What's left after removing all of that is small enough
 * that porting the WACRM file and deleting 80% of it would have produced
 * more confusing code than writing the plain textarea+button this phase
 * actually needs.
 *
 * TODO (future phase, out of scope here — mission explicitly allows
 * deferring this: "Sem envio real de mídia nesta fase é aceitável"):
 * attachments (image/video/document/audio). `message-bubble.tsx` already
 * renders inbound media via the Fase 4 relay; only the send-side upload +
 * `POST /messages/send` media payload are missing.
 */

import { useCallback, useRef, useState, type KeyboardEvent } from "react";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { sendTextMessage } from "@/lib/whatsapp-oficial/inbox-actions";
import type { WhatsAppMessage } from "@/types/whatsapp-oficial";

const MAX_LENGTH = 4096;
const MAX_TEXTAREA_HEIGHT_PX = 120;

interface MessageComposerProps {
  conversationId: string;
  /** True when the conversation is closed or the lead has opted out — the
   *  route itself doesn't block on either, but sending into either state
   *  is not something the UI should make easy by accident. */
  disabled?: boolean;
  disabledReason?: string;
  onSent: (message: WhatsAppMessage) => void;
}

export function MessageComposer({
  conversationId,
  disabled = false,
  disabledReason,
  onSent,
}: MessageComposerProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`;
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || disabled) return;

    setSending(true);
    const result = await sendTextMessage(conversationId, trimmed);
    setSending(false);

    if (!result.ok) {
      toast.error(result.error);
      return;
    }

    setText("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    onSent(result.data.message);
  }, [text, sending, disabled, conversationId, onSent]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="border-t border-border bg-card p-3">
      {disabled && disabledReason && (
        <p className="mb-2 text-xs text-muted-foreground">{disabledReason}</p>
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            adjustHeight();
          }}
          onKeyDown={handleKeyDown}
          disabled={disabled || sending}
          maxLength={MAX_LENGTH}
          rows={1}
          placeholder={disabled ? "Envio desabilitado" : "Escreva uma mensagem..."}
          className={cn(
            "flex-1 resize-none rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50",
            (disabled || sending) && "cursor-not-allowed opacity-60",
          )}
        />
        <Button
          size="icon"
          disabled={!text.trim() || sending || disabled}
          onClick={() => void handleSend()}
          className="h-9 w-9 shrink-0 rounded-xl disabled:opacity-40"
          aria-label="Enviar mensagem"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
      <p className="mt-1 pl-1 text-[10px] text-muted-foreground">
        Apenas texto nesta fase — envio de mídia ainda não é suportado.
      </p>
    </div>
  );
}
