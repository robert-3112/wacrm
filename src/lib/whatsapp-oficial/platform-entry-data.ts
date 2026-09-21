import type { SupabaseClient } from '@supabase/supabase-js';
import type { TravasSaida } from '@/types/whatsapp-oficial';
import {
  loadOperationalScope,
  type OperationalScope,
} from './operations-overview';
import { fetchTravasSaida } from './gestao-server';

export interface SophiaEntry {
  counts: { enabled: number | null; disabled: number | null };
}

export interface SettingsEntry {
  scope: OperationalScope;
  travas: TravasSaida | null;
}

export async function loadSophiaEntry(
  client: SupabaseClient
): Promise<SophiaEntry> {
  const { tenantId } = await loadOperationalScope(client);
  const countState = async (enabled: boolean): Promise<number | null> => {
    try {
      const { count, error } = await client
        .from('whatsapp_conversations')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .in('status', ['aberta', 'pendente'])
        .eq('sophia_ativa', enabled);
      if (
        error ||
        typeof count !== 'number' ||
        !Number.isInteger(count) ||
        count < 0
      )
        return null;
      return count;
    } catch {
      return null;
    }
  };
  const [enabled, disabled] = await Promise.all([
    countState(true),
    countState(false),
  ]);
  return { counts: { enabled, disabled } };
}

export async function loadSettingsEntry(
  client: SupabaseClient
): Promise<SettingsEntry> {
  const scope = await loadOperationalScope(client);
  if (!scope.isManagement) return { scope, travas: null };
  try {
    return { scope, travas: await fetchTravasSaida(client) };
  } catch {
    return { scope, travas: null };
  }
}
