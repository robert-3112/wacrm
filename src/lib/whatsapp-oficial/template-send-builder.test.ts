import { describe, it, expect } from 'vitest'
import {
  buildSendComponents,
  TemplateBuildError,
  type MetaTemplateComponent,
} from './template-send-builder'
import { classifyMetaError } from './outbox'

/**
 * Os componentes abaixo NÃO são inventados: são os `components` que a Graph API v24.0
 * devolveu para a WABA de teste da Meta em 2026-07-29, capturados na primeira vez que o
 * canal oficial foi ligado. Testar contra a forma conveniente (a que a gente imagina) em
 * vez da forma real é exatamente o que deixou passar o defeito de tradução dupla de
 * status no lado do CRM.
 */
const REAIS: Record<string, MetaTemplateComponent[]> = {
  // Só corpo, sem variável — enviável sem nenhum parâmetro.
  plain_text: [
    { type: 'BODY', text: 'Welcome to Jasper Market, your local grocery store!' },
  ],
  // HEADER/TEXT sem {{N}} + BODY sem {{N}} + FOOTER. FOOTER nunca leva parâmetro.
  hello_world: [
    { type: 'HEADER', format: 'TEXT', text: 'Hello World' },
    { type: 'BODY', text: 'Welcome and congratulations!!' },
    { type: 'FOOTER', text: 'WhatsApp Business Platform sample message' },
  ],
  // Corpo com {{1}}{{2}}{{3}} — o formato mais comum de template útil de verdade.
  order_confirmation: [
    { type: 'HEADER', format: 'TEXT', text: 'Order confirmed' },
    { type: 'BODY', text: 'Hi {{1}}, your order {{2}} arrives {{3}}.' },
    { type: 'FOOTER', text: 'developers.facebook.com' },
    {
      type: 'BUTTONS',
      buttons: [{ type: 'URL', text: 'Visit order details', url: 'https://example.test/v' }],
    },
  ],
  // HEADER/IMAGE SEM `example` — é assim que a Meta devolve de verdade. O fallback do
  // builder lê `example.header_url`, que não existe em nenhum caso real.
  image_cta: [
    { type: 'HEADER', format: 'IMAGE' },
    { type: 'BODY', text: 'Free delivery for all online orders' },
    { type: 'FOOTER', text: 'developers.facebook.com' },
    {
      type: 'BUTTONS',
      buttons: [{ type: 'URL', text: 'Get free delivery', url: 'https://example.test/w' }],
    },
  ],
  // CAROUSEL: cards aninhados, cada um com HEADER/BODY/BUTTONS próprios.
  media_carousel: [
    { type: 'BODY', text: 'Our in-house chefs have prepared some fresh summer recipes.' },
    {
      type: 'BUTTONS',
      buttons: [{ type: 'URL', text: 'Get free delivery', url: 'https://example.test/x' }],
    },
    {
      type: 'CAROUSEL',
      cards: [
        { components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Card 1' }] },
        { components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Card 2' }] },
      ],
    } as unknown as MetaTemplateComponent,
  ],
}

describe('buildSendComponents contra os formatos REAIS da Meta', () => {
  it('monta os estáticos sem exigir nenhum parâmetro', () => {
    expect(buildSendComponents(REAIS.plain_text)).toEqual([])
    expect(buildSendComponents(REAIS.hello_world)).toEqual([])
  })

  it('monta o corpo quando os valores são passados', () => {
    const out = buildSendComponents(REAIS.order_confirmation, {
      body: ['Maria', '#1234', 'sexta-feira'],
    })
    expect(out).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Maria' },
          { type: 'text', text: '#1234' },
          { type: 'text', text: 'sexta-feira' },
        ],
      },
    ])
  })

  it('RECUSA o carrossel em vez de descartá-lo em silêncio', () => {
    // Antes deste conserto o retorno era `[]` — e `meta-api.ts` omite a chave
    // `components` quando o array é vazio, então o POST saía como {name, language} puro,
    // sem os cards. Numa campanha isso vira uma recusa da Meta por destinatário.
    expect(() => buildSendComponents(REAIS.media_carousel)).toThrow(TemplateBuildError)
    expect(() => buildSendComponents(REAIS.media_carousel)).toThrow(/CAROUSEL/)
  })

  it('recusa qualquer tipo de componente que a Meta invente depois', () => {
    const futuro = [
      { type: 'BODY', text: 'oi' },
      { type: 'LIMITED_TIME_OFFER' as unknown as 'BODY' },
    ] as MetaTemplateComponent[]
    expect(() => buildSendComponents(futuro)).toThrow(/LIMITED_TIME_OFFER/)
  })

  it('recusa FORMATO de cabeçalho fora da lista em vez de mandá-lo como documento', () => {
    // LOCATION é formato real da Cloud API. O parâmetro de mídia era escolhido por
    // eliminação (`IMAGE ? image : VIDEO ? video : document`), então este header saía como
    // `{type:'document', document:{link}}` e a Meta recusava — em rajada, numa campanha.
    const location = [
      { type: 'HEADER', format: 'LOCATION' as unknown as 'IMAGE' },
      { type: 'BODY', text: 'Te espero lá' },
    ] as MetaTemplateComponent[]

    expect(() => buildSendComponents(location)).toThrow(TemplateBuildError)
    expect(() => buildSendComponents(location)).toThrow(/LOCATION/)
    // Nem com link: não há valor que conserte um formato que o builder não sabe montar.
    expect(() =>
      buildSendComponents(location, { headerMediaUrl: 'https://cdn.test/x.png' }),
    ).toThrow(/LOCATION/)
  })

  it('o formato do cabeçalho é normalizado antes de decidir (minúscula e espaço)', () => {
    const minusculo = [
      { type: 'HEADER', format: 'image' as unknown as 'IMAGE' },
      { type: 'BODY', text: 'oi' },
    ] as MetaTemplateComponent[]
    expect(buildSendComponents(minusculo, { headerMediaUrl: 'https://cdn.test/x.png' })).toEqual([
      { type: 'header', parameters: [{ type: 'image', image: { link: 'https://cdn.test/x.png' } }] },
    ])
  })

  it('recusa componentes malformados (não-array vindo do jsonb)', () => {
    expect(() => buildSendComponents(null as unknown as MetaTemplateComponent[])).toThrow(
      TemplateBuildError,
    )
    expect(() => buildSendComponents({} as unknown as MetaTemplateComponent[])).toThrow(
      /must be an array/,
    )
  })

  it('recusa header de mídia sem link/id — a Meta não manda example.header_url de verdade', () => {
    expect(() => buildSendComponents(REAIS.image_cta)).toThrow(TemplateBuildError)
    // Com o link informado, monta normalmente.
    const out = buildSendComponents(REAIS.image_cta, {
      headerMediaUrl: 'https://cdn.example.test/foto.jpg',
    })
    expect(out[0]).toEqual({
      type: 'header',
      parameters: [{ type: 'image', image: { link: 'https://cdn.example.test/foto.jpg' } }],
    })
  })

  it('recusa corpo com variáveis quando nenhum valor é passado', () => {
    // Este é o caso que quebraria 100% das campanhas hoje: `variaveis_padrao` nunca é
    // preenchido pela UI, então todo destinatário nasce com `variaveis = {}`.
    expect(() => buildSendComponents(REAIS.order_confirmation)).toThrow(
      /Body has 3 variable\(s\) but only 0 value\(s\)/,
    )
  })

  /**
   * `params` também vem do jsonb (`payload.messageParams`), e o único portão até aqui é o
   * `isRecord` do adapter — que ACEITA array e não olha uma única chave. Forma errada
   * precisa virar TemplateBuildError (permanente) e não TypeError: um TypeError não tem
   * `httpStatus`, cai em `unknown_error_default_retryable` e ressuscita o exato cenário que
   * o 422 foi criado para matar — 5 tentativas com backoff de até 6h POR destinatário.
   */
  it.each([
    { caso: 'string com length igual ao nº de variáveis', body: 'Ana' as unknown },
    { caso: 'número', body: 42 as unknown },
    { caso: 'objeto', body: {} as unknown },
  ])('recusa messageParams.body $caso como PERMANENTE, não como TypeError', ({ body }) => {
    const chamar = () =>
      buildSendComponents(REAIS.order_confirmation, { body } as { body?: string[] })
    expect(chamar).toThrow(TemplateBuildError)
    expect(chamar).toThrow(/must be an array of strings/)
  })

  it('recusa item não-string no body — String(null) entregaria a palavra "null" ao cliente', () => {
    expect(() =>
      buildSendComponents(REAIS.order_confirmation, {
        body: ['Ana', null, '10h'] as unknown as string[],
      }),
    ).toThrow(/body\[1\] must be a string/)
  })

  it('recusa buttonParams que não seja objeto indexado por posição', () => {
    expect(() =>
      buildSendComponents(REAIS.order_confirmation, {
        body: ['a', 'b', 'c'],
        buttonParams: ['promo'] as unknown as Record<number, string>,
      }),
    ).toThrow(/buttonParams must be an object/)
  })
})

describe('TemplateBuildError é classificado como PERMANENTE pela fila', () => {
  /**
   * Esta é a asserção que dá sentido a todas as outras. Sem `httpStatus`, um `Error`
   * pelado cai no último `return` de `classifyMetaError` — `unknown_error_default_retryable`
   * — e o job é retentado 5 vezes com backoff de até 6h. Com 500 destinatários isso são
   * 2.500 ciclos de worker ao longo de horas para um defeito que é determinístico.
   */
  const casos: Array<[string, () => unknown]> = [
    ['carrossel', () => buildSendComponents(REAIS.media_carousel)],
    ['header de mídia sem link', () => buildSendComponents(REAIS.image_cta)],
    ['corpo sem valores', () => buildSendComponents(REAIS.order_confirmation)],
  ]

  for (const [nome, acao] of casos) {
    it(`${nome} vira http_422 permanente, não retentativa`, () => {
      let capturado: unknown
      try {
        acao()
      } catch (err) {
        capturado = err
      }

      expect(capturado).toBeInstanceOf(TemplateBuildError)
      // O worker normaliza o erro lendo estas propriedades de qualquer objeto lançado.
      const e = capturado as { httpStatus?: number; message?: string }
      expect(e.httpStatus).toBe(422)
      expect(typeof e.message).toBe('string')

      const veredito = classifyMetaError({ httpStatus: e.httpStatus, message: e.message })
      expect(veredito.errorClass).toBe('permanent')
      expect(veredito.reason).toBe('http_422')
    })
  }

  it('REGRESSAO: um Error pelado seria retentado — é o que estes throws eram antes', () => {
    // Guarda de sentido: se alguém trocar TemplateBuildError por Error de novo, o teste
    // acima quebra e este explica por quê.
    const veredito = classifyMetaError({ message: 'Body has 3 variable(s) but only 0 value(s)' })
    expect(veredito.errorClass).toBe('retryable')
    expect(veredito.reason).toBe('unknown_error_default_retryable')
  })
})
