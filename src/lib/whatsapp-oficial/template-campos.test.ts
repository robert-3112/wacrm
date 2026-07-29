/**
 * Testes da derivação "template -> campos do formulário -> forma de envio".
 *
 * O que estes testes existem para travar, em ordem de estrago se quebrar:
 *  1. `body` DENSO — buraco no meio não pode compactar, senão o valor de
 *     `{{3}}` sai no lugar do `{{2}}` e a mensagem fica plausível e errada.
 *  2. `headerText` STRING, nunca array: o builder emite um parâmetro só por
 *     header, então dois campos na tela prometeriam um `{{2}}` que o envio
 *     descarta.
 *  3. Chave em branco OMITIDA — em especial `headerMediaUrl`, porque o `??` do
 *     builder não cai para o exemplo do template quando o valor é `''`.
 *  4. CAROUSEL (e qualquer tipo fora da lista positiva) barrado ANTES de
 *     alguém criar público em cima dele.
 *  5. Forma errada de `variaveis_padrao` recusada na entrada da rota: array e
 *     escalar atravessam `isRecord` do adapter e só aparecem no envio como
 *     "only 0 value(s) were supplied", apontando para o lugar errado.
 */

import { describe, expect, it } from 'vitest'
import {
  camposFaltando,
  derivarCamposTemplate,
  faltandoNaCampanha,
  montarVariaveisPadrao,
  motivoTemplateNaoSuportado,
  resumirComponentes,
  rotuloCampo,
  trechoDaVariavel,
  validarVariaveisPadrao,
} from './template-campos'
import { TEMPLATE_MAX_TAMANHO_VALOR } from './meta-templates'
import type { WhatsAppTemplate } from '@/types/whatsapp-oficial'

type CampoDerivavel = Parameters<typeof derivarCamposTemplate>[0]

function template(over: Partial<CampoDerivavel> = {}): CampoDerivavel {
  return {
    variaveis: { cabecalho: [], corpo: [], botoes: [] },
    cabecalho_formato: null,
    cabecalho_texto: null,
    corpo_texto: null,
    cabecalho_midia_exemplo: false,
    ...over,
  }
}

// ---------------------------------------------------------------- componentes

describe('resumirComponentes', () => {
  it('lista os tipos em maiúscula e na ordem em que aparecem', () => {
    const r = resumirComponentes([
      { type: 'header', format: 'TEXT', text: 'Olá {{1}}' },
      { type: 'BODY', text: 'oi' },
      { type: 'BUTTONS', buttons: [] },
    ])
    expect(r.tipos).toEqual(['HEADER', 'BODY', 'BUTTONS'])
  })

  it('blob que não é array vira tipos=null — template malformado, não template vazio', () => {
    // `[]` (array sem blocos) e `null` (blob ilegível) têm veredito diferente:
    // o primeiro passa, o segundo bloqueia o template inteiro.
    expect(resumirComponentes(null).tipos).toBeNull()
    expect(resumirComponentes('{}').tipos).toBeNull()
    expect(resumirComponentes({ type: 'BODY' }).tipos).toBeNull()
    expect(resumirComponentes([]).tipos).toEqual([])
  })

  it('só aceita example.header_url[0] como mídia de exemplo', () => {
    const comHandle = resumirComponentes([
      { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['abc'] } },
    ])
    // `header_handle` NÃO é lido por `buildHeaderComponent`. Contá-lo aqui
    // deixaria a tela otimista e o envio quebrado.
    expect(comHandle.cabecalhoMidiaExemplo).toBe(false)

    const comUrl = resumirComponentes([
      { type: 'HEADER', format: 'IMAGE', example: { header_url: ['https://x/y.png'] } },
    ])
    expect(comUrl.cabecalhoMidiaExemplo).toBe(true)

    const vazio = resumirComponentes([
      { type: 'HEADER', format: 'IMAGE', example: { header_url: ['  '] } },
    ])
    expect(vazio.cabecalhoMidiaExemplo).toBe(false)
  })

  it('medido em produção: image_cta tem HEADER IMAGE sem example nenhum', () => {
    const r = resumirComponentes([
      { type: 'HEADER', format: 'IMAGE' },
      { type: 'BODY', text: 'texto' },
    ])
    expect(r.cabecalhoMidiaExemplo).toBe(false)
  })
})

describe('motivoTemplateNaoSuportado', () => {
  it('CRÍTICO: CAROUSEL é barrado, com o motivo', () => {
    const motivo = motivoTemplateNaoSuportado({
      tipos_componentes: ['BODY', 'BUTTONS', 'CAROUSEL'],
    })
    expect(motivo).toContain('CAROUSEL')
  })

  it('os quatro tipos conhecidos passam, em qualquer ordem', () => {
    expect(
      motivoTemplateNaoSuportado({
        tipos_componentes: ['BUTTONS', 'FOOTER', 'BODY', 'HEADER'],
      }),
    ).toBeNull()
    expect(motivoTemplateNaoSuportado({ tipos_componentes: [] })).toBeNull()
  })

  it('blob ilegível bloqueia o template inteiro', () => {
    expect(motivoTemplateNaoSuportado({ tipos_componentes: null })).toContain('legível')
  })

  it('tipo novo da Meta cai fora — a lista é positiva', () => {
    expect(
      motivoTemplateNaoSuportado({ tipos_componentes: ['BODY', 'LIMITED_TIME_OFFER'] }),
    ).toContain('LIMITED_TIME_OFFER')
  })

  it('bloco SEM `type` bloqueia — string vazia não pode passar por ser falsy', () => {
    // `resumirComponentes` empurra `''` para o bloco sem tipo, e `find` devolve `''`.
    // Testar a verdade do valor em vez da presença deixava esse template livre na tela,
    // enquanto o builder o recusa (`TIPOS_SUPORTADOS.has('')` é false).
    expect(motivoTemplateNaoSuportado({ tipos_componentes: ['BODY', ''] })).toContain('sem tipo')
  })

  it('CRÍTICO: FORMATO de cabeçalho fora da lista é barrado, não só o tipo do bloco', () => {
    // LOCATION é formato real da Cloud API. Olhando só `tipos_componentes`, este template
    // passava: HEADER e BODY são os dois suportados. O envio emitiria `{type:'document'}`
    // por eliminação e a Meta recusaria.
    const motivo = motivoTemplateNaoSuportado({
      tipos_componentes: ['HEADER', 'BODY'],
      cabecalho_formato: 'LOCATION',
    })
    expect(motivo).toContain('LOCATION')
  })

  it('os formatos de cabeçalho conhecidos passam, e ausente conta como TEXT', () => {
    for (const formato of ['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'image', null, undefined, '']) {
      expect(
        motivoTemplateNaoSuportado({
          tipos_componentes: ['HEADER', 'BODY'],
          cabecalho_formato: formato,
        }),
      ).toBeNull()
    }
  })
})

// ---------------------------------------------------------------- contexto

describe('trechoDaVariavel', () => {
  it('mostra o texto em volta do {{N}}, com reticências quando cortou', () => {
    const texto =
      'Bom dia! Confirmamos a sua visita ao empreendimento {{2}} para o dia {{3}}, tudo certo?'
    expect(trechoDaVariavel(texto, 2)).toContain('{{2}}')
    expect(trechoDaVariavel(texto, 2)).toContain('empreendimento')
    expect(trechoDaVariavel(texto, 2)?.startsWith('…')).toBe(true)
  })

  it('devolve null quando o índice não está no texto ou não há texto', () => {
    expect(trechoDaVariavel('Oi {{1}}', 2)).toBeNull()
    expect(trechoDaVariavel(null, 1)).toBeNull()
  })
})

// ---------------------------------------------------------------- campos

describe('derivarCamposTemplate', () => {
  it('um campo por variável do corpo, todos obrigatórios, com o trecho do texto', () => {
    const campos = derivarCamposTemplate(
      template({
        variaveis: { cabecalho: [], corpo: [1, 2, 3], botoes: [] },
        corpo_texto: 'Olá {{1}}, seu pedido {{2}} chega em {{3}}.',
      }),
    )
    expect(campos.map((c) => c.chave)).toEqual(['corpo:1', 'corpo:2', 'corpo:3'])
    expect(campos.every((c) => c.obrigatorio)).toBe(true)
    expect(campos[1].contexto).toContain('{{2}}')
  })

  it('hello_world (zero variável) não gera campo nenhum', () => {
    expect(derivarCamposTemplate(template())).toEqual([])
  })

  it('CRÍTICO: cabeçalho de TEXTO gera UM campo só, mesmo com dois {{N}}', () => {
    // `buildHeaderComponent` emite exatamente um parâmetro de texto por header.
    // Dois campos na tela prometeriam um valor que o envio descarta.
    const campos = derivarCamposTemplate(
      template({
        variaveis: { cabecalho: [1, 2], corpo: [], botoes: [] },
        cabecalho_formato: 'TEXT',
        cabecalho_texto: '{{1}} e {{2}}',
      }),
    )
    expect(campos.filter((c) => c.onde === 'cabecalho')).toHaveLength(1)
    expect(campos[0].ajuda).toContain('um valor só')
  })

  it('header de mídia pede a URL, e ela é OBRIGATÓRIA quando não há exemplo', () => {
    const semExemplo = derivarCamposTemplate(
      template({ cabecalho_formato: 'IMAGE', cabecalho_midia_exemplo: false }),
    )
    expect(semExemplo).toHaveLength(1)
    expect(semExemplo[0].onde).toBe('midia')
    expect(semExemplo[0].obrigatorio).toBe(true)

    const comExemplo = derivarCamposTemplate(
      template({ cabecalho_formato: 'VIDEO', cabecalho_midia_exemplo: true }),
    )
    expect(comExemplo[0].obrigatorio).toBe(false)
  })

  it('ARMADILHA: header de mídia tem variaveis.cabecalho vazio e mesmo assim exige valor', () => {
    // O sync ZERA `cabecalho_texto` quando o formato não é TEXT, então
    // `variaveis.cabecalho` fica `[]` e parece "não exige nada". Quem decide é
    // `cabecalho_formato`.
    const campos = derivarCamposTemplate(
      template({
        variaveis: { cabecalho: [], corpo: [], botoes: [] },
        cabecalho_formato: 'DOCUMENT',
      }),
    )
    expect(campos.map((c) => c.onde)).toEqual(['midia'])
  })

  it('botão: URL com {{N}} e COPY_CODE exigem valor; QUICK_REPLY e PHONE_NUMBER não', () => {
    const campos = derivarCamposTemplate(
      template({
        variaveis: {
          cabecalho: [],
          corpo: [],
          botoes: [
            { indice: 0, tipo: 'QUICK_REPLY', variaveis: [] },
            { indice: 1, tipo: 'URL', variaveis: [] },
            { indice: 2, tipo: 'URL', variaveis: [1] },
            { indice: 3, tipo: 'COPY_CODE', variaveis: [] },
            { indice: 4, tipo: 'PHONE_NUMBER', variaveis: [] },
          ],
        },
      }),
    )
    // A POSIÇÃO é a identidade do botão no envio — o índice preservado é o do
    // catálogo, não a ordem dos campos.
    expect(campos.map((c) => c.chave)).toEqual(['botao:2', 'botao:3'])
  })
})

// ---------------------------------------------------------------- forma de envio

describe('montarVariaveisPadrao', () => {
  const tresVariaveis = template({
    variaveis: { cabecalho: [], corpo: [1, 2, 3], botoes: [] },
  })

  it('CRÍTICO: body é DENSO — buraco no meio vira string vazia, nunca compacta', () => {
    const campos = derivarCamposTemplate(tresVariaveis)
    const v = montarVariaveisPadrao(campos, { 'corpo:1': 'Ana', 'corpo:3': '10h' })
    // Compactar mandaria "10h" para o lugar de {{2}}.
    expect(v.body).toEqual(['Ana', '', '10h'])
  })

  it('corta no MAIOR índice exigido pelo template, não no que foi digitado', () => {
    const campos = derivarCamposTemplate(
      template({ variaveis: { cabecalho: [], corpo: [1], botoes: [] } }),
    )
    const v = montarVariaveisPadrao(campos, { 'corpo:1': 'a', 'corpo:2': 'sobra' })
    expect(v.body).toEqual(['a'])
  })

  it('CRÍTICO: headerText é STRING, não array', () => {
    const campos = derivarCamposTemplate(
      template({ variaveis: { cabecalho: [1], corpo: [], botoes: [] } }),
    )
    const v = montarVariaveisPadrao(campos, { cabecalho: 'Ana' })
    expect(v.headerText).toBe('Ana')
    expect(Array.isArray(v.headerText)).toBe(false)
  })

  it('CRÍTICO: headerMediaUrl em branco é OMITIDA, nunca mandada como ""', () => {
    // O builder faz `params.headerMediaUrl ?? example.header_url[0]`, e `??`
    // NÃO cai para o exemplo quando o valor é string vazia: mandar `''` mataria
    // o único fallback existente.
    const campos = derivarCamposTemplate(
      template({ cabecalho_formato: 'IMAGE', cabecalho_midia_exemplo: true }),
    )
    expect(montarVariaveisPadrao(campos, { midia: '   ' })).toEqual({})
    expect(montarVariaveisPadrao(campos, { midia: ' https://x/y.png ' })).toEqual({
      headerMediaUrl: 'https://x/y.png',
    })
  })

  it('template sem variável nenhuma produz objeto VAZIO (que a config omite)', () => {
    expect(montarVariaveisPadrao([], {})).toEqual({})
  })

  it('buttonParams é indexado pela POSIÇÃO do botão, 0-based', () => {
    const campos = derivarCamposTemplate(
      template({
        variaveis: {
          cabecalho: [],
          corpo: [],
          botoes: [
            { indice: 0, tipo: 'QUICK_REPLY', variaveis: [] },
            { indice: 1, tipo: 'URL', variaveis: [1] },
          ],
        },
      }),
    )
    const v = montarVariaveisPadrao(campos, { 'botao:1': 'promo-julho' })
    expect(v.buttonParams).toEqual({ 1: 'promo-julho' })
  })
})

describe('camposFaltando', () => {
  it('só cobra o obrigatório, e espaço em branco não conta como preenchido', () => {
    const campos = derivarCamposTemplate(
      template({
        variaveis: { cabecalho: [], corpo: [1, 2], botoes: [] },
        cabecalho_formato: 'IMAGE',
        cabecalho_midia_exemplo: true,
      }),
    )
    const faltando = camposFaltando(campos, { 'corpo:1': 'Ana', 'corpo:2': '   ' })
    expect(faltando.map(rotuloCampo)).toEqual(['corpo {{2}}'])
  })
})

describe('faltandoNaCampanha', () => {
  const tpl = template({
    variaveis: { cabecalho: [], corpo: [1, 2, 3], botoes: [] },
    corpo_texto: '{{1}} {{2}} {{3}}',
  })

  it('CRÍTICO: campanha antiga com variaveis_padrao vazio acusa tudo que falta', () => {
    // Este é o estado em que TODA campanha nascia antes desta trava.
    expect(faltandoNaCampanha(tpl, {})).toEqual([
      'corpo {{1}}',
      'corpo {{2}}',
      'corpo {{3}}',
    ])
    expect(faltandoNaCampanha(tpl, null)).toHaveLength(3)
  })

  it('campanha completa não acusa nada', () => {
    expect(faltandoNaCampanha(tpl, { body: ['a', 'b', 'c'] })).toEqual([])
  })

  it('headerMediaId satisfaz a mídia tanto quanto o link', () => {
    const comMidia = template({ cabecalho_formato: 'IMAGE' })
    expect(faltandoNaCampanha(comMidia, { headerMediaId: '123' })).toEqual([])
    expect(faltandoNaCampanha(comMidia, {})).toEqual(['mídia do cabeçalho'])
  })

  it('drift: template que ganhou um {{4}} depois da criação passa a acusar falta', () => {
    const depois = template({ variaveis: { cabecalho: [], corpo: [1, 2, 3, 4], botoes: [] } })
    expect(faltandoNaCampanha(depois, { body: ['a', 'b', 'c'] })).toEqual(['corpo {{4}}'])
  })
})

// ---------------------------------------------------------------- validação

describe('validarVariaveisPadrao', () => {
  it('ausente e vazio são aceitos — template estático não exige nada', () => {
    expect(validarVariaveisPadrao(undefined)).toBeNull()
    expect(validarVariaveisPadrao(null)).toBeNull()
    expect(validarVariaveisPadrao({})).toBeNull()
  })

  it('CRÍTICO: array é recusado — `isRecord` do adapter aceitaria e o erro sairia errado', () => {
    expect(validarVariaveisPadrao(['Ana', '10h'])?.slug).toBe('variaveis_padrao_invalida')
    expect(validarVariaveisPadrao('Ana')?.slug).toBe('variaveis_padrao_invalida')
    expect(validarVariaveisPadrao(42)?.slug).toBe('variaveis_padrao_invalida')
  })

  it('CRÍTICO: body não-array é recusado — no worker viraria TypeError e 5 retentativas', () => {
    expect(validarVariaveisPadrao({ body: 'Ana' })?.slug).toBe('variaveis_padrao_invalida')
    expect(validarVariaveisPadrao({ body: 42 })?.slug).toBe('variaveis_padrao_invalida')
    expect(validarVariaveisPadrao({ body: {} })?.slug).toBe('variaveis_padrao_invalida')
  })

  it('item não-string no body é recusado — String(null) entregaria a palavra "null"', () => {
    expect(validarVariaveisPadrao({ body: ['ok', null] })?.slug).toBe('variaveis_padrao_invalida')
    expect(validarVariaveisPadrao({ body: ['ok', 123] })?.slug).toBe('variaveis_padrao_invalida')
  })

  it('aplica o teto de 40 valores', () => {
    const r = validarVariaveisPadrao({ body: Array.from({ length: 41 }, () => 'x') })
    expect(r?.slug).toBe('valores_demais')
    expect(r?.extra).toMatchObject({ onde: 'body', limite: 40, recebidos: 41 })
  })

  it('aplica o teto de 1024 chars, com índice 1-indexado para casar com o {{N}}', () => {
    const r = validarVariaveisPadrao({
      body: ['ok', 'x'.repeat(TEMPLATE_MAX_TAMANHO_VALOR + 1)],
    })
    expect(r?.slug).toBe('valor_muito_longo')
    expect(r?.extra).toMatchObject({ onde: 'body', indice: 2 })
  })

  it('headerText/headerMediaUrl/headerMediaId precisam ser string e respeitar o teto', () => {
    expect(validarVariaveisPadrao({ headerText: ['Ana'] })?.slug).toBe(
      'variaveis_padrao_invalida',
    )
    expect(
      validarVariaveisPadrao({ headerMediaUrl: 'x'.repeat(TEMPLATE_MAX_TAMANHO_VALOR + 1) })?.slug,
    ).toBe('valor_muito_longo')
    expect(validarVariaveisPadrao({ headerMediaId: 'abc' })).toBeNull()
  })

  it('buttonParams: objeto com chave numérica e valor string', () => {
    expect(validarVariaveisPadrao({ buttonParams: { 0: 'promo' } })).toBeNull()
    expect(validarVariaveisPadrao({ buttonParams: ['promo'] })?.slug).toBe(
      'variaveis_padrao_invalida',
    )
    // Chave não-numérica nunca casa com `params.buttonParams?.[i]` do builder:
    // seria valor digitado que some.
    expect(validarVariaveisPadrao({ buttonParams: { url: 'promo' } })?.slug).toBe(
      'variaveis_padrao_invalida',
    )
    expect(validarVariaveisPadrao({ buttonParams: { 0: 7 } })?.slug).toBe(
      'variaveis_padrao_invalida',
    )
  })

  it('chave desconhecida passa: o adapter a ignora e o banco é quem cobra o mínimo', () => {
    // Recusar aqui bloquearia campo novo que o builder ganhe amanhã; o gate que
    // importa (faltou valor) é o do Postgres.
    expect(validarVariaveisPadrao({ nome: 'Ana' })).toBeNull()
  })
})

// ---------------------------------------------------------------- integração

describe('do catálogo ao envio (o caminho inteiro)', () => {
  it('order_confirmation: 3 valores digitados viram o body que o adapter lê', () => {
    const catalogo = {
      variaveis: { cabecalho: [], corpo: [1, 2, 3], botoes: [] },
      cabecalho_formato: null,
      cabecalho_texto: null,
      corpo_texto: 'Olá {{1}}, o pedido {{2}} chega em {{3}}.',
      cabecalho_midia_exemplo: false,
    } satisfies CampoDerivavel

    const campos = derivarCamposTemplate(catalogo)
    const valores = { 'corpo:1': 'Ana', 'corpo:2': '#42', 'corpo:3': 'sexta' }

    expect(camposFaltando(campos, valores)).toEqual([])
    const variaveis = montarVariaveisPadrao(campos, valores)
    expect(variaveis).toEqual({ body: ['Ana', '#42', 'sexta'] })
    expect(validarVariaveisPadrao(variaveis)).toBeNull()
    expect(faltandoNaCampanha(catalogo, variaveis)).toEqual([])
  })

  it('image_cta: sem a URL da mídia o formulário não deixa criar', () => {
    const catalogo = template({ cabecalho_formato: 'IMAGE', cabecalho_midia_exemplo: false })
    const campos = derivarCamposTemplate(catalogo)
    expect(camposFaltando(campos, {}).map(rotuloCampo)).toEqual(['mídia do cabeçalho'])

    const variaveis = montarVariaveisPadrao(campos, { midia: 'https://cdn/x.png' })
    expect(variaveis).toEqual({ headerMediaUrl: 'https://cdn/x.png' })
    expect(faltandoNaCampanha(catalogo, variaveis)).toEqual([])
  })
})

// O tipo do catálogo precisa continuar cabendo no que a derivação pede — se
// `WhatsAppTemplate` perder um destes campos, isto quebra no typecheck.
const _compat: CampoDerivavel = {} as Pick<
  WhatsAppTemplate,
  'variaveis' | 'cabecalho_formato' | 'cabecalho_texto' | 'corpo_texto' | 'cabecalho_midia_exemplo'
>
void _compat
