/**
 * Leituras de servidor das telas de gestão: o canal a operar e o estado das
 * travas de saída.
 *
 * Fica separado de `gestao-actions.ts` porque roda em contexto oposto: aqui é
 * Server Component (cookies + `process.env`), lá é navegador. Misturar os dois
 * num módulo só arrastaria `next/headers` para dentro do bundle do cliente.
 *
 * Nenhuma rota nova foi criada para isto de propósito: `whatsapp_channels` e
 * `crm_config` já têm policy de SELECT, então o cliente COM SESSÃO é a
 * autorização — a mesma escolha que `inbox-data.ts` documenta para as leituras
 * do inbox.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { isSendEnabledFor, readWhatsappFlags } from './env-flags'
import type { TravasSaida, WhatsAppCanal } from '@/types/whatsapp-oficial'

/** Campos seguros de `whatsapp_channels`. As colunas de credencial
 *  (`access_token_cifrado`, `evolution_api_key_cifrado`) NUNCA entram nesta
 *  lista — nem cifradas: elas não têm uso nenhum na tela e um select amplo é
 *  como um segredo acaba num payload de RSC. */
const CANAL_SELECT = 'id, nome, provider, status, numero_display, is_default'

export interface CanaisResultado {
  canais: WhatsAppCanal[]
  /** Mensagem pronta quando a leitura falhou. `null` em sucesso — inclusive
   *  no sucesso que devolve zero linhas, que é estado válido e não erro. */
  erro: string | null
}

/**
 * Canais visíveis para a sessão atual.
 *
 * A RLS `whatsapp_channels_select_gestao` é `tenant_id + crm_is_gestao()`, o
 * que faz zero linhas significar DUAS coisas indistinguíveis daqui: ou não há
 * canal cadastrado (o estado de produção hoje), ou quem está logado não é
 * gestão. A tela precisa dizer as duas — ver `SemCanal`.
 */
export async function fetchCanaisGestao(supabase: SupabaseClient): Promise<CanaisResultado> {
  const { data, error } = await supabase
    .from('whatsapp_channels')
    .select(CANAL_SELECT)
    // Canal padrão primeiro: é o que o seletor pré-seleciona.
    .order('is_default', { ascending: false })
    .order('nome', { ascending: true })

  if (error) {
    console.error('[whatsapp-oficial/gestao-server] failed to list channels:', error.message)
    return { canais: [], erro: 'Não foi possível carregar os canais.' }
  }

  return { canais: (data ?? []) as unknown as WhatsAppCanal[], erro: null }
}

/**
 * Estado das travas, resolvido no servidor.
 *
 * São DOIS kill switches independentes para broadcast, e a tela precisa dos
 * dois porque desligar qualquer um já basta para nada sair:
 *
 *  1. `crm_config.whatsapp_broadcast_enabled` — no banco, editável pela gestão
 *     do CRM. Nasce `false`.
 *  2. `WHATSAPP_BROADCAST_ENABLED` — env do worker da outbox, que recheca por
 *     conta própria antes de processar um item `tipo = 'broadcast'`.
 *
 * Acima dos dois ainda existe o modo de saída: em `shadow`, o worker marca o
 * item como `simulado` e NÃO chama provider nenhum — é por isso que a tela
 * nunca escreve "enviado".
 *
 * Só booleanos derivados saem daqui. Nome e valor de env var não atravessam
 * para o cliente.
 */
export async function fetchTravasSaida(supabase: SupabaseClient): Promise<TravasSaida> {
  const flags = readWhatsappFlags()

  let broadcastBancoLigado: boolean | null = null
  const { data, error } = await supabase
    .from('crm_config')
    .select('whatsapp_broadcast_enabled')
    .maybeSingle()

  if (error) {
    // Falha de leitura NÃO vira `false`: "desligado" e "não sei" são coisas
    // diferentes na tela, e mostrar um cadeado que não foi verificado é pior
    // que admitir a dúvida.
    console.error('[whatsapp-oficial/gestao-server] failed to read crm_config:', error.message)
  } else if (data && typeof data.whatsapp_broadcast_enabled === 'boolean') {
    broadcastBancoLigado = data.whatsapp_broadcast_enabled
  }

  return {
    modo: flags.mode,
    broadcastEnvLigado: flags.broadcastEnabled,
    broadcastBancoLigado,
    envioMetaLigado: isSendEnabledFor('meta_cloud', flags),
    envioEvolutionLigado: isSendEnabledFor('evolution', flags),
    pilotoLigado: flags.pilotMode,
  }
}
