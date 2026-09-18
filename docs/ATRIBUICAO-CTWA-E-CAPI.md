# Atribuição de anúncio — o `ctwa_clid` e o retorno pela Conversions API

**Data:** 2026-09-18 · **Status:** desenho, não implementado
**Contexto:** `SUNT-Agentes/docs/WHATSAPP-META-2026-O-QUE-MUDOU.md`

> Este documento descreve um gap medido e o conserto proposto. **Nenhuma linha de código
> foi alterada.** Serve para a próxima sessão decidir e executar com o problema já mapeado.

---

## O gap, medido

Grep por `referral`, `ctwa_clid`, `externalAdReply`, `conversions` em:

- `wacrm/src/` → **zero ocorrências**
- `SUNT-CRM/supabase/migrations/` → **zero ocorrências**

Quando alguém clica num anúncio Click-to-WhatsApp, a Meta inclui no webhook um objeto
`referral` com `source_id` (o anúncio), `source_type`, `headline`, `body`, `media_type`,
`image_url` e o **`ctwa_clid`** — o identificador daquele clique. Ele é gerado pela Meta e
**não pode ser fabricado**.

Sem ele, não há como devolver conversão para a Meta. O algoritmo continua otimizando por
"iniciou conversa" em vez de por venda — **no canal que traz 95% dos leads da SUNT**
(`SUNT-Agentes/CLAUDE.md`, nota de 23/08).

## A boa notícia: o dado já está no banco

`src/app/api/whatsapp-oficial/webhook/route.ts:52-80` declara `MetaWebhookMessage` **sem**
o campo `referral`. Mas TypeScript é tipo em tempo de compilação, não filtro em runtime — e
`processInboundMessage` passa o objeto inteiro adiante:

```ts
// route.ts:704
p_raw_payload: { message, contact },
```

Ou seja: o `referral` **já está gravado** em `whatsapp_messages.raw_payload`, intacto, em
tudo que já entrou. **Backfill é possível.**

## A outra metade também já existe — no lado da Sophia

O canal Evolution já resolve o equivalente Baileys deste problema:

- `public.empreendimentos.meta_ad_source_ids text[]` com índice GIN — mapa `sourceId` →
  empreendimento (`SUNT-Agentes/supabase/migrations/20260805182330_meta_ad_source_ids.sql`)
- `public.sophia_job_atribuicao_ctwa(p_desde_horas)` preenche `leads.fb_ad_id`, agendada em
  pg_cron como `sunt-atribuicao-ctwa` a cada 10 minutos
  (`20260823010354_persistir_atribuicao_ctwa.sql`)
- `public.sophia_metricas_gestao_v2` deriva o canal por
  `jsonb_path_query_first(m.raw_payload,'$.**.externalAdReply') ->> 'sourceId'`

**As duas metades existem e nunca se encontraram.** E nenhuma das duas devolve evento para
a Meta — a atribuição morre no banco.

---

## Conserto proposto, em três partes

### Parte 1 — capturar (aditivo, sem risco)

1. Declarar `referral?` em `MetaWebhookMessage` (`route.ts:52-80`):
   ```ts
   referral?: {
     source_url?: string
     source_id?: string
     source_type?: string
     headline?: string
     body?: string
     media_type?: string
     image_url?: string
     ctwa_clid?: string
   }
   ```
2. Passar `p_referral` na RPC `whatsapp_oficial_processar_inbound`, ou — mais barato —
   deixar a RPC extrair de `p_raw_payload`, que já chega completo.
3. Persistir em coluna própria de `whatsapp_conversations` (`ctwa_clid`, `fb_ad_id`,
   `referral_recebido_em`), porque o identificador vale para a **conversa**, não só para a
   mensagem que o trouxe.

**Nada disso liga envio.** É leitura e escrita de dado que já chega.

### Parte 2 — backfill

`UPDATE` lendo `whatsapp_messages.raw_payload` pelo mesmo caminho jsonb que a
`sophia_metricas_gestao_v2` já usa. Recupera tudo que já entrou pelo canal oficial.

> Hoje esse volume é **zero** — `whatsapp_channels` está vazia e nenhuma mensagem real
> entrou pelo Hub. O backfill só passa a valer depois que o canal estiver no ar. Escrever
> a captura **antes** de ligar o canal evita precisar do backfill.

### Parte 3 — devolver pela Conversions API

Quando o CRM registrar um desfecho — `visita_realizada`, `proposta`, `vendido` na
`etapa_transicoes` —, enviar o evento para a Meta com o `ctwa_clid` original. A partir daí
o algoritmo otimiza por VGV, não por volume de conversa.

Desenho sugerido: uma fila, no padrão que o Hub já usa (`whatsapp_outbox` claim/lease/retry),
alimentada por trigger em `etapa_transicoes`. **Não** chamar a Graph API de dentro do
trigger.

---

## ⚠️ Armadilha: a Evolution API descarta o `referral`

**Issue #2645** (aberta 15/07/2026, sem resposta de mantenedor): em modo Cloud API, a
Evolution API v2.3.7 **descarta o `referral`** antes de emitir o `messages.upsert` —
`contextInfo: undefined`.

Consequência: trocar Baileys por Cloud API **por dentro da Evolution** não conserta a
atribuição. O WhatsHub fala com `graph.facebook.com/v24.0` direto
(`src/lib/whatsapp-oficial/meta-api.ts:26-28`), sem intermediário — o dado chega inteiro.

Isso é um argumento concreto a favor do Hub como canal oficial, em vez de reaproveitar a
Evolution em modo Cloud.

Fonte: <https://github.com/evolution-foundation/evolution-api/issues/2645>

---

## Por que isso vale mais que qualquer outra coisa na lista

1. **Não depende de aprovação da Meta.** Não precisa de verificação de empresa, número novo
   nem template aprovado.
2. **Não toca no que está vivo.** A Sophia não é afetada.
3. **É aditivo e testável offline.** O repositório tem ~1.220 testes; este conserto entra
   no mesmo padrão.
4. **Muda o que o Facebook otimiza** no canal que traz 95% dos leads.

Fontes sobre CAPI para CTWA:
<https://developers.facebook.com/docs/whatsapp/> ·
<https://www.wati.io/en/blog/track-ctwa-conversions-capi/>
