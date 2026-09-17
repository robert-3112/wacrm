export type ImportLead = {
  nome: string
  telefone: string
  email?: string
  corretor_email?: string
  cidade?: string
  empreendimento_slug?: string
  source?: string
}

const HEADERS: Record<string, keyof ImportLead> = {
  nome: 'nome', name: 'nome', cliente: 'nome', contato: 'nome',
  telefone: 'telefone', whatsapp: 'telefone', celular: 'telefone', phone: 'telefone',
  email: 'email', e_mail: 'email',
  corretor_email: 'corretor_email', responsavel_email: 'corretor_email', owner_email: 'corretor_email',
  cidade: 'cidade', city: 'cidade',
  empreendimento_slug: 'empreendimento_slug',
  source: 'source', origem: 'source',
}

function normalizedHeader(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

function delimiterFor(text: string): ',' | ';' {
  let quoted = false
  let commas = 0
  let semicolons = 0
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (char === '"') {
      if (quoted && text[i + 1] === '"') i += 1
      else quoted = !quoted
    } else if (!quoted && (char === '\n' || char === '\r')) break
    else if (!quoted && char === ',') commas += 1
    else if (!quoted && char === ';') semicolons += 1
  }
  return semicolons > commas ? ';' : ','
}

/** CSV com aspas, quebras de linha dentro de aspas, UTF-8 BOM e ; ou , como separador. */
export function parseLeadCsv(text: string): ImportLead[] {
  if (text.length > 2_000_000) throw new Error('O arquivo excede 2 MB.')
  const input = text.replace(/^\uFEFF/, '')
  const delimiter = delimiterFor(input)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]
    if (char === '"') {
      if (quoted && input[i + 1] === '"') { field += '"'; i += 1 }
      else quoted = !quoted
    } else if (!quoted && char === delimiter) {
      row.push(field); field = ''
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && input[i + 1] === '\n') i += 1
      row.push(field); field = ''
      if (row.some((value) => value.trim())) rows.push(row)
      row = []
    } else {
      field += char
    }
  }
  if (quoted) throw new Error('CSV com aspas não fechadas.')
  row.push(field)
  if (row.some((value) => value.trim())) rows.push(row)

  const headers = rows.shift()?.map((value) => HEADERS[normalizedHeader(value)] ?? null)
  if (!headers?.includes('nome') || !headers.includes('telefone')) {
    throw new Error('O CSV precisa ter colunas Nome e Telefone (ou WhatsApp).')
  }
  if (rows.length === 0) throw new Error('O CSV não contém contatos.')
  if (rows.length > 500) throw new Error('Importe até 500 contatos por arquivo.')

  return rows.map((values) => {
    const lead: Partial<ImportLead> = {}
    headers.forEach((key, index) => {
      if (key && values[index]?.trim()) lead[key] = values[index].trim()
    })
    return { nome: lead.nome ?? '', telefone: lead.telefone ?? '',
      ...(lead.email ? { email: lead.email } : {}),
      ...(lead.corretor_email ? { corretor_email: lead.corretor_email } : {}),
      ...(lead.cidade ? { cidade: lead.cidade } : {}),
      ...(lead.empreendimento_slug ? { empreendimento_slug: lead.empreendimento_slug } : {}),
      ...(lead.source ? { source: lead.source } : {}),
    }
  })
}
