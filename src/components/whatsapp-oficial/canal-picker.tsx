"use client";

/**
 * Seletor de canal compartilhado pelas telas de gestão.
 *
 * Com UM canal só (o cenário do SUNT hoje, quando houver canal) o `<select>`
 * vira ruído: mostra-se o canal como texto. O seletor só aparece quando há
 * escolha real a fazer.
 */

import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { WhatsAppCanal } from "@/types/whatsapp-oficial";

export function statusCanalVariant(status: string): "default" | "secondary" | "destructive" {
  if (status === "ativo") return "default";
  if (status === "pausado") return "secondary";
  return "destructive";
}

export function CanalResumo({ canal }: { canal: WhatsAppCanal }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className="font-medium text-foreground">{canal.nome}</span>
      {canal.numero_display && (
        <span className="text-xs text-muted-foreground">{canal.numero_display}</span>
      )}
      <Badge variant="outline">{canal.provider}</Badge>
      <Badge variant={statusCanalVariant(canal.status)}>{canal.status}</Badge>
    </span>
  );
}

export function CanalPicker({
  canais,
  canalId,
  onChange,
}: {
  canais: WhatsAppCanal[];
  canalId: string;
  onChange: (id: string) => void;
}) {
  const selecionado = canais.find((c) => c.id === canalId) ?? null;

  if (canais.length <= 1) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Canal:</span>
        {selecionado ? <CanalResumo canal={selecionado} /> : <span>—</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Label htmlFor="canal-picker" className="text-sm text-muted-foreground">
        Canal
      </Label>
      <Select value={canalId} onValueChange={(v) => v && onChange(String(v))}>
        <SelectTrigger id="canal-picker" className="min-w-56">
          {/* O valor cru é um uuid — sem esta função de formatação o gatilho
              mostraria o id em vez do nome do canal. */}
          <SelectValue>
            {(v: string | null) => canais.find((c) => c.id === v)?.nome ?? "Escolha um canal"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {canais.map((canal) => (
            <SelectItem key={canal.id} value={canal.id}>
              {canal.nome}
              {canal.numero_display ? ` · ${canal.numero_display}` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selecionado && (
        <>
          <Badge variant="outline">{selecionado.provider}</Badge>
          <Badge variant={statusCanalVariant(selecionado.status)}>{selecionado.status}</Badge>
        </>
      )}
    </div>
  );
}
