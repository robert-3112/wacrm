/**
 * O que um template EXIGE de quem vai disparar — e o formulário que corresponde
 * a essa exigência.
 *
 * Este módulo existe porque a exigência estava escrita em três lugares que não
 * se falavam: o builder de envio (`template-send-builder.ts`, que lança 422
 * quando falta valor), a coluna `whatsapp_templates.variaveis` (recalculada
 * pelo banco a cada sync) e a cabeça do operador. A tela de campanha não tinha
 * campo nenhum, então TODO destinatário nascia com `variaveis = '{}'` e
 * qualquer template com `{{1}}` falhava em 100% dos envios — medido contra a
 * Graph API real em 2026-07-29.
 *
 * Tudo aqui é função pura, sem React e sem fetch, por dois motivos: a tela e a
 * rota precisam da MESMA derivação (a rota é quem devolve o veredito da tela de
 * detalhe, que não tem o template em mãos), e é a única forma de testar a
 * regra sem montar DOM.
 *
 * TRÊS VOCABULÁRIOS diferentes para a mesma coisa, e este módulo é a ponte
 * entre o primeiro e o terceiro:
 *   1. declaração  — `whatsapp_templates.variaveis`: {cabecalho[], corpo[], botoes[]}
 *   2. preview     — `montarValoresPreview`: {cabecalho: string[], corpo: string[]}
 *   3. ENVIO       — `VariaveisPadrao`/`SendTimeParams`: {body[], headerText, …}
 * O (2) NÃO serve para o envio: `headerText` é string única, não array, e o
 * builder ignora array ali.
 */

import {
  FORMATOS_CABECALHO_SUPORTADOS,
  TIPOS_COMPONENTE_SUPORTADOS,
} from './template-send-builder'
import { TEMPLATE_MAX_TAMANHO_VALOR, TEMPLATE_MAX_VALORES } from './meta-templates'
import type { VariaveisPadrao, WhatsAppTemplate } from '@/types/whatsapp-oficial'

const SUPORTADOS: ReadonlySet<string> = new Set(TIPOS_COMPONENTE_SUPORTADOS)
const FORMATOS_CABECALHO: ReadonlySet<string> = new Set(FORMATOS_CABECALHO_SUPORTADOS)

/**
 * Formatos de cabeçalho que exigem MÍDIA no envio, e não texto.
 *
 * A lista é positiva e isso SÓ é seguro porque `motivoTemplateNaoSuportado` barra, antes, o
 * template cujo formato de cabeçalho está fora de `FORMATOS_CABECALHO_SUPORTADOS`. Sem aquele
 * portão, um header `LOCATION` chegaria aqui, responderia `false` (não é mídia), não geraria
 * campo nenhum — porque o sync zera `cabecalho_texto` para formato que não é TEXT — e o
 * operador ficaria com o botão habilitado e a RPC recusando "faltam valores" sem existir campo
 * para preencher.
 */
const FORMATOS_MIDIA: ReadonlySet<string> = new Set(['IMAGE', 'VIDEO', 'DOCUMENT'])

export function cabecalhoEhMidia(formato: string | null | undefined): boolean {
  return FORMATOS_MIDIA.has((formato ?? '').trim().toUpperCase())
}

/** Formato de cabeçalho que o builder sabe montar. Vazio conta como TEXT, igual lá. */
function cabecalhoSuportado(formato: string | null | undefined): boolean {
  const f = (formato ?? '').trim().toUpperCase()
  return f === '' || FORMATOS_CABECALHO.has(f)
}

// ---------------------------------------------------------------------------
// Resumo do blob `componentes` (usado pela rota de listagem)
// ---------------------------------------------------------------------------

export interface ResumoComponentes {
  /** Tipos em MAIÚSCULA, na ordem em que aparecem. `null` = o blob não é um
   *  array, ou seja, template malformado que o builder recusa inteiro. */
  tipos: string[] | null
  /** HEADER de mídia com `example.header_url[0]` preenchido. */
  cabecalhoMidiaExemplo: boolean
}

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function textoNaoVazio(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null
}

/**
 * Destila `componentes` nos DOIS fatos que a tela precisa saber sobre ele, sem
 * carregar o blob até o navegador (ele é grande e a listagem traz o catálogo
 * inteiro do canal).
 */
export function resumirComponentes(componentes: unknown): ResumoComponentes {
  if (!Array.isArray(componentes)) {
    return { tipos: null, cabecalhoMidiaExemplo: false }
  }

  const tipos: string[] = []
  let cabecalhoMidiaExemplo = false

  for (const bruto of componentes) {
    const comp = ehObjeto(bruto) ? bruto : {}
    const tipo = String(comp.type ?? '')
      .trim()
      .toUpperCase()
    tipos.push(tipo)

    if (tipo === 'HEADER' && cabecalhoEhMidia(comp.format as string | undefined)) {
      const exemplo = ehObjeto(comp.example) ? comp.example : null
      const urls = exemplo && Array.isArray(exemplo.header_url) ? exemplo.header_url : []
      // Só `header_url[0]`: é o ÚNICO fallback que `buildHeaderComponent` lê.
      // `header_handle` (o id de mídia da aprovação) NÃO é consultado por ele —
      // dar esse fallback aqui deixaria a tela otimista e o envio quebrado.
      if (textoNaoVazio(urls[0])) cabecalhoMidiaExemplo = true
    }
  }

  return { tipos, cabecalhoMidiaExemplo }
}

/**
 * Por que este template NÃO pode ser usado numa campanha — ou `null` quando
 * pode.
 *
 * DUAS listas positivas, as duas copiadas do builder de propósito:
 *
 *  1. TIPO do bloco (`TIPOS_COMPONENTE_SUPORTADOS`). Um CAROUSEL aprovado hoje
 *     aparece normal na tela e só quebra no envio: os `find()` do builder acham
 *     BODY e BUTTONS, nenhum exige parâmetro, o retorno é `[]` e o POST sai sem
 *     os cards que são a razão de existir do template — 500 chamadas reais à
 *     Meta com payload quebrado, e rajada de recusa derruba o quality rating do
 *     número.
 *  2. FORMATO do cabeçalho (`FORMATOS_CABECALHO_SUPORTADOS`). Olhar só o tipo
 *     deixava passar `HEADER` com format `LOCATION`, que é um formato REAL da
 *     Cloud API: o builder emitiria `{type:'document'}` por eliminação e a Meta
 *     recusaria. E na tela era pior que recusar — `cabecalhoEhMidia` diz `false`,
 *     `variaveis.cabecalho` fica `[]` (o sync zera `cabecalho_texto` fora de
 *     TEXT), então NENHUM campo era renderizado, o botão ficava habilitado e a
 *     RPC recusava por "faltam valores" sem existir campo para preencher.
 */
export function motivoTemplateNaoSuportado(template: {
  tipos_componentes: string[] | null
  cabecalho_formato?: string | null
}): string | null {
  if (template.tipos_componentes === null) {
    return 'Os componentes deste template não estão num formato legível — o envio recusa o template inteiro.'
  }
  const naoSuportado = template.tipos_componentes.find((t) => !SUPORTADOS.has(t))
  if (naoSuportado !== undefined) {
    return `Tem um bloco ${naoSuportado || '(sem tipo)'}, que este envio não sabe montar (aceita ${TIPOS_COMPONENTE_SUPORTADOS.join(', ')}). Enviar assim entregaria a mensagem mutilada.`
  }
  if (!cabecalhoSuportado(template.cabecalho_formato)) {
    return `O cabeçalho é do tipo ${(template.cabecalho_formato ?? '').trim().toUpperCase()}, que este envio não sabe montar (aceita ${FORMATOS_CABECALHO_SUPORTADOS.join(', ')}). Enviar assim faria a Meta recusar a mensagem.`
  }
  return null
}

// ---------------------------------------------------------------------------
// Campos do formulário
// ---------------------------------------------------------------------------

export type OndeCampo = 'corpo' | 'cabecalho' | 'midia' | 'botao'

export interface CampoTemplate {
  /** Chave estável do estado do formulário e do `htmlFor`. */
  chave: string
  onde: OndeCampo
  /** `{{N}}` (1-indexado) para corpo; posição 0-indexada para botão; 0 para os
   *  campos únicos (cabeçalho de texto e mídia). */
  indice: number
  rotulo: string
  /** Trecho do texto do template em volta do `{{N}}` — sem ele o operador
   *  preenche "variável 2" sem saber o que ela é. `null` quando o texto não
   *  veio no catálogo. */
  contexto: string | null
  obrigatorio: boolean
  ajuda: string | null
}

const RAIO_CONTEXTO = 34

/**
 * Trecho do texto em volta do `{{N}}`, com reticências quando cortou.
 *
 * Busca a PRIMEIRA ocorrência: repetir `{{1}}` no texto é legal na Meta e o
 * valor é o mesmo nas duas, então mostrar a primeira já situa o operador.
 */
export function trechoDaVariavel(
  texto: string | null | undefined,
  indice: number,
  raio = RAIO_CONTEXTO,
): string | null {
  if (!texto) return null
  const alvo = `{{${indice}}}`
  const pos = texto.indexOf(alvo)
  if (pos < 0) return null

  const inicio = Math.max(0, pos - raio)
  const fim = Math.min(texto.length, pos + alvo.length + raio)
  const trecho = texto.slice(inicio, fim).replace(/\s+/g, ' ').trim()
  return `${inicio > 0 ? '…' : ''}${trecho}${fim < texto.length ? '…' : ''}`
}

/**
 * Um campo por valor que o envio vai exigir deste template.
 *
 * As quatro regras, cada uma copiada de uma linha específica do builder:
 *  - CORPO: um campo por índice de `variaveis.corpo`, todos obrigatórios.
 *  - CABEÇALHO DE TEXTO: UM campo só, mesmo que o texto tenha `{{1}}` e
 *    `{{2}}` — `buildHeaderComponent` emite exatamente um parâmetro por header.
 *    Renderizar dois campos prometeria ao operador um `{{2}}` que o envio
 *    descarta.
 *  - MÍDIA: pedida sempre que o formato é IMAGE/VIDEO/DOCUMENT; obrigatória a
 *    menos que o template traga `example.header_url[0]`, o único fallback que o
 *    builder aceita.
 *  - BOTÕES: por POSIÇÃO (0-indexada). URL com `{{N}}` e COPY_CODE exigem
 *    valor; QUICK_REPLY e PHONE_NUMBER nunca exigem.
 */
export function derivarCamposTemplate(
  template: Pick<
    WhatsAppTemplate,
    'variaveis' | 'cabecalho_formato' | 'cabecalho_texto' | 'corpo_texto' | 'cabecalho_midia_exemplo'
  >,
): CampoTemplate[] {
  const campos: CampoTemplate[] = []
  const variaveis = template.variaveis

  for (const indice of variaveis?.corpo ?? []) {
    campos.push({
      chave: `corpo:${indice}`,
      onde: 'corpo',
      indice,
      rotulo: `{{${indice}}}`,
      contexto: trechoDaVariavel(template.corpo_texto, indice),
      obrigatorio: true,
      ajuda: null,
    })
  }

  const ehMidia = cabecalhoEhMidia(template.cabecalho_formato)

  if (!ehMidia && (variaveis?.cabecalho.length ?? 0) > 0) {
    campos.push({
      chave: 'cabecalho',
      onde: 'cabecalho',
      indice: 0,
      rotulo: 'Cabeçalho',
      contexto: trechoDaVariavel(
        template.cabecalho_texto,
        variaveis?.cabecalho[0] ?? 1,
      ),
      obrigatorio: true,
      ajuda:
        (variaveis?.cabecalho.length ?? 0) > 1
          ? 'O cabeçalho consome um valor só, mesmo tendo mais de um {{N}} — é assim que a Meta recebe.'
          : null,
    })
  }

  if (ehMidia) {
    campos.push({
      chave: 'midia',
      onde: 'midia',
      indice: 0,
      rotulo: `Mídia do cabeçalho (${(template.cabecalho_formato ?? '').toUpperCase()})`,
      contexto: null,
      obrigatorio: !template.cabecalho_midia_exemplo,
      ajuda: template.cabecalho_midia_exemplo
        ? 'Em branco, sai a mídia de exemplo aprovada com o template.'
        : 'URL pública do arquivo. Este template não tem mídia de exemplo aprovada: sem link, todo envio falha.',
    })
  }

  for (const botao of variaveis?.botoes ?? []) {
    const tipo = (botao.tipo ?? '').trim().toUpperCase()
    const exigeValor =
      (tipo === 'URL' && botao.variaveis.length > 0) || tipo === 'COPY_CODE'
    if (!exigeValor) continue
    campos.push({
      chave: `botao:${botao.indice}`,
      onde: 'botao',
      indice: botao.indice,
      rotulo: `Botão ${botao.indice + 1} (${tipo})`,
      contexto: null,
      obrigatorio: true,
      ajuda:
        tipo === 'COPY_CODE'
          ? 'Código que o cliente copia. Sem valor, sai o código de exemplo da aprovação.'
          : 'Trecho variável da URL do botão.',
    })
  }

  return campos
}

/** Rótulo curto de um campo, para as mensagens de "falta isto". */
export function rotuloCampo(campo: CampoTemplate): string {
  if (campo.onde === 'corpo') return `corpo ${campo.rotulo}`
  if (campo.onde === 'cabecalho') return 'cabeçalho'
  if (campo.onde === 'midia') return 'mídia do cabeçalho'
  return `botão ${campo.indice + 1}`
}

export type ValoresCampos = Record<string, string>

/** Campos obrigatórios ainda em branco. Vazio = o formulário pode ser enviado. */
export function camposFaltando(
  campos: CampoTemplate[],
  valores: ValoresCampos,
): CampoTemplate[] {
  return campos.filter((c) => c.obrigatorio && (valores[c.chave] ?? '').trim().length === 0)
}

/**
 * Do formulário para a FORMA DE ENVIO (`VariaveisPadrao`), que é a única que o
 * adapter lê.
 *
 * Duas decisões que parecem detalhe e não são:
 *
 *  1. `body` é DENSO e a posição É a identidade. Buraco no meio vira string
 *     vazia — compactar deslocaria o valor de `{{3}}` para o lugar de `{{2}}`,
 *     e a mensagem sairia plausível e errada. O corte usa o MAIOR índice
 *     exigido pelo template, não o que o operador digitou.
 *  2. Chave em branco é OMITIDA, nunca mandada como `''`. No caso do
 *     `headerMediaUrl` isso é bomba armada: o builder faz
 *     `params.headerMediaUrl ?? header.example?.header_url?.[0]`, e `??` NÃO
 *     cai para o exemplo quando o valor é string vazia — mandar `''` mataria o
 *     único fallback existente e transformaria um envio que funcionaria num 422.
 */
export function montarVariaveisPadrao(
  campos: CampoTemplate[],
  valores: ValoresCampos,
): VariaveisPadrao {
  const out: VariaveisPadrao = {}

  const limpo = (chave: string): string => (valores[chave] ?? '').trim()

  const indicesCorpo = campos.filter((c) => c.onde === 'corpo').map((c) => c.indice)
  if (indicesCorpo.length > 0) {
    const maior = Math.max(...indicesCorpo)
    const body: string[] = []
    for (let i = 1; i <= maior; i += 1) body.push(limpo(`corpo:${i}`))
    out.body = body
  }

  const headerText = limpo('cabecalho')
  if (headerText) out.headerText = headerText

  const midia = limpo('midia')
  if (midia) out.headerMediaUrl = midia

  const buttonParams: Record<number, string> = {}
  for (const campo of campos) {
    if (campo.onde !== 'botao') continue
    const valor = limpo(campo.chave)
    if (valor) buttonParams[campo.indice] = valor
  }
  if (Object.keys(buttonParams).length > 0) out.buttonParams = buttonParams

  return out
}

// ---------------------------------------------------------------------------
// Validação de entrada (rota)
// ---------------------------------------------------------------------------

export interface RecusaVariaveis {
  slug: string
  extra: Record<string, unknown>
}

/**
 * Valida `config.variaveis_padrao` na ENTRADA da rota de criação.
 *
 * A rota confere a FORMA e o TETO; o MÍNIMO (faltou valor) é do banco, que é a
 * única autoridade que sobrevive a uma UI trocada — mesma divisão de trabalho
 * do envio 1:1, cujo comentário explica por que o teto não pode ficar só no
 * Postgres: o render roda dentro da transação, no banco compartilhado, e uma
 * campanha multiplica o mesmo render por todo o público.
 *
 * `isRecord` do adapter ACEITA array (`typeof [] === 'object'`), então um
 * `['Ana','10h']` gravado aqui atravessaria tudo e só apareceria no envio como
 * "only 0 value(s) were supplied" — erro que aponta para o lugar errado.
 */
export function validarVariaveisPadrao(valor: unknown): RecusaVariaveis | null {
  if (valor === undefined || valor === null) return null
  if (!ehObjeto(valor)) return { slug: 'variaveis_padrao_invalida', extra: { campo: 'raiz' } }

  const { body, headerText, headerMediaUrl, headerMediaId, buttonParams } = valor

  if (body !== undefined && body !== null) {
    if (!Array.isArray(body) || body.some((v) => typeof v !== 'string')) {
      return { slug: 'variaveis_padrao_invalida', extra: { campo: 'body' } }
    }
    if (body.length > TEMPLATE_MAX_VALORES) {
      return {
        slug: 'valores_demais',
        extra: { onde: 'body', limite: TEMPLATE_MAX_VALORES, recebidos: body.length },
      }
    }
    const posicao = (body as string[]).findIndex((v) => v.length > TEMPLATE_MAX_TAMANHO_VALOR)
    if (posicao >= 0) {
      return {
        slug: 'valor_muito_longo',
        extra: {
          onde: 'body',
          // 1-indexado para casar com o `{{N}}` que o operador vê na tela.
          indice: posicao + 1,
          limite: TEMPLATE_MAX_TAMANHO_VALOR,
          recebidos: (body as string[])[posicao].length,
        },
      }
    }
  }

  for (const [nome, bruto] of [
    ['headerText', headerText],
    ['headerMediaUrl', headerMediaUrl],
    ['headerMediaId', headerMediaId],
  ] as const) {
    if (bruto === undefined || bruto === null) continue
    if (typeof bruto !== 'string') {
      return { slug: 'variaveis_padrao_invalida', extra: { campo: nome } }
    }
    if (bruto.length > TEMPLATE_MAX_TAMANHO_VALOR) {
      return {
        slug: 'valor_muito_longo',
        extra: { onde: nome, limite: TEMPLATE_MAX_TAMANHO_VALOR, recebidos: bruto.length },
      }
    }
  }

  if (buttonParams !== undefined && buttonParams !== null) {
    if (!ehObjeto(buttonParams)) {
      return { slug: 'variaveis_padrao_invalida', extra: { campo: 'buttonParams' } }
    }
    for (const [chave, bruto] of Object.entries(buttonParams)) {
      // A chave é a POSIÇÃO do botão. Chave não-numérica nunca casa com o
      // `params.buttonParams?.[i]` do builder — seria valor digitado que some.
      if (!/^\d+$/.test(chave)) {
        return { slug: 'variaveis_padrao_invalida', extra: { campo: `buttonParams.${chave}` } }
      }
      if (typeof bruto !== 'string') {
        return { slug: 'variaveis_padrao_invalida', extra: { campo: `buttonParams.${chave}` } }
      }
      if (bruto.length > TEMPLATE_MAX_TAMANHO_VALOR) {
        return {
          slug: 'valor_muito_longo',
          extra: {
            onde: `buttonParams.${chave}`,
            limite: TEMPLATE_MAX_TAMANHO_VALOR,
            recebidos: bruto.length,
          },
        }
      }
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Veredito para a tela de detalhe
// ---------------------------------------------------------------------------

/**
 * O que ainda falta numa campanha JÁ CRIADA, comparando o `variaveis_padrao`
 * gravado com o que o template exige HOJE.
 *
 * "Hoje" é a palavra que justifica esta função existir mesmo com o gate na
 * criação: o sync reescreve `variaveis` de um template já aprovado, então a
 * Meta pode aprovar uma edição que acrescenta `{{4}}` DEPOIS da campanha
 * criada. É o mesmo motivo pelo qual `template_nao_aprovado` é checado em dois
 * lugares.
 */
export function faltandoNaCampanha(
  template: Parameters<typeof derivarCamposTemplate>[0],
  gravado: VariaveisPadrao | null,
): string[] {
  const campos = derivarCamposTemplate(template)
  const valores: ValoresCampos = {}

  for (const [i, v] of (gravado?.body ?? []).entries()) {
    if (typeof v === 'string') valores[`corpo:${i + 1}`] = v
  }
  if (typeof gravado?.headerText === 'string') valores.cabecalho = gravado.headerText
  // `headerMediaId` satisfaz a mídia tanto quanto o link — o builder aceita os dois.
  const midia = gravado?.headerMediaUrl ?? gravado?.headerMediaId
  if (typeof midia === 'string') valores.midia = midia
  for (const [chave, v] of Object.entries(gravado?.buttonParams ?? {})) {
    if (typeof v === 'string') valores[`botao:${chave}`] = v
  }

  return camposFaltando(campos, valores).map(rotuloCampo)
}
