'use client'

import { useEffect, useState } from 'react'
import { Loader2, PauseCircle, PlayCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

interface SophiaState {
  supported: boolean
  sophia_ativa: boolean
}

/** Human takeover for an official Meta conversation; all authority stays in the RPC. */
export function SophiaToggle({
  conversationId,
  onConversationChanged,
}: {
  conversationId: string
  onConversationChanged: () => void
}) {
  const [state, setState] = useState<SophiaState | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    const load = async () => {
      setState(null)
      try {
        const response = await fetch(`/api/whatsapp-oficial/conversations/${conversationId}/sophia`, {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error('Falha ao consultar a Sophia.')
        const data = (await response.json()) as SophiaState
        if (!controller.signal.aborted) setState(data)
      } catch {
        if (!controller.signal.aborted) toast.error('Não foi possível consultar a Sophia desta conversa.')
      }
    }
    void load()
    return () => controller.abort()
  }, [conversationId])

  if (!state?.supported) return null

  const toggle = async () => {
    if (saving) return
    setSaving(true)
    try {
      const next = !state.sophia_ativa
      const response = await fetch(`/api/whatsapp-oficial/conversations/${conversationId}/sophia`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ativa: next }),
      })
      const result = (await response.json().catch(() => ({}))) as {
        error?: string
        sophia_ativa?: boolean
        cancelled_replies?: number
      }
      if (!response.ok || result.sophia_ativa !== next) {
        throw new Error(result.error ?? 'Não foi possível alterar a Sophia.')
      }
      setState({ supported: true, sophia_ativa: next })
      toast.success(next ? 'Sophia ativada nesta conversa.' : 'Sophia pausada; atendimento humano ativo.')
      onConversationChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao alterar a Sophia.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Button
      variant={state.sophia_ativa ? 'outline' : 'secondary'}
      size="sm"
      aria-label={state.sophia_ativa ? 'Pausar Sophia nesta conversa' : 'Ativar Sophia nesta conversa'}
      aria-pressed={state.sophia_ativa}
      disabled={saving}
      onClick={() => void toggle()}
    >
      {saving ? <Loader2 data-icon="inline-start" className="animate-spin" /> :
        state.sophia_ativa ? <PauseCircle data-icon="inline-start" /> : <PlayCircle data-icon="inline-start" />}
      {state.sophia_ativa ? 'Pausar Sophia' : 'Ativar Sophia'}
    </Button>
  )
}
