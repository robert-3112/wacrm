"use client";

/**
 * Single message bubble for the official-channel inbox thread (Fase 6,
 * mission item 2 — "bolhas de mensagem por direção/status").
 *
 * ADAPTED IN SPIRIT from `src/components/inbox/message-bubble.tsx` (WACRM
 * original): same visual language (rounded bubble, outbound on the right
 * on the primary fill, inbound on the left on the muted surface, status
 * ticks on outbound only), rebuilt against this schema's
 * `WhatsAppMessage` (`direction: 'inbound'|'outbound'` instead of
 * `sender_type`, `message_type` instead of `content_type`, DB status
 * vocabulary `pendente/enviada/entregue/lida/falhou/recebida` instead of
 * `sending/sent/delivered/read/failed` — see `lib/whatsapp-oficial/status.ts`).
 *
 * Media rendering (image/video/audio/document) points `src`/`href` at
 * `message.media_url`, which for INBOUND media is already a same-origin
 * relay path (`/api/whatsapp-oficial/media/[mediaId]`, Fase 4 — cookie-
 * authenticated, so a plain `<img src>`/`<video src>` works with no manual
 * fetch-to-blob dance, unlike the WACRM original's proxy handling). This is
 * read-only display of media the webhook already relays — NOT the same
 * thing as sending media, which stays out of scope for this phase (see
 * `message-composer.tsx`'s TODO).
 */

import { useState } from "react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  Check,
  CheckCheck,
  Clock,
  FileText,
  ImageOff,
  LayoutTemplate,
  MapPin,
  MessageSquareWarning,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { WhatsAppMessage, WhatsAppMessageStatus } from "@/types/whatsapp-oficial";

function StatusIcon({ status }: { status: WhatsAppMessageStatus }) {
  switch (status) {
    case "pendente":
      return <Clock className="h-3 w-3 text-primary-foreground/70" />;
    case "enviada":
      return <Check className="h-3 w-3 text-primary-foreground/70" />;
    case "entregue":
      return <CheckCheck className="h-3 w-3 text-primary-foreground/70" />;
    case "lida":
      return <CheckCheck className="h-3 w-3 text-sky-300" />;
    case "falhou":
      return <XCircle className="h-3 w-3 text-red-300" />;
    default:
      return null;
  }
}

function MediaUnavailable({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-black/10 px-3 py-2 text-xs">
      <ImageOff className="h-4 w-4 shrink-0" />
      <span>{label} indisponível</span>
    </div>
  );
}

function MessageMediaImage({ url, alt }: { url: string; alt: string }) {
  const [error, setError] = useState(false);
  if (error) return <MediaUnavailable label="Imagem" />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt}
      className="max-h-64 max-w-60 rounded-lg object-cover"
      onError={() => setError(true)}
    />
  );
}

function MessageBody({ message }: { message: WhatsAppMessage }) {
  switch (message.message_type) {
    case "text":
      return <p className="text-sm break-words whitespace-pre-wrap">{message.content}</p>;

    case "image":
    case "sticker":
      return (
        <div>
          {message.media_url ? (
            <MessageMediaImage url={message.media_url} alt={message.content ?? "Imagem recebida"} />
          ) : (
            <MediaUnavailable label="Imagem" />
          )}
          {message.content && (
            <p className="mt-1 text-sm break-words whitespace-pre-wrap">{message.content}</p>
          )}
        </div>
      );

    case "video":
      return (
        <div>
          {message.media_url ? (
            <video src={message.media_url} controls className="max-h-64 max-w-60 rounded-lg" />
          ) : (
            <MediaUnavailable label="Vídeo" />
          )}
          {message.content && (
            <p className="mt-1 text-sm break-words whitespace-pre-wrap">{message.content}</p>
          )}
        </div>
      );

    case "audio":
      return message.media_url ? (
        <audio src={message.media_url} controls className="max-w-60" />
      ) : (
        <MediaUnavailable label="Áudio" />
      );

    case "document":
      return message.media_url ? (
        <a
          href={message.media_url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-lg bg-black/10 px-3 py-2 text-sm hover:bg-black/20"
        >
          <FileText className="h-5 w-5 shrink-0" />
          <span className="truncate">{message.content || "Documento"}</span>
        </a>
      ) : (
        <MediaUnavailable label="Documento" />
      );

    case "location":
      return (
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="h-4 w-4 shrink-0" />
          <span>{message.content || "Localização compartilhada"}</span>
        </div>
      );

    case "template":
      return (
        <div>
          <span className="mb-1 inline-flex items-center gap-1 rounded bg-black/10 px-1.5 py-0.5 text-[10px] font-medium">
            <LayoutTemplate className="h-3 w-3" />
            Modelo
          </span>
          {message.content && (
            <p className="text-sm break-words whitespace-pre-wrap">{message.content}</p>
          )}
        </div>
      );

    case "interactive":
    case "contacts":
    case "unsupported":
    default:
      return message.content ? (
        <p className="text-sm break-words whitespace-pre-wrap">{message.content}</p>
      ) : (
        <div className="flex items-center gap-2 text-sm opacity-80">
          <MessageSquareWarning className="h-4 w-4 shrink-0" />
          <span>Tipo de mensagem não suportado</span>
        </div>
      );
  }
}

export function MessageBubble({ message }: { message: WhatsAppMessage }) {
  const isOutbound = message.direction === "outbound";
  const timestampSource = message.wpp_timestamp ?? message.created_at;
  const time = format(new Date(timestampSource), "HH:mm", { locale: ptBR });

  return (
    <div className={cn("flex flex-col", isOutbound ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[75%] rounded-2xl px-3 py-2",
          isOutbound
            ? "rounded-br-md bg-primary text-primary-foreground"
            : "rounded-bl-md bg-muted text-foreground",
        )}
      >
        <MessageBody message={message} />
        <div
          className={cn(
            "mt-1 flex items-center gap-1",
            isOutbound ? "justify-end" : "justify-start",
          )}
        >
          <span
            className={cn(
              "text-[10px]",
              isOutbound ? "text-primary-foreground/70" : "text-muted-foreground",
            )}
          >
            {time}
          </span>
          {isOutbound && <StatusIcon status={message.status} />}
        </div>
      </div>
      {isOutbound && message.status === "falhou" && message.erro_detalhe && (
        <span className="mt-0.5 max-w-[75%] text-[10px] text-destructive">
          {message.erro_detalhe}
        </span>
      )}
    </div>
  );
}
