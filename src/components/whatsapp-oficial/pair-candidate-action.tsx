"use client";

import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Link2, Loader2, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { confirmConversationPair, previewConversationPair } from '@/lib/whatsapp-oficial/pair-actions'
import type { PairCandidate } from '@/lib/whatsapp-oficial/pair-actions'

export function PairProofSummary({ candidate }: { candidate: PairCandidate }) {
  const when = (value: string) => new Date(value).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
  return <div className="space-y-4 text-sm">
    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
      <p className="flex items-start gap-2 font-medium text-emerald-800 dark:text-emerald-300">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        Meta confirmou: o destinatário do envio e o remetente da resposta são o mesmo contato, no mesmo canal.
      </p>
      <p className="mt-2 text-xs text-muted-foreground">Envio confirmado em {when(candidate.status_at)} · resposta recebida em {when(candidate.inbound_at)}</p>
    </div>
    <div role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-amber-950 dark:text-amber-200">
      <strong>Vínculo auditado.</strong> Os dois históricos aparecerão juntos. A resposta humana de texto só estará disponível após habilitação específica, dentro da janela da conversa recebida e com validação dos dois cadastros. Templates, mídia e campanhas continuam bloqueados para o par. Esta operação não pode ser desfeita pelo painel.
    </div>
    <details className="rounded-lg border border-border px-3 py-2">
      <summary className="cursor-pointer font-medium">Identificadores da prova</summary>
      <dl className="mt-2 grid gap-2 text-xs text-muted-foreground">
        {([
          ['Conversa do envio', candidate.outbound_conversation_id],
          ['Conversa da resposta', candidate.inbound_conversation_id],
          ['Mensagem enviada', candidate.outbound_message_id],
          ['Mensagem recebida', candidate.inbound_message_id],
          ['Evento de status', candidate.status_webhook_event_id],
          ['Evento de entrada', candidate.inbound_webhook_event_id],
        ] as const).map(([label, id]) => <div key={label} className="min-w-0"><dt>{label}</dt><dd className="break-all font-mono text-foreground">{id}</dd></div>)}
      </dl>
    </details>
  </div>
}

export function PairCandidateAction({ conversationId, onLinked }: {
  conversationId: string
  onLinked: () => void
}) {
  const [open, setOpen] = useState(false)
  const requestId = useRef(0)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [candidate, setCandidate] = useState<PairCandidate | null>(null)
  const [linkEnabled, setLinkEnabled] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadPreview = async () => {
    const request = ++requestId.current
    setOpen(true)
    setLoading(true)
    setCandidate(null)
    setLinkEnabled(false)
    setError(null)
    const result = await previewConversationPair(conversationId)
    if (requestId.current !== request) return
    if (result.ok) { setCandidate(result.candidate); setLinkEnabled(result.linkEnabled) }
    else setError(result.error)
    setLoading(false)
  }

  const confirm = async () => {
    if (!candidate || !linkEnabled || submitting) return
    setSubmitting(true)
    const result = await confirmConversationPair(candidate)
    setSubmitting(false)
    if (!result.ok) {
      setCandidate(null)
      setError(result.error)
      return
    }
    setOpen(false)
    toast.success('Históricos vinculados com segurança.')
    onLinked()
  }

  return <>
    <Button variant="outline" size="sm" onClick={() => void loadPreview()}>
      <Link2 aria-hidden="true" /> Conferir vínculo de históricos
    </Button>
    <Dialog open={open} onOpenChange={value => { if (!submitting) { if (!value) requestId.current++; setOpen(value) } }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Vincular históricos da Meta</DialogTitle>
          <DialogDescription>
            A plataforma compara o status do envio com a mensagem recebida. A ligação exige prova única e confirmação de gestão.
          </DialogDescription>
        </DialogHeader>
        {loading ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Conferindo evidência…</p>
          : candidate ? <PairProofSummary candidate={candidate} />
            : <div role="alert" className="space-y-3 rounded-lg border border-border p-3 text-sm">
              <p>{error ?? 'Não foi possível verificar a evidência.'}</p>
              <Button variant="outline" size="sm" onClick={() => void loadPreview()}>Verificar novamente</Button>
            </div>}
        {candidate && !linkEnabled && <p role="status" className="text-xs text-muted-foreground">Vínculo disponível somente após habilitação segura do envio nos dois históricos.</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>Cancelar</Button>
          <Button onClick={() => void confirm()} disabled={!candidate || !linkEnabled || loading || submitting}>
            {submitting && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
            {linkEnabled ? 'Confirmar vínculo auditado' : 'Aguardando habilitação segura'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
