/** Allowlisted diagnostics only: RPC/provider messages and stacks can contain request data. */
export function errorDiagnostics(error: unknown): Record<string, string | number> {
  const diagnostics: Record<string, string | number> = { type: typeof error }
  if (error instanceof Error) {
    diagnostics.type = /^(Error|TypeError|SyntaxError|RangeError|AbortError|TimeoutError|MetaApiError)$/.test(error.name)
      ? error.name : 'Error'
  }
  if (!error || typeof error !== 'object') return diagnostics
  const fields = error as Record<string, unknown>
  // SQLSTATE, PostgREST and Node system codes; no arbitrary strings from an upstream error.
  if (typeof fields.code === 'string' && /^(?:[A-Z0-9]{5}|PGRST\d{3}|E[A-Z]{2,20}|ERR_[A-Z_]{1,40})$/.test(fields.code)) {
    diagnostics.code = fields.code
  }
  for (const key of ['code', 'errorSubcode', 'httpStatus']) {
    const value = fields[key]
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      diagnostics[key] = value
    }
  }
  return diagnostics
}
