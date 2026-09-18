import { describe, expect, it } from 'vitest'
import { parseTextTemplateInput, textTemplatePayload } from './template-create'

const canalId = '8fa74ac1-a9bd-47c9-a682-560804953dd7'

describe('submissão de template de texto', () => {
  it('constrói o payload oficial com exemplos por posição', () => {
    const input = parseTextTemplateInput({ canalId, name: 'oferta_sunt', category: 'MARKETING',
      body: 'Olá {{1}}, conheça {{2}}.', examples: ['Robert', 'Tropicale'], footer: 'SUNT' })
    expect(textTemplatePayload(input)).toEqual({ name: 'oferta_sunt', language: 'pt_BR',
      category: 'MARKETING', components: [
        { type: 'BODY', text: 'Olá {{1}}, conheça {{2}}.', example: { body_text: [['Robert', 'Tropicale']] } },
        { type: 'FOOTER', text: 'SUNT' },
      ] })
  })

  it('recusa lacunas de variáveis e exemplos ausentes antes de chamar a Meta', () => {
    expect(() => parseTextTemplateInput({ canalId, name: 'teste', category: 'UTILITY',
      body: 'Olá {{2}}', examples: ['R'] })).toThrow(/sequenciais/)
    expect(() => parseTextTemplateInput({ canalId, name: 'teste', category: 'UTILITY',
      body: 'Olá {{1}}', examples: [] })).toThrow(/exemplo/)
  })

  it('recusa nome, canal e conteúdo inválidos', () => {
    const valid = { canalId, name: 'teste', category: 'MARKETING', body: 'Olá', examples: [] }
    expect(() => parseTextTemplateInput({ ...valid, canalId: 'foo' })).toThrow(/Canal/)
    expect(() => parseTextTemplateInput({ ...valid, name: 'Template Teste' })).toThrow(/nome/)
    expect(() => parseTextTemplateInput({ ...valid, body: ' ' })).toThrow(/corpo/)
  })
})
