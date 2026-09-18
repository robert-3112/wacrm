"use client";

/**
 * Text and guarded JPG/PNG/PDF/MP3/MP4 composer for the official inbox. Both paths
 * enqueue an outbox job; a successful response means queued, not delivered.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Loader2, Paperclip, Send, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { sendTextMessage } from "@/lib/whatsapp-oficial/inbox-actions";
import { asyncMediaAvailability, sendInboxMedia } from "@/lib/whatsapp-oficial/media-action";
import type { WhatsAppMessage } from "@/types/whatsapp-oficial";

const MAX_LENGTH = 4096;
const MAX_CAPTION_LENGTH = 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_OTHER_MEDIA_BYTES = 16 * 1024 * 1024;
const MAX_TEXTAREA_HEIGHT_PX = 120;

interface MessageComposerProps {
  conversationId: string;
  /** UI guard; the enqueue RPC rechecks these conditions atomically. */
  disabled?: boolean;
  disabledReason?: string;
  /**
   * `travas.envioMetaLigado` — já combina `WHATSAPP_OUTBOUND_MODE` com a trava
   * do provider.
   *
   * OBRIGATORIO de proposito, e sem valor padrao: com o envio real desligado a
   * mensagem e gravada, enfileirada e marcada como `simulado` pelo worker — e a
   * tela mostrava a bolha roxa igualzinha a uma mensagem entregue, com um
   * reloginho que nunca resolve. O operador conclui que falou com o cliente e
   * nao falou. Foi o que aconteceu no primeiro uso real.
   *
   * Se alguem acrescentar outro ponto de envio, o TypeScript obriga a decidir o
   * que dizer ao operador em vez de herdar um default otimista.
   */
  envioReal: boolean;
  onSent: (message: WhatsAppMessage) => void;
}

export function MessageComposer({
  conversationId,
  disabled = false,
  disabledReason,
  envioReal,
  onSent,
}: MessageComposerProps) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [mediaAvailable, setMediaAvailable] = useState(false);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRequestIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!envioReal) return;
    let mounted = true;
    void asyncMediaAvailability().then((available) => {
      if (mounted) setMediaAvailable(available);
    });
    return () => { mounted = false; };
  }, [envioReal]);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`;
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if ((!trimmed && !file) || sending || disabled) return;

    if (file && (!mediaAvailable || !envioReal)) {
      toast.error("Envio de mídia indisponível neste momento.");
      return;
    }
    if (file?.type === "audio/mpeg" && trimmed) {
      toast.error("Áudio não aceita legenda; envie o texto separadamente.");
      return;
    }

    setSending(true);
    let result;
    try {
      result = file
        ? await sendInboxMedia(
            conversationId,
            mediaRequestIdRef.current ??= crypto.randomUUID(),
            file,
            trimmed,
          )
        : await sendTextMessage(conversationId, trimmed);
    } catch {
      toast.error("Falha inesperada ao enfileirar a mensagem.");
      return;
    } finally {
      setSending(false);
    }

    if (!result.ok) {
      toast.error(result.error);
      return;
    }

    setText("");
    setFile(null);
    mediaRequestIdRef.current = null;
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    onSent(result.data.message);
  }, [text, file, sending, disabled, mediaAvailable, envioReal, conversationId, onSent]);

  const handleFileSelected = useCallback((selected: File | undefined) => {
    if (!selected) return;
    const max = selected.type.startsWith("image/") ? MAX_IMAGE_BYTES : MAX_OTHER_MEDIA_BYTES;
    if (!["image/jpeg", "image/png", "application/pdf", "audio/mpeg", "video/mp4"].includes(selected.type)) {
      toast.error("Anexe somente JPG, PNG, PDF, MP3 ou MP4.");
    } else if (selected.size === 0 || selected.size > max) {
      toast.error(`Arquivo vazio ou acima do limite de ${max / 1024 / 1024} MB.`);
    } else if (selected.type === "audio/mpeg" && text.trim()) {
      toast.error("Envie o texto separadamente antes de anexar um áudio.");
    } else if (text.length > MAX_CAPTION_LENGTH) {
      toast.error("Reduza o texto para até 1024 caracteres antes de anexar.");
    } else {
      setFile(selected);
      mediaRequestIdRef.current = null;
      return;
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [text]);

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
      {file && (
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs">
          <Paperclip className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate" title={file.name}>{file.name}</span>
          <Button
            variant="ghost" size="icon-sm" disabled={sending}
            aria-label="Remover anexo"
            onClick={() => {
              setFile(null);
              mediaRequestIdRef.current = null;
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
          ><X className="h-4 w-4" /></Button>
        </div>
      )}
      <div className="flex items-end gap-2">
        {mediaAvailable && envioReal && (
          <>
            <input
              ref={fileInputRef} type="file" className="sr-only"
              accept=".jpg,.jpeg,.png,.pdf,.mp3,.mp4,image/jpeg,image/png,application/pdf,audio/mpeg,video/mp4"
              aria-label="Selecionar imagem, PDF, áudio MP3 ou vídeo MP4"
              onChange={(event) => handleFileSelected(event.target.files?.[0])}
            />
            <Button
              size="icon" variant="outline" disabled={disabled || sending}
              aria-label="Anexar JPG, PNG, PDF, MP3 ou MP4"
              onClick={() => fileInputRef.current?.click()}
              className="h-9 w-9 shrink-0 rounded-xl"
            ><Paperclip className="h-4 w-4" /></Button>
          </>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (file) mediaRequestIdRef.current = null;
            adjustHeight();
          }}
          onKeyDown={handleKeyDown}
          disabled={disabled || sending || file?.type === "audio/mpeg"}
          maxLength={file ? MAX_CAPTION_LENGTH : MAX_LENGTH}
          rows={1}
          placeholder={disabled ? "Envio desabilitado" : file?.type === "audio/mpeg" ? "Áudio sem legenda" : file ? "Legenda (opcional)" : "Escreva uma mensagem..."}
          className={cn(
            "flex-1 resize-none rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50",
            (disabled || sending) && "cursor-not-allowed opacity-60",
          )}
        />
        <Button
          size="icon"
          disabled={(!text.trim() && !file) || sending || disabled}
          onClick={() => void handleSend()}
          className="h-9 w-9 shrink-0 rounded-xl disabled:opacity-40"
          aria-label="Enviar mensagem"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
      {!envioReal && (
        <p className="mt-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
          Envio real DESLIGADO — o que você mandar aqui fica registrado na
          conversa, mas <strong>não chega ao cliente</strong>.
        </p>
      )}
      {mediaAvailable && envioReal && (
        <p className="mt-1 pl-1 text-[10px] text-muted-foreground">
          JPG/PNG até 5 MB; PDF/MP3/MP4 até 16 MB. Áudio sem legenda. Janela de 24 horas.
        </p>
      )}
    </div>
  );
}
