"use client";

import { useRef, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { sendPairedReply } from "@/lib/whatsapp-oficial/inbox-actions";

export function PairedTextComposer({ pairId, disabled, disabledReason, envioReal, onQueued }: {
  pairId: string;
  disabled: boolean;
  disabledReason?: string;
  envioReal: boolean;
  onQueued: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const requestId = useRef<string | null>(null);

  const send = async () => {
    const content = text.trim();
    if (disabled || sending || !content) return;
    setSending(true);
    const result = await sendPairedReply(pairId, content, requestId.current ??= crypto.randomUUID());
    setSending(false);
    if (!result.ok) { toast.error(result.error); return; }
    setText("");
    requestId.current = null;
    toast.success(result.data.replayed ? "Resposta já estava na fila." : "Resposta colocada na fila.");
    onQueued();
  };

  return <div className="space-y-2 border-t border-border bg-card p-3">
    {disabledReason && <p role="status" className="text-xs text-muted-foreground">{disabledReason}</p>}
    <div className="flex items-end gap-2">
      <textarea value={text} onChange={event => { setText(event.target.value); requestId.current = null; }}
        onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}
        disabled={disabled || sending} maxLength={4096} rows={2}
        placeholder={disabled ? "Resposta vinculada indisponível" : "Responder pelo histórico que recebeu a mensagem…"}
        aria-label="Resposta de texto pela conversa recebida"
        className="min-h-12 flex-1 resize-y rounded-xl border border-border bg-muted px-4 py-2 text-sm outline-none focus:border-primary/50" />
      <Button size="icon" className="shrink-0" disabled={disabled || sending || !text.trim()} onClick={() => void send()} aria-label="Enfileirar resposta vinculada">
        {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
      </Button>
    </div>
    {!envioReal && <p className="text-[11px] text-amber-700 dark:text-amber-400">Este ambiente informa envio real desligado; a fila compartilhada pode ser processada por outro ambiente.</p>}
  </div>;
}
