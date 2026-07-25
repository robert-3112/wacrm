"use client";

/**
 * Criação de campanha. Só grava um RASCUNHO — nenhum público é resolvido e
 * nada é enfileirado aqui; isso é decisão separada, na tela de detalhe.
 *
 * O formulário só manda o que foi preenchido: a montagem do payload vive em
 * `montarConfigCampanha`, que omite chave vazia em vez de mandar `[]`. Vale
 * relembrar por quê, porque a tentação de "mandar tudo sempre" é grande — no
 * vocabulário desta API lista vazia NÃO é "sem filtro": `bases_legais: []` com
 * a política padrão suprime todo mundo, e `janela_dias: []` bloqueia todos os
 * dias. Os dois erros são silenciosos depois de gravados.
 */

import { useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { criarCampanha, type FormularioCampanha } from "@/lib/whatsapp-oficial/gestao-actions";
import type { WhatsAppCanal, WhatsAppTemplate } from "@/types/whatsapp-oficial";

const POLITICAS_CONSENTIMENTO = [
  {
    value: "exigir_base_legal",
    label: "Exigir base legal",
    hint: "Só entra quem tem uma das bases legais listadas. É o padrão e o mais conservador.",
  },
  {
    value: "apenas_optout",
    label: "Apenas respeitar opt-out",
    hint: "Entra todo mundo que não pediu para sair. Use só com respaldo jurídico explícito.",
  },
] as const;

const POLITICAS_HANDOFF = [
  { value: "sophia_qualifica", label: "Sophia qualifica" },
  { value: "humano_direto", label: "Humano direto" },
  { value: "sophia_rodizio", label: "Sophia + rodízio" },
  { value: "personalizado", label: "Personalizado" },
] as const;

const BASES_LEGAIS = [
  { value: "fb_lead_form", label: "Formulário de lead (Meta)" },
  { value: "site_form", label: "Formulário do site" },
  { value: "opt_in_manual", label: "Opt-in registrado manualmente" },
  { value: "cliente_ativo", label: "Relacionamento com cliente ativo" },
] as const;

const DIAS = [
  { value: 1, label: "Seg" },
  { value: 2, label: "Ter" },
  { value: 3, label: "Qua" },
  { value: 4, label: "Qui" },
  { value: 5, label: "Sex" },
  { value: 6, label: "Sáb" },
  { value: 7, label: "Dom" },
] as const;

const SEM_TEMPLATE = "__sem_template__";

function paraNumero(valor: string): number | null {
  const t = valor.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export function CampanhaNovaDialog({
  canais,
  canalId,
  templates,
  templatesCarregando,
  onCriada,
}: {
  canais: WhatsAppCanal[];
  canalId: string;
  templates: WhatsAppTemplate[];
  templatesCarregando: boolean;
  onCriada: (broadcastId: string) => void;
}) {
  const [aberto, setAberto] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const [nome, setNome] = useState("");
  const [templateId, setTemplateId] = useState<string>(SEM_TEMPLATE);
  const [mensagemLivre, setMensagemLivre] = useState("");
  const [politicaConsentimento, setPoliticaConsentimento] = useState<string>("exigir_base_legal");
  const [basesLegais, setBasesLegais] = useState<string[]>(["fb_lead_form"]);
  const [politicaHandoff, setPoliticaHandoff] = useState<string>("sophia_qualifica");
  const [cooldownDias, setCooldownDias] = useState("");
  const [cadenciaSegundos, setCadenciaSegundos] = useState("");
  const [loteMax, setLoteMax] = useState("");
  const [limiteDiario, setLimiteDiario] = useState("");
  const [janelaInicio, setJanelaInicio] = useState("");
  const [janelaFim, setJanelaFim] = useState("");
  const [janelaDias, setJanelaDias] = useState<number[]>([]);
  const [etapas, setEtapas] = useState("");
  const [temperaturas, setTemperaturas] = useState("");
  const [tags, setTags] = useState("");
  const [semCorretor, setSemCorretor] = useState(false);

  const canal = canais.find((c) => c.id === canalId) ?? null;
  const aprovados = templates.filter((t) => t.status_aprovacao === "aprovado");
  const exigeBaseLegal = politicaConsentimento === "exigir_base_legal";
  const semBaseLegal = exigeBaseLegal && basesLegais.length === 0;
  const janelaPelaMetade = Boolean(janelaInicio) !== Boolean(janelaFim);

  const listaDeTexto = (valor: string): string[] =>
    valor
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);

  const resetar = () => {
    setNome("");
    setTemplateId(SEM_TEMPLATE);
    setMensagemLivre("");
    setPoliticaConsentimento("exigir_base_legal");
    setBasesLegais(["fb_lead_form"]);
    setPoliticaHandoff("sophia_qualifica");
    setCooldownDias("");
    setCadenciaSegundos("");
    setLoteMax("");
    setLimiteDiario("");
    setJanelaInicio("");
    setJanelaFim("");
    setJanelaDias([]);
    setEtapas("");
    setTemperaturas("");
    setTags("");
    setSemCorretor(false);
    setErro(null);
  };

  const handleSalvar = async () => {
    setErro(null);
    if (!nome.trim()) {
      setErro("Dê um nome à campanha.");
      return;
    }
    if (!canalId) {
      setErro("Escolha um canal antes de criar a campanha.");
      return;
    }

    const form: FormularioCampanha = {
      canalId,
      nome,
      templateId: templateId === SEM_TEMPLATE ? null : templateId,
      mensagemLivre,
      politicaConsentimento,
      basesLegais,
      politicaHandoff,
      cooldownDias: paraNumero(cooldownDias),
      cadenciaSegundos: paraNumero(cadenciaSegundos),
      loteMax: paraNumero(loteMax),
      limiteDiario: paraNumero(limiteDiario),
      janelaInicio,
      janelaFim,
      janelaDias,
      segmentacao: {
        etapas: listaDeTexto(etapas),
        temperaturas: listaDeTexto(temperaturas),
        tags: listaDeTexto(tags),
        semCorretor,
      },
    };

    setSalvando(true);
    const r = await criarCampanha(form);
    setSalvando(false);

    if (!r.ok) {
      setErro(r.mensagem);
      return;
    }

    toast.success("Rascunho de campanha criado. Nada foi enfileirado ainda.");
    setAberto(false);
    resetar();
    onCriada(r.data.broadcast_id);
  };

  return (
    <Dialog
      open={aberto}
      onOpenChange={(v: boolean) => {
        setAberto(v);
        if (!v) resetar();
      }}
    >
      <DialogTrigger render={<Button size="sm" disabled={!canalId} />}>
        <Plus data-icon="inline-start" />
        Nova campanha
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Nova campanha</DialogTitle>
          <DialogDescription>
            Criar só grava um rascunho{canal ? ` no canal ${canal.nome}` : ""}. O público é
            resolvido depois, na tela da campanha, e o envio ainda precisa de aprovação de outra
            pessoa.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="campanha-nome">Nome da campanha</Label>
            <Input
              id="campanha-nome"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="Ex.: Reativação do bolsão — julho"
              maxLength={200}
            />
          </div>

          <fieldset className="space-y-3">
            <legend className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Conteúdo
            </legend>
            <div className="space-y-1.5">
              <Label htmlFor="campanha-template">Template aprovado</Label>
              <Select value={templateId} onValueChange={(v) => v && setTemplateId(String(v))}>
                <SelectTrigger id="campanha-template" className="w-full">
                  <SelectValue>
                    {(v: string | null) =>
                      v && v !== SEM_TEMPLATE
                        ? (aprovados.find((t) => t.id === v)?.nome ?? "Template selecionado")
                        : "Sem template"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SEM_TEMPLATE}>Sem template</SelectItem>
                  {aprovados.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.nome} · {t.idioma}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {templatesCarregando
                  ? "Carregando templates do canal..."
                  : aprovados.length === 0
                    ? "Nenhum template aprovado neste canal — sincronize o catálogo antes."
                    : "Só templates aprovados aparecem aqui; é o único status que o envio aceita."}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="campanha-mensagem">Mensagem livre (opcional)</Label>
              <Textarea
                id="campanha-mensagem"
                value={mensagemLivre}
                onChange={(e) => setMensagemLivre(e.target.value)}
                placeholder="Só é entregue a quem está dentro da janela de 24h. Fora dela, apenas template."
                className="min-h-20"
              />
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Consentimento
            </legend>
            <div className="space-y-1.5">
              <Label htmlFor="campanha-consentimento">Política</Label>
              <Select
                value={politicaConsentimento}
                onValueChange={(v) => v && setPoliticaConsentimento(String(v))}
              >
                <SelectTrigger id="campanha-consentimento" className="w-full">
                  <SelectValue>
                    {(v: string | null) =>
                      POLITICAS_CONSENTIMENTO.find((p) => p.value === v)?.label ??
                      "Exigir base legal"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {POLITICAS_CONSENTIMENTO.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {POLITICAS_CONSENTIMENTO.find((p) => p.value === politicaConsentimento)?.hint}
              </p>
            </div>

            {exigeBaseLegal && (
              <div className="space-y-2">
                <span className="text-sm font-medium">Bases legais aceitas</span>
                <div className="grid gap-2 sm:grid-cols-2">
                  {BASES_LEGAIS.map((b) => {
                    const id = `base-${b.value}`;
                    const marcada = basesLegais.includes(b.value);
                    return (
                      <div key={b.value} className="flex items-center gap-2">
                        <Checkbox
                          id={id}
                          checked={marcada}
                          onCheckedChange={(check: boolean) =>
                            setBasesLegais((prev) =>
                              check ? [...prev, b.value] : prev.filter((v) => v !== b.value),
                            )
                          }
                        />
                        <Label htmlFor={id} className="text-sm font-normal">
                          {b.label}
                        </Label>
                      </div>
                    );
                  })}
                </div>
                {semBaseLegal && (
                  <p className="text-xs text-destructive">
                    Sem nenhuma base marcada, a geração de público suprime todo mundo. Marque ao
                    menos uma.
                  </p>
                )}
              </div>
            )}
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Ritmo e janela
            </legend>
            <div className="grid gap-3 sm:grid-cols-4">
              <CampoNumero
                id="campanha-cooldown"
                label="Cooldown (dias)"
                value={cooldownDias}
                onChange={setCooldownDias}
                placeholder="30"
              />
              <CampoNumero
                id="campanha-cadencia"
                label="Cadência (s)"
                value={cadenciaSegundos}
                onChange={setCadenciaSegundos}
                placeholder="60"
              />
              <CampoNumero
                id="campanha-lote"
                label="Lote máx."
                value={loteMax}
                onChange={setLoteMax}
                placeholder="50"
              />
              <CampoNumero
                id="campanha-limite"
                label="Limite/dia"
                value={limiteDiario}
                onChange={setLimiteDiario}
                placeholder="sem limite"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="campanha-janela-inicio">Janela — início</Label>
                <Input
                  id="campanha-janela-inicio"
                  type="time"
                  value={janelaInicio}
                  onChange={(e) => setJanelaInicio(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="campanha-janela-fim">Janela — fim</Label>
                <Input
                  id="campanha-janela-fim"
                  type="time"
                  value={janelaFim}
                  onChange={(e) => setJanelaFim(e.target.value)}
                />
              </div>
            </div>
            {janelaPelaMetade && (
              <p className="text-xs text-destructive">
                A janela precisa de início E fim — ou de nenhum dos dois. Meia janela é recusada.
              </p>
            )}

            <div className="space-y-2">
              <span className="text-sm font-medium">Dias permitidos</span>
              <div className="flex flex-wrap gap-3">
                {DIAS.map((d) => {
                  const id = `dia-${d.value}`;
                  return (
                    <div key={d.value} className="flex items-center gap-1.5">
                      <Checkbox
                        id={id}
                        checked={janelaDias.includes(d.value)}
                        onCheckedChange={(check: boolean) =>
                          setJanelaDias((prev) =>
                            check ? [...prev, d.value] : prev.filter((v) => v !== d.value),
                          )
                        }
                      />
                      <Label htmlFor={id} className="text-sm font-normal">
                        {d.label}
                      </Label>
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                Nenhum dia marcado = usar o padrão do sistema. Marcar dias restringe a esses.
              </p>
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Segmentação
            </legend>
            <p className="text-xs text-muted-foreground">
              Campo em branco = sem restrição. Separe múltiplos valores por vírgula.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <CampoTexto
                id="seg-etapas"
                label="Etapas"
                value={etapas}
                onChange={setEtapas}
                placeholder="novo, contato"
              />
              <CampoTexto
                id="seg-temperaturas"
                label="Temperaturas"
                value={temperaturas}
                onChange={setTemperaturas}
                placeholder="quente, morno"
              />
              <CampoTexto
                id="seg-tags"
                label="Tags"
                value={tags}
                onChange={setTags}
                placeholder="bolsao"
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="seg-sem-corretor"
                checked={semCorretor}
                onCheckedChange={(v: boolean) => setSemCorretor(v)}
              />
              <Label htmlFor="seg-sem-corretor" className="text-sm font-normal">
                Somente leads sem corretor
              </Label>
            </div>
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor="campanha-handoff">Política de handoff</Label>
            <Select value={politicaHandoff} onValueChange={(v) => v && setPoliticaHandoff(String(v))}>
              <SelectTrigger id="campanha-handoff" className="w-full">
                <SelectValue>
                  {(v: string | null) =>
                    POLITICAS_HANDOFF.find((p) => p.value === v)?.label ?? "Sophia qualifica"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {POLITICAS_HANDOFF.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {erro && (
            <Alert variant="destructive">
              <AlertTitle>Não foi possível criar a campanha</AlertTitle>
              <AlertDescription>{erro}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setAberto(false)} disabled={salvando}>
            Cancelar
          </Button>
          <Button
            onClick={() => void handleSalvar()}
            disabled={salvando || !nome.trim() || semBaseLegal || janelaPelaMetade}
          >
            {salvando && <Loader2 data-icon="inline-start" className="animate-spin" />}
            Criar rascunho
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CampoNumero({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        min={0}
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

function CampoTexto({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}
