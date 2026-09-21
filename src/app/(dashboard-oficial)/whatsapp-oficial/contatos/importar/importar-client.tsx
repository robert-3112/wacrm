'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createClient } from '@/lib/supabase/client'
import { parseLeadCsv, type ImportLead } from '@/lib/whatsapp-oficial/import-csv'

type Resultado = {
  ok?: boolean
  reason?: string
  batch_id?: string
  total?: number
  inserted?: number
  duplicates?: number
  invalid?: number
  unmapped_owner?: number
}

type ErroLinha = { row_number: number; code: string; detail: string | null }

const MOTIVOS: Record<string, string> = {
  sem_permissao: 'Sua conta não pode importar contatos.',
  rows_deve_ser_array: 'O arquivo não pôde ser interpretado.',
  lote_deve_ter_1_a_500_linhas: 'O arquivo deve conter entre 1 e 500 contatos.',
  arquivo_obrigatorio: 'Selecione um arquivo CSV.',
}

export function ImportarContatosClient() {
  const [filename, setFilename] = useState('')
  const [rows, setRows] = useState<ImportLead[]>([])
  const [validation, setValidation] = useState<Resultado | null>(null)
  const [imported, setImported] = useState<Resultado | null>(null)
  const [rowErrors, setRowErrors] = useState<ErroLinha[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function selectFile(file: File | undefined) {
    setRows([])
    setFilename('')
    setValidation(null)
    setImported(null)
    setRowErrors([])
    setError(null)
    if (!file) return
    if (file.size > 2_000_000) { setError('O arquivo excede 2 MB.'); return }
    try {
      const parsed = parseLeadCsv(await file.text())
      setRows(parsed)
      setFilename(file.name)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível ler o CSV.')
    }
  }

  async function validate() {
    if (!rows.length || !filename) return
    setBusy(true)
    setError(null)
    setRowErrors([])
    setValidation(null)
    try {
      const client = createClient()
      const { data, error: rpcError } = await client.rpc('gestao_importar_leads', {
        p_rows: rows, p_filename: filename, p_dry_run: true,
      })
      if (rpcError) throw new Error('A validação falhou. Tente novamente.')
      const result = data as Resultado
      if (!result?.ok) throw new Error(MOTIVOS[result?.reason ?? ''] ?? 'O lote foi recusado pelo CRM.')
      if (!result.batch_id) throw new Error('O CRM não devolveu o identificador do lote.')
      setValidation(result)
      const { data: errors, error: readError } = await client.from('crm_import_errors')
        .select('row_number,code,detail')
        .eq('batch_id', result.batch_id)
        .order('row_number', { ascending: true })
        .limit(100)
      if (readError) setError('Validação concluída, mas não foi possível carregar os erros por linha.')
      else setRowErrors((errors ?? []) as ErroLinha[])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível validar o arquivo.')
    } finally {
      setBusy(false)
    }
  }

  async function importRows() {
    if (!validation?.ok || !rows.length || !filename || imported ||
        validation.invalid || validation.unmapped_owner || !validation.inserted) return
    setBusy(true)
    setError(null)
    try {
      // Um lote novo mantém a contagem do dry-run separada da importação real.
      const { data, error: rpcError } = await createClient().rpc('gestao_importar_leads', {
        p_rows: rows, p_filename: filename, p_dry_run: false,
      })
      if (rpcError) throw new Error('O resultado da importação é incerto. Confira a lista de contatos antes de repetir.')
      const result = data as Resultado
      if (!result?.ok) throw new Error(MOTIVOS[result?.reason ?? ''] ?? 'O CRM recusou a importação.')
      setImported(result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível confirmar a importação.')
    } finally {
      setBusy(false)
    }
  }

  const ready = validation?.ok && !validation.invalid && !validation.unmapped_owner &&
    Boolean(validation.inserted) && !imported

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-6 lg:py-8">
        <Link href="/whatsapp-oficial/contatos" className="text-primary inline-flex items-center gap-2 text-sm hover:underline">
          <ArrowLeft className="size-4" aria-hidden="true" /> Voltar aos contatos
        </Link>
        <div className="space-y-2">
          <h1 className="text-foreground text-3xl font-semibold">Importar contatos</h1>
          <p className="text-muted-foreground text-sm">
            Use um CSV de até 500 linhas com as colunas Nome e Telefone ou WhatsApp.
            A validação compara telefones com o CRM antes de gravar novos leads.
          </p>
        </div>

        <div className="border-border bg-card space-y-4 rounded-2xl border p-5 shadow-sm">
          <label htmlFor="csv-leads" className="text-foreground block text-sm font-medium">Arquivo CSV</label>
          <Input id="csv-leads" type="file" accept=".csv,text/csv" disabled={busy}
            onChange={(event) => void selectFile(event.target.files?.[0])} />
          <p className="text-muted-foreground text-xs">
            Colunas opcionais: E-mail, Responsável email, Cidade, Empreendimento slug e Origem.
            A importação não registra consentimento nem inicia mensagens.
          </p>
          {filename && <p className="text-sm">{filename}: {rows.length} contatos lidos</p>}
          <Button type="button" onClick={() => void validate()} disabled={!rows.length || busy || Boolean(imported)}>
            {busy && !validation ? 'Validando…' : 'Validar no CRM'}
          </Button>
        </div>

        {rows.length > 0 && (
          <section className="border-border bg-card overflow-hidden rounded-2xl border shadow-sm" aria-label="Prévia do CSV">
            <div className="border-border border-b px-5 py-3 text-sm font-semibold">Prévia das primeiras 10 linhas</div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/50 text-muted-foreground"><tr>
                  <th className="px-5 py-2 font-medium">Nome</th>
                  <th className="px-5 py-2 font-medium">Telefone</th>
                  <th className="px-5 py-2 font-medium">Responsável</th>
                </tr></thead>
                <tbody>{rows.slice(0, 10).map((row, index) => (
                  <tr key={index} className="border-border border-t">
                    <td className="px-5 py-2">{row.nome || '—'}</td>
                    <td className="px-5 py-2">{row.telefone || '—'}</td>
                    <td className="px-5 py-2">{row.corretor_email || 'Sem responsável'}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </section>
        )}

        {validation?.ok && (
          <section className="border-border bg-card space-y-3 rounded-2xl border p-5 shadow-sm" aria-live="polite">
            <h2 className="text-lg font-semibold">Resultado da validação</h2>
            <p className="text-sm">
              {validation.total ?? 0} linhas · {validation.inserted ?? 0} novas ·
              {' '}{validation.duplicates ?? 0} já existentes · {validation.invalid ?? 0} inválidas ·
              {' '}{validation.unmapped_owner ?? 0} responsáveis não encontrados.
            </p>
            {rowErrors.length > 0 && (
              <ul className="text-destructive space-y-1 text-sm">
                {rowErrors.map((item, index) => (
                  <li key={`${item.row_number}-${index}`}>
                    Linha {item.row_number}: {item.detail || item.code}
                  </li>
                ))}
              </ul>
            )}
            {(validation.invalid || validation.unmapped_owner) ? (
              <p className="text-sm">Corrija o arquivo e valide novamente. Nenhum contato foi importado.</p>
            ) : !validation.inserted ? (
              <p className="text-sm">Todos os contatos já constam do CRM.</p>
            ) : (
              <Button type="button" onClick={() => void importRows()} disabled={!ready || busy} className="gap-2">
                <Upload className="size-4" aria-hidden="true" />
                {busy ? 'Importando…' : 'Importar contatos validados'}
              </Button>
            )}
          </section>
        )}

        {imported?.ok && (
          <div className="border-primary/30 bg-primary/5 rounded-2xl border p-5 text-sm" role="status">
            Lote importado: {imported.inserted ?? 0} novos contatos e {imported.duplicates ?? 0} já existentes.
            <Link href="/whatsapp-oficial/contatos" className="text-primary ml-2 font-medium underline">Ver contatos</Link>
          </div>
        )}
        {error && <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-2xl border p-4 text-sm" role="alert">{error}</div>}
      </div>
    </div>
  )
}
