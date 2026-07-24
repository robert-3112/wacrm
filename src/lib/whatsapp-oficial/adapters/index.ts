/**
 * Adapter registry — maps a `Provider` to its `OutboundAdapter`
 * implementation. WRITTEN FROM SCRATCH for the outbox worker (Fase 7).
 */

import { evolutionAdapter } from './evolution'
import { metaCloudAdapter } from './meta-cloud'
import type { OutboundAdapter, Provider } from './types'

export function getAdapter(provider: Provider): OutboundAdapter {
  switch (provider) {
    case 'meta_cloud':
      return metaCloudAdapter
    case 'evolution':
      return evolutionAdapter
    default:
      throw new Error(`getAdapter: unknown provider "${String(provider)}"`)
  }
}
