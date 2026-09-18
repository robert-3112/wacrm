import type { SupabaseClient } from '@supabase/supabase-js';
import { loadOverviewCounts, type OverviewCounts } from './overview-data';

type Count = number | null;

export interface ManagementOverview {
  channels: { total: Count; active: Count };
  campaigns: { awaitingApproval: Count; inProgress: Count; paused: Count };
  outbox: {
    pending: Count;
    processing: Count;
    failed: Count;
    dead: Count;
    simulated: Count;
  };
}

export interface OperationalOverview {
  counts: OverviewCounts;
  management: ManagementOverview | null;
}

const MANAGEMENT_ROLES = new Set(['owner', 'admin', 'gestor', 'lider']);

/** A count never returns rows. Null means unavailable, not an empty queue. */
async function countRows(
  client: SupabaseClient,
  table: 'whatsapp_channels' | 'whatsapp_broadcasts' | 'whatsapp_outbox',
  tenantId: string,
  status?: string | string[]
): Promise<Count> {
  let query = client
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);
  if (Array.isArray(status)) query = query.in('status', status);
  else if (status) query = query.eq('status', status);

  const { count, error } = await query;
  if (error || typeof count !== 'number') {
    console.error(
      `[whatsapp-oficial/overview] ${table} count unavailable:`,
      error?.message ?? 'null count'
    );
    return null;
  }
  return count;
}

/**
 * Operations summary for the authenticated session. The session RPCs resolve
 * the current tenant and the role IN that tenant before the service client is
 * even created. User-visible tables use their RLS policies; the outbox has no
 * SELECT policy, so management gets only exact head counts with an explicit
 * tenant filter. No payload, phone, contact or message content crosses here.
 */
export async function loadOperationalOverview(
  userClient: SupabaseClient,
  adminClient: () => SupabaseClient
): Promise<OperationalOverview> {
  const [tenantResult, roleResult] = await Promise.all([
    userClient.rpc('os_current_tenant_id'),
    userClient.rpc('current_user_role'),
  ]);
  const tenantId =
    typeof tenantResult.data === 'string' ? tenantResult.data.trim() : '';
  if (tenantResult.error || !tenantId) {
    throw new Error('Não foi possível confirmar o tenant da sessão');
  }
  if (roleResult.error || typeof roleResult.data !== 'string') {
    throw new Error('Não foi possível confirmar o papel da sessão');
  }

  const counts = await loadOverviewCounts(userClient, tenantId);
  if (!MANAGEMENT_ROLES.has(roleResult.data)) {
    return { counts, management: null };
  }

  const [awaitingApproval, inProgress, paused, total, active] =
    await Promise.all([
      countRows(
        userClient,
        'whatsapp_broadcasts',
        tenantId,
        'aguardando_aprovacao'
      ),
      countRows(userClient, 'whatsapp_broadcasts', tenantId, [
        'aprovado',
        'enviando',
      ]),
      countRows(userClient, 'whatsapp_broadcasts', tenantId, 'pausado'),
      countRows(userClient, 'whatsapp_channels', tenantId),
      countRows(userClient, 'whatsapp_channels', tenantId, 'ativo'),
    ]);

  let pending: Count = null;
  let processing: Count = null;
  let failed: Count = null;
  let dead: Count = null;
  let simulated: Count = null;
  try {
    const admin = adminClient();
    [pending, processing, failed, dead, simulated] = await Promise.all([
      countRows(admin, 'whatsapp_outbox', tenantId, 'pendente'),
      countRows(admin, 'whatsapp_outbox', tenantId, 'processando'),
      countRows(admin, 'whatsapp_outbox', tenantId, 'falhou'),
      countRows(admin, 'whatsapp_outbox', tenantId, 'morto'),
      countRows(admin, 'whatsapp_outbox', tenantId, 'simulado'),
    ]);
  } catch (error) {
    console.error(
      '[whatsapp-oficial/overview] outbox count unavailable:',
      error instanceof Error ? error.message : error
    );
  }

  return {
    counts,
    management: {
      campaigns: { awaitingApproval, inProgress, paused },
      channels: { total, active },
      outbox: { pending, processing, failed, dead, simulated },
    },
  };
}
