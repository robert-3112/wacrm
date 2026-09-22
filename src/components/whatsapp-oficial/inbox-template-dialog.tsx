'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createClient } from '@/lib/supabase/client'
import { MESSAGE_SELECT } from '@/lib/whatsapp-oficial/inbox-data'
import { listarTemplates, previewTemplate } from '@/lib/whatsapp-oficial/gestao-actions'
import { traduzirErro } from '@/lib/whatsapp-oficial/gestao-erros'
import { camposFaltando, derivarCamposTemplate, montarVariaveisPadrao, motivoTemplateNaoSuportado, rotuloCampo } from '@/lib/whatsapp-oficial/template-campos'
import type { TemplatePreviewResposta, WhatsAppMessage, WhatsAppTemplate } from '@/types/whatsapp-oficial'

export function InboxTemplateDialog({ conversationId, canalId, contactName, blockedReason, onClose, onSent, onSophiaPaused }: {
  conversationId: string; canalId: string; contactName: string; onClose: () => void
  blockedReason?: string
  onSent: (message: WhatsAppMessage) => void; onSophiaPaused: (inFlight: number) => void
}) {
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [templateId, setTemplateId] = useState('')
  const [values, setValues] = useState<Record<string,string>>({})
  const [preview, setPreview] = useState<{ key: string; data: TemplatePreviewResposta } | null>(null)
  const [busyPreview, setBusyPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sending = useRef(false)
  const previewAbort = useRef<AbortController | null>(null)
  useEffect(() => {
    const abort = new AbortController()
    void listarTemplates({canalId,status:'aprovado'},abort.signal).then(result => {
      if (abort.signal.aborted) return
      if (result.ok) setTemplates(result.data.templates)
      else setError(result.mensagem)
    }).catch(() => { if (!abort.signal.aborted) setError('Não foi possível carregar os templates.') })
      .finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => { abort.abort(); previewAbort.current?.abort() }
  },[canalId])
  const template = templates.find(item => item.id === templateId)
  const fields = template ? derivarCamposTemplate(template) : []
  const params = montarVariaveisPadrao(fields,values)
  const key = JSON.stringify({templateId,params})
  const currentPreview = preview?.key === key ? preview.data : null
  const unsupported = template ? motivoTemplateNaoSuportado(template) : null
  const complete = !!template && !unsupported && camposFaltando(fields,values).length === 0
  const canSend = complete && currentPreview?.validacao.ok && currentPreview.statusAprovacao === 'aprovado' && !busy && !uncertain && !blockedReason

  async function review() {
    if (!template || !complete) return
    previewAbort.current?.abort()
    const abort = new AbortController(); previewAbort.current = abort
    setBusyPreview(true); setError(null); setPreview(null)
    try {
      const result = await previewTemplate(template.id,{
        ...(params.body ? {corpo:params.body} : {}),
        ...(params.headerText ? {cabecalho:[params.headerText]} : {}),
      },abort.signal)
      if (abort.signal.aborted) return
      if (result.ok) setPreview({key,data:result.data})
      else setError(result.mensagem)
    } catch { if (!abort.signal.aborted) setError('Não foi possível conferir a mensagem.') }
    finally { if (!abort.signal.aborted) setBusyPreview(false) }
  }
  async function send() {
    if (!canSend || sending.current) return
    sending.current=true; setBusy(true); setError(null)
    try {
      const response = await fetch('/api/whatsapp-oficial/templates/enviar',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({conversationId,templateId,variaveis:params}),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) {
        if (response.status >= 500) throw new Error('uncertain')
        setError(traduzirErro(result.error,response.status)); return
      }
      if (!result.enfileirado || typeof result.messageId !== 'string') throw new Error('uncertain')
      onSophiaPaused(result.in_flight_replies ?? 0)
      // Enqueue already succeeded. A history read failure must never invite another send.
      const { data, error: readError } = await createClient().from('whatsapp_messages')
        .select(MESSAGE_SELECT).eq('id',result.messageId).eq('conversation_id',conversationId).maybeSingle()
      if (data && !readError) onSent(data as unknown as WhatsAppMessage)
      toast.success('Template colocado na fila. Acompanhe a entrega na conversa.')
      onClose()
    } catch {
      setUncertain(true)
      setError('Não foi possível confirmar o resultado. Confira o histórico antes de repetir; a mensagem pode já estar na fila.')
    } finally { sending.current=false; setBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !sending.current) onClose() }}>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
      <DialogHeader><DialogTitle>Enviar template aprovado</DialogTitle>
        <DialogDescription>Para {contactName}, nesta conversa. Confira o conteúdo antes de colocar na fila; o envio não reabre a janela de resposta livre.</DialogDescription></DialogHeader>
      <fieldset disabled={busy || uncertain || !!blockedReason} className="min-w-0 space-y-4">
        <div className="space-y-1.5"><Label htmlFor="inbox-template">Template deste número</Label>
          <select id="inbox-template" className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm" value={templateId} disabled={loading}
            onChange={event => { previewAbort.current?.abort(); setBusyPreview(false); setTemplateId(event.target.value); setValues({}); setPreview(null); setError(null) }}>
            <option value="">{loading ? 'Carregando…' : 'Selecione um template'}</option>
            {templates.map(item => <option key={item.id} value={item.id} disabled={!!motivoTemplateNaoSuportado(item)}>{item.nome} · {item.idioma}{motivoTemplateNaoSuportado(item) ? ' · formato não suportado' : ''}</option>)}
          </select>
          {!loading && !templates.length && <p className="text-muted-foreground text-xs">Nenhum template aprovado disponível para sua conta neste número. Confira o catálogo de Templates.</p>}
        </div>
        {fields.map(field => <div key={field.chave} className="space-y-1.5"><Label htmlFor={`template-${field.chave}`}>{rotuloCampo(field)}{field.obrigatorio ? ' *' : ''}</Label>
          <Input id={`template-${field.chave}`} value={values[field.chave] ?? ''} maxLength={1024}
            onChange={event => { setValues(previous => ({...previous,[field.chave]:event.target.value})); setPreview(null) }} />
          {field.contexto && <p className="text-muted-foreground text-xs">{field.contexto}</p>}
          {field.ajuda && <p className="text-muted-foreground text-xs">{field.ajuda}</p>}
        </div>)}
        <Button variant="outline" disabled={!complete || busyPreview} onClick={() => void review()}>{busyPreview ? 'Conferindo…' : 'Conferir mensagem'}</Button>
        {currentPreview && <div className="bg-muted rounded-xl p-4 text-sm whitespace-pre-wrap break-words">
          {currentPreview.preview.cabecalho && <p className="font-semibold">{currentPreview.preview.cabecalho}</p>}
          <p>{currentPreview.preview.corpo}</p>
          {currentPreview.preview.rodape && <p className="text-muted-foreground mt-2 text-xs">{currentPreview.preview.rodape}</p>}
          {currentPreview.preview.botoes.map((button,index) => <p key={index} className="mt-2 border-t border-border pt-2 text-center">{button.texto}</p>)}
          {fields.filter(field => field.onde === 'midia' || field.onde === 'botao').map(field => <p key={field.chave} className="mt-2 text-xs">{rotuloCampo(field)}: {values[field.chave] || 'Exemplo aprovado'}</p>)}
        </div>}
      </fieldset>
      {blockedReason && <p role="alert" className="text-destructive text-sm">{blockedReason}</p>}
      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      <DialogFooter><Button variant="ghost" disabled={busy} onClick={onClose}>Fechar</Button>
        <Button disabled={!canSend} onClick={() => void send()}>{busy ? 'Colocando na fila…' : 'Enviar nesta conversa'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
