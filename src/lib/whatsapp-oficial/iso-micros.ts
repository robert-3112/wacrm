/** Canonical UTC text for comparing timestamps without losing PostgreSQL microseconds. */
export function isoMicros(value: string): string {
  return value.replace(/(?:\.(\d{1,6}))?Z$/, (_match, fraction: string | undefined) =>
    `.${(fraction ?? '').padEnd(6, '0')}Z`)
}
