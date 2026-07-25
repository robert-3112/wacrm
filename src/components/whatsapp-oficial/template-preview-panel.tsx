"use client";

/**
 * Painel de preview: escolhe-se um template, preenche-se as variáveis e vê-se
 * o texto final como o cliente veria.
 *
 * O preview é REMOTO de propósito, mesmo sendo texto. A rota
 * `/templates/preview` renderiza a partir da coluna `componentes` — o blob
 * verbatim da Meta, que a lista do catálogo nem carrega — usando exatamente o
 * mesmo `renderTemplatePreview` do resto do subsistema. Reimplementar a
 * substituição de `{{N}}` aqui no cliente criaria uma segunda verdade sobre o
 * que vai ser enviado, e a tela existe justamente para ninguém precisar
 * adivinhar isso.
 *
 * Nada aqui envia nada. Este painel não chama `/templates/enviar`: o envio 1:1
 * é ação da conversa, e um botão de envio ao lado de um campo de teste é o
 * caminho mais curto para alguém disparar template real num lead achando que
 * estava só conferindo o texto.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Eye, Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { montarValoresPreview, previewTemplate } from "@/lib/whatsapp-oficial/gestao-actions";
import { rotuloStatusTemplate, templatePodeEnviar } from "@/lib/whatsapp-oficial/gestao-erros";
import type {
  TemplatePreviewResposta,
  TemplateVariaveis,
  WhatsAppTemplate,
} from "@/types/whatsapp-oficial";

const VARIAVEIS_VAZIAS: TemplateVariaveis = { cabecalho: [], corpo: [], botoes: [] };

interface ValoresDigitados {
  cabecalho: Record<number, string>;
  corpo: Record<number, string>;
}

const DIGITADOS_VAZIOS: ValoresDigitados = { cabecalho: {}, corpo: {} };

export function TemplatePreviewPanel({ template }: { template: WhatsAppTemplate | null }) {
  const [digitados, setDigitados] = useState<ValoresDigitados>(DIGITADOS_VAZIOS);
  const [resposta, setResposta] = useState<TemplatePreviewResposta | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const templateId = template?.id ?? null;

  // Valores digitados pertencem ao template escolhido: mantê-los ao trocar de
  // template colocaria o {{1}} de um no {{1}} do outro, e o preview ficaria
  // plausível e errado.
  useEffect(() => {
    setDigitados(DIGITADOS_VAZIOS);
    setResposta(null);
    setErro(null);
  }, [templateId]);

  const variaveis = useMemo(
    () => resposta?.variaveis ?? template?.variaveis ?? VARIAVEIS_VAZIAS,
    [resposta, template],
  );

  // Guarda a requisição em voo para descartar resposta atrasada (o operador
  // digita rápido; sem isto o texto de uma tecla antiga sobrescreve o atual).
  const abortRef = useRef<AbortController | null>(null);

  const gerarPreview = useCallback(
    async (id: string, atuais: ValoresDigitados, exigidos: TemplateVariaveis) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setCarregando(true);
      setErro(null);
      try {
        const valores = montarValoresPreview(
          { cabecalho: exigidos.cabecalho, corpo: exigidos.corpo },
          atuais,
        );
        const r = await previewTemplate(id, valores, controller.signal);
        if (controller.signal.aborted) return;
        if (!r.ok) {
          setErro(r.mensagem);
          setResposta(null);
        } else {
          setResposta(r.data);
        }
      } catch {
        // Só sobra o AbortError, que `requisitar` relança — troca de template
        // ou nova tecla, não é erro de tela.
        return;
      } finally {
        if (!controller.signal.aborted) setCarregando(false);
      }
    },
    [],
  );

  // Primeiro preview assim que um template é escolhido, ainda sem valores:
  // mostra o texto com os `{{N}}` no lugar e a validação já apontando o que
  // falta, em vez de um painel em branco esperando o operador adivinhar.
  useEffect(() => {
    if (!templateId) return;
    void gerarPreview(templateId, DIGITADOS_VAZIOS, template?.variaveis ?? VARIAVEIS_VAZIAS);
  }, [templateId, template?.variaveis, gerarPreview]);

  useEffect(() => () => abortRef.current?.abort(), []);

  if (!template) {
    return (
      <div className="rounded-lg border border-dashed border-border p-6 text-center">
        <Eye className="mx-auto size-5 text-muted-foreground" />
        <p className="mt-2 text-sm text-muted-foreground">
          Escolha um template no catálogo para ver o preview e testar as variáveis.
        </p>
      </div>
    );
  }

  const setValor = (onde: "cabecalho" | "corpo", indice: number, valor: string) => {
    setDigitados((prev) => ({ ...prev, [onde]: { ...prev[onde], [indice]: valor } }));
  };

  const semVariaveis = variaveis.cabecalho.length === 0 && variaveis.corpo.length === 0;
  const validacao = resposta?.validacao ?? null;
  const preview = resposta?.preview ?? null;

  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-heading text-sm font-semibold text-foreground">Preview</h2>
        <Badge variant="outline">{template.nome}</Badge>
        <Badge variant="outline">{template.idioma}</Badge>
        {!templatePodeEnviar(template.status_aprovacao) && (
          <Badge variant="secondary">
            {rotuloStatusTemplate(template.status_aprovacao)} — não pode ser enviado
          </Badge>
        )}
      </div>

      {semVariaveis ? (
        <p className="text-xs text-muted-foreground">
          Este template não tem variáveis — o texto abaixo é exatamente o que sai.
        </p>
      ) : (
        <div className="space-y-3">
          {variaveis.cabecalho.length > 0 && (
            <BlocoVariaveis
              titulo="Cabeçalho"
              onde="cabecalho"
              indices={variaveis.cabecalho}
              valores={digitados.cabecalho}
              onChange={setValor}
            />
          )}
          {variaveis.corpo.length > 0 && (
            <BlocoVariaveis
              titulo="Corpo"
              onde="corpo"
              indices={variaveis.corpo}
              valores={digitados.corpo}
              onChange={setValor}
            />
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={carregando}
            onClick={() => void gerarPreview(template.id, digitados, variaveis)}
          >
            {carregando ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : (
              <Eye data-icon="inline-start" />
            )}
            Atualizar preview
          </Button>
        </div>
      )}

      {variaveis.botoes.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Botões: {variaveis.botoes.map((b) => b.tipo || "?").join(", ")}. Variáveis de URL de
          botão não são preenchidas por este preview.
        </p>
      )}

      {erro && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Não foi possível gerar o preview</AlertTitle>
          <AlertDescription>{erro}</AlertDescription>
        </Alert>
      )}

      {validacao && !validacao.ok && (
        <Alert>
          <AlertTriangle />
          <AlertTitle>Faltam valores</AlertTitle>
          <AlertDescription>
            <ul className="ml-4 list-disc">
              {validacao.faltando.map((f) => (
                <li key={f.onde}>
                  {f.onde === "corpo" ? "Corpo" : "Cabeçalho"}: {f.fornecidas} de {f.exigidas}{" "}
                  {f.exigidas === 1 ? "variável preenchida" : "variáveis preenchidas"}.
                </li>
              ))}
            </ul>
            <p className="mt-1">
              O que ficar sem valor continua aparecendo como <code>{"{{N}}"}</code> — o envio real
              é recusado pelo banco nesse estado.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {preview && (
        <div className="space-y-2 rounded-lg bg-muted/50 p-3">
          {preview.cabecalho && (
            <p className="text-sm font-semibold break-words whitespace-pre-wrap text-foreground">
              {preview.cabecalho}
            </p>
          )}
          <p className="text-sm break-words whitespace-pre-wrap text-foreground">
            {preview.corpo || <span className="text-muted-foreground">(corpo vazio)</span>}
          </p>
          {preview.rodape && (
            <p className="text-xs break-words whitespace-pre-wrap text-muted-foreground">
              {preview.rodape}
            </p>
          )}
          {preview.botoes.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-t border-border pt-2">
              {preview.botoes.map((b) => (
                <Badge key={b.indice} variant="outline">
                  {b.texto || b.tipo}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BlocoVariaveis({
  titulo,
  onde,
  indices,
  valores,
  onChange,
}: {
  titulo: string;
  onde: "cabecalho" | "corpo";
  indices: number[];
  valores: Record<number, string>;
  onChange: (onde: "cabecalho" | "corpo", indice: number, valor: string) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-xs tracking-wide text-muted-foreground uppercase">{titulo}</legend>
      {indices.map((indice) => {
        const id = `var-${onde}-${indice}`;
        return (
          <div key={indice} className="flex items-center gap-2">
            <Label htmlFor={id} className="w-12 shrink-0 font-mono text-xs">
              {`{{${indice}}}`}
            </Label>
            <Input
              id={id}
              value={valores[indice] ?? ""}
              onChange={(e) => onChange(onde, indice, e.target.value)}
              placeholder={`Valor de {{${indice}}}`}
              maxLength={1024}
            />
          </div>
        );
      })}
    </fieldset>
  );
}
