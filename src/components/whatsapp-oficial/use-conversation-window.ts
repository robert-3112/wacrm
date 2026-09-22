'use client'

import { useEffect, useState } from 'react'
import type { ConversationWindow } from '@/lib/whatsapp-oficial/conversation-window'

export function useConversationWindow(conversationId: string | undefined, latestInboundId: string | undefined) {
  const [state, setState] = useState<{ id: string; data?: ConversationWindow; error?: string } | null>(null)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    if (!conversationId) return
    const controller = new AbortController()
    let expiry: ReturnType<typeof setTimeout> | undefined
    let running = false
    async function load() {
      if (running) return
      running = true
      try {
        const response = await fetch(`/api/whatsapp-oficial/messages/window?${new URLSearchParams({ conversationId: conversationId! })}`, {
          signal: controller.signal, cache: 'no-store',
        })
        const data = await response.json() as ConversationWindow
        if (controller.signal.aborted) return
        if (!response.ok || typeof data.open !== 'boolean' || typeof data.applies !== 'boolean' ||
          !Number.isFinite(Date.parse(data.serverTime)) ||
          (data.applies && data.open && (!data.expiresAt || !Number.isFinite(Date.parse(data.expiresAt))))) {
          throw new Error('Não foi possível verificar a janela de atendimento.')
        }
        clearTimeout(expiry)
        setState({ id: conversationId!, data })
        if (data.applies && data.open && data.expiresAt) {
          expiry = setTimeout(() => {
            if (!controller.signal.aborted) setState({ id: conversationId!, data: { ...data, open: false } })
          }, Math.max(0, Date.parse(data.expiresAt) - Date.parse(data.serverTime)))
        }
      } catch {
        if (!controller.signal.aborted) {
          clearTimeout(expiry)
          setState({ id: conversationId!, error: 'Não foi possível verificar a janela de atendimento.' })
        }
      } finally { running = false }
    }
    void load()
    const interval = setInterval(() => void load(), 30_000)
    return () => { controller.abort(); clearInterval(interval); clearTimeout(expiry) }
  }, [conversationId, latestInboundId, refresh])
  const current = state?.id === conversationId ? state : null
  return { window: current?.data, error: current?.error, refresh: () => setRefresh(value => value + 1) }
}
