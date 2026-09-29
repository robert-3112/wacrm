import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PairedTextComposer } from './paired-text-composer'

describe('paired text composer', () => {
  it('keeps the linked history visible but all reply controls disabled while the gate is off', () => {
    const html = renderToStaticMarkup(<PairedTextComposer pairId="pair-1" disabled
      disabledReason="Resposta vinculada ainda desabilitada neste ambiente." envioReal={true} onQueued={() => {}} />)
    expect(html).toContain('Resposta vinculada ainda desabilitada')
    expect(html).toContain('disabled')
    expect(html).not.toContain('type="file"')
    expect(html).not.toContain('Usar template')
  })
})
