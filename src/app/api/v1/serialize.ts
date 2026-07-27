/**
 * Forma dos objetos que a API externa `/api/v1` publica, e validação dos filtros de query.
 *
 * Não é um arquivo de rota — o App Router só trata `route.ts`/`page.tsx` como rota, o resto da
 * pasta é módulo comum (mesmo motivo pelo qual os `*.test.ts` vivem aqui do lado).
 *
 * Por que uma camada de serialização em vez de devolver a linha crua: o que sai daqui vira
 * contrato com terceiros. Devolver `select('*')` congelaria cada coluna interna
 * (`nao_lidas_corretor`, `raw_payload`, `erro_detalhe`…) como promessa pública e vazaria
 * detalhe operacional para fora. A lista abaixo é o que a API promete; o resto pode mudar sem
 * quebrar ninguém.
 *
 * ── POR QUE A SERIALIZAÇÃO CONHECE OS ESCOPOS ────────────────────────────────────────────
 * Um escopo só vale alguma coisa se o dado que ele protege não sair por outra porta. A lista de
 * conversas exige apenas `conversations:read`, mas carregava duas coisas que outras rotas
 * gateiam:
 *   • `last_message_preview` — o banco preenche com `left(conteudo,200)` de TODO inbound e
 *     outbound. Quem faz polling nessa lista reconstrói o conteúdo das conversas sem nunca ter
 *     `messages:read`, e `GET /conversations/{id}/messages` responderia 403 para a mesma chave.
 *   • `contact.whatsapp` — o telefone completo. Uma chave "só ver a lista" exportava a base de
 *     telefones inteira, enquanto `GET /contacts` responderia 403 para ela.
 * Além de furar o 403 das rotas vizinhas, isso quebrava a premissa escrita no cabeçalho de
 * `outbound-webhooks.ts`, que justifica NÃO mandar conteúdo no webhook dizendo que "quem precisa
 * do conteúdo busca na /api/v1, onde o escopo é conferido".
 *
 * Por isso `serializeConversation` EXIGE os escopos como parâmetro — não tem default, não lê
 * estado global (dois pedidos com chaves diferentes atravessam este módulo ao mesmo tempo) e o
 * TypeScript recusa a chamada de quem esquecer. Campo sem escopo é OMITIDO, não zerado: string
 * vazia ou `null` mascarado mente para o integrador, que passaria a tratar "a conversa não tem
 * preview" e "você não pode ver o preview" como a mesma coisa.
 */

/** Valores aceitos por `whatsapp_conversations.status` (CHECK do banco). */
export const CONVERSATION_STATUSES = ['aberta', 'pendente', 'encerrada'] as const

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

/** `leads.nome`/`leads.name` e `leads.whatsapp`/`leads.phone` são pares legados no CRM — o
 *  inbox oficial já coalesce os dois (ver `inbox-data.ts`); a API pública faz o mesmo para não
 *  exportar a duplicidade. */
export const API_LEAD_FIELDS = 'id, nome, name, whatsapp, phone, created_at'

/**
 * O `tenant_id` do lead entra no embed mas NÃO sai na resposta: é insumo da guarda de tenant em
 * `serializeConversation`. Ver `EMBED_TENANT_FILTER`.
 */
export const API_CONVERSATION_SELECT = `
  id, tenant_id, canal_id, lead_id, status, optout_em, wa_contact_name,
  ultima_mensagem_em, ultima_mensagem_preview, created_at,
  lead:leads ( tenant_id, ${API_LEAD_FIELDS} )
`.trim()

/**
 * Coluna do filtro que a rota aplica NO RECURSO EMBEDADO (`lead.tenant_id=eq.<tenant>`).
 *
 * Existe porque não há FK composta nem CHECK amarrando `leads.tenant_id` a
 * `whatsapp_conversations.tenant_id`: o embed segue a FK simples por `lead_id`, então uma linha
 * com `lead_id` apontando para outro tenant traz o lead do vizinho mesmo com o `.eq('tenant_id')`
 * da tabela base. Todas as RPCs vizinhas fazem
 * `join public.leads l on l.id = c.lead_id and l.tenant_id = c.tenant_id` justamente por isso —
 * a prova de que a rota de leitura era a exceção: para a MESMA linha, `POST /api/v1/messages`
 * responde 404 (a RPC junta por tenant) e o GET devolvia o contato alheio.
 *
 * Constante exportada para o filtro do PostgREST e a guarda do serializador não poderem divergir
 * de nome.
 */
export const EMBED_TENANT_FILTER = 'lead.tenant_id'

export const API_MESSAGE_SELECT = `
  id, conversation_id, direction, message_type, content, media_mime_type,
  status, wamid, created_at
`.trim()

interface RawLead {
  id?: string
  /** Só do embed de conversa — insumo da guarda de tenant, nunca sai na resposta. */
  tenant_id?: string | null
  nome?: string | null
  name?: string | null
  whatsapp?: string | null
  phone?: string | null
  created_at?: string
}

/**
 * Escopos concedidos à chave que fez ESTA chamada. Sempre `ctx.escopos`, passado de mão em mão:
 * ler de um módulo global aqui seria um vazamento à espera de acontecer, porque o processo
 * atende chaves diferentes ao mesmo tempo.
 */
export type GrantedScopes = readonly string[]

/** O Supabase devolve embed to-one ora como objeto, ora como array de 1 — normaliza os dois. */
function firstOrSelf<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

export interface RawConversationRow {
  id: string
  tenant_id?: string
  canal_id?: string
  lead_id?: string
  status?: string
  optout_em?: string | null
  wa_contact_name?: string | null
  ultima_mensagem_em?: string | null
  ultima_mensagem_preview?: string | null
  created_at: string
  lead?: RawLead | RawLead[] | null
}

/**
 * Contato embutido na conversa. `whatsapp` só aparece com `contacts:read` — sem ele o objeto
 * fica `{ id, nome }`, que é o mínimo para o integrador saber de quem é a conversa sem receber
 * de graça o que a rota `/contacts` cobraria escopo para entregar.
 */
export function serializeContact(
  raw: RawLead | null,
  escopos: GrantedScopes,
): Record<string, unknown> | null {
  if (!raw) return null
  const out: Record<string, unknown> = {
    id: raw.id ?? null,
    // `?.trim() ||` e não `??`: string vazia no `nome` tem que cair para `name`, e `??` só
    // trataria null/undefined — o lead ficaria com nome "" no contrato público.
    nome: (raw.nome?.trim() || raw.name?.trim()) ?? null,
  }
  if (escopos.includes('contacts:read')) {
    out.whatsapp = raw.whatsapp ?? raw.phone ?? null
  }
  return out
}

/**
 * Guarda de tenant do embed, em cima do filtro que a rota manda para o PostgREST.
 *
 * Fail-closed de propósito: só devolve `true` quando dá para PROVAR que os dois lados são o
 * mesmo tenant. Se qualquer um dos `tenant_id` vier vazio — alguém enxugou o SELECT, o embed
 * veio de outro caminho — a resposta perde o contato. Chato e visível; o contrário é silencioso
 * e vaza o vizinho. (`a === b` com `a` provado string evita o buraco de `undefined === undefined`
 * passar por "mesmo tenant".)
 */
function mesmoTenant(conversa: RawConversationRow, lead: RawLead): boolean {
  const daConversa = conversa.tenant_id
  return typeof daConversa === 'string' && daConversa !== '' && daConversa === lead.tenant_id
}

export function serializeConversation(
  raw: RawConversationRow,
  escopos: GrantedScopes,
): Record<string, unknown> {
  const lead = firstOrSelf(raw.lead)

  let contact: Record<string, unknown> | null = null
  if (lead) {
    if (mesmoTenant(raw, lead)) {
      contact = serializeContact(lead, escopos)
    } else if (typeof lead.tenant_id === 'string' && lead.tenant_id !== '') {
      // Divergência real (os dois lados presentes e diferentes) é problema de integridade de
      // dado, não caso de borda: registra sem nome nem telefone no log.
      console.error(
        '[api/v1/conversations] conversa aponta para lead de outro tenant:',
        `conversation=${raw.id} conversa.tenant=${raw.tenant_id} lead.tenant=${lead.tenant_id}`,
      )
    }
  }

  const out: Record<string, unknown> = {
    id: raw.id,
    status: raw.status ?? null,
    lead_id: raw.lead_id ?? null,
    canal_id: raw.canal_id ?? null,
    // Quem consome a API precisa saber que a pessoa pediu para sair antes de tentar enviar.
    opted_out_at: raw.optout_em ?? null,
    wa_contact_name: raw.wa_contact_name ?? null,
    // Metadado legítimo de conversa (QUANDO houve mensagem, não O QUE dizia): fica sempre, e é
    // ele que permite ao integrador com `conversations:read` saber que precisa buscar em
    // `/conversations/{id}/messages` — onde `messages:read` é conferido.
    last_message_at: raw.ultima_mensagem_em ?? null,
    created_at: raw.created_at,
    contact,
  }
  if (escopos.includes('messages:read')) {
    out.last_message_preview = raw.ultima_mensagem_preview ?? null
  }
  return out
}

export interface RawMessageRow {
  id: string
  conversation_id?: string
  direction?: string
  message_type?: string
  content?: string | null
  media_mime_type?: string | null
  status?: string
  wamid?: string | null
  created_at: string
}

export function serializeMessage(raw: RawMessageRow): Record<string, unknown> {
  return {
    id: raw.id,
    conversation_id: raw.conversation_id ?? null,
    direction: raw.direction ?? null,
    type: raw.message_type ?? null,
    content: raw.content ?? null,
    media_mime_type: raw.media_mime_type ?? null,
    status: raw.status ?? null,
    // Id da Meta. Só existe depois que o worker entrega de verdade; em shadow fica null.
    wamid: raw.wamid ?? null,
    created_at: raw.created_at,
  }
}

export interface RawContactRow extends RawLead {
  id: string
  created_at: string
}

export function serializeContactRow(raw: RawContactRow): Record<string, unknown> {
  return {
    id: raw.id,
    nome: (raw.nome?.trim() || raw.name?.trim()) ?? null,
    whatsapp: raw.whatsapp ?? raw.phone ?? null,
    created_at: raw.created_at,
  }
}
