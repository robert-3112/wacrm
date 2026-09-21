import { extractVariableIndices } from './meta-templates'

export interface TextTemplateInput {
  canalId: string
  name: string
  category: 'MARKETING' | 'UTILITY'
  body: string
  footer?: string
  examples: string[]
}

export function parseTextTemplateInput(value: unknown): TextTemplateInput {
  if (!value || typeof value !== 'object') throw new Error('Dados do template inválidos.')
  const input = value as Record<string, unknown>
  const canalId = typeof input.canalId === 'string' ? input.canalId.trim() : ''
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const body = typeof input.body === 'string' ? input.body.trim() : ''
  const footer = typeof input.footer === 'string' ? input.footer.trim() : ''
  const examples = input.examples

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(canalId)) {
    throw new Error('Canal inválido.')
  }
  if (!/^[a-z][a-z0-9_]{0,127}$/.test(name)) {
    throw new Error('Use um nome com letras minúsculas, números e sublinhado.')
  }
  if (input.category !== 'MARKETING' && input.category !== 'UTILITY') {
    throw new Error('Selecione a categoria do template.')
  }
  if (!body || body.length > 1024) throw new Error('O corpo deve ter de 1 a 1024 caracteres.')
  if (footer.length > 60) throw new Error('O rodapé deve ter até 60 caracteres.')

  const indices = extractVariableIndices(body)
  if (indices.length > 10 || indices.some((index, position) => index !== position + 1)) {
    throw new Error('Use até 10 variáveis sequenciais, começando em {{1}}.')
  }
  if (!Array.isArray(examples) || examples.length !== indices.length
      || examples.some((example) => typeof example !== 'string'
        || !example.trim() || example.length > 128)) {
    throw new Error('Informe um exemplo de até 128 caracteres para cada variável.')
  }

  return {
    canalId, name, category: input.category, body, footer: footer || undefined,
    examples: examples.map((example: string) => example.trim()),
  }
}

export function textTemplatePayload(input: TextTemplateInput) {
  const components: Record<string, unknown>[] = [{
    type: 'BODY',
    text: input.body,
    ...(input.examples.length ? { example: { body_text: [input.examples] } } : {}),
  }]
  if (input.footer) components.push({ type: 'FOOTER', text: input.footer })
  return { name: input.name, language: 'pt_BR', category: input.category, components }
}
