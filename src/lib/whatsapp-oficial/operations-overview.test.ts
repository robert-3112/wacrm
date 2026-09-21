import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadOperationalOverview } from './operations-overview';

type CountResult = { count: number | null; error: { message: string } | null };
type Call = {
  table: string;
  selected: string;
  options: unknown;
  filters: Record<string, string | number | string[]>;
};

function fakeClient(
  role: string | null,
  tenant: string | null,
  counts: Record<string, CountResult>
) {
  const calls: Call[] = [];
  const client = {
    auth: {
      getUser: async () => ({
        data: { user: { id: 'user-1', email: 'operador@example.invalid' } },
        error: null,
      }),
    },
    rpc(name: string) {
      if (name === 'os_current_tenant_id')
        return Promise.resolve({ data: tenant, error: null });
      if (name === 'current_user_role')
        return Promise.resolve({ data: role, error: null });
      throw new Error(`Unexpected RPC ${name}`);
    },
    from(table: string) {
      return {
        select(selected: string, options: unknown) {
          const filters: Call['filters'] = {};
          const query = {
            eq(column: string, value: string) {
              filters[column] = value;
              return query;
            },
            in(column: string, values: string[]) {
              filters[column] = values;
              return query;
            },
            gt(column: string, value: number) {
              filters[column] = `>${value}`;
              return query;
            },
            then(resolve: (result: CountResult) => unknown) {
              calls.push({ table, selected, options, filters: { ...filters } });
              const suffix = filters.status
                ? Array.isArray(filters.status)
                  ? filters.status.join(',')
                  : filters.status
                : filters.nao_lidas_corretor;
              return Promise.resolve(
                counts[`${table}:${suffix}`] ?? { count: 0, error: null }
              ).then(resolve);
            },
          };
          return query;
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const conversationCounts = {
  'whatsapp_conversations:aberta': { count: 8, error: null },
  'whatsapp_conversations:pendente': { count: 3, error: null },
  'whatsapp_conversations:>0': { count: 2, error: null },
};

describe('loadOperationalOverview', () => {
  it('rejects a missing session before resolving context or reading data', async () => {
    const user = fakeClient('owner', 'sunt', conversationCounts);
    vi.spyOn(user.client.auth, 'getUser').mockResolvedValue({
      data: { user: null },
      error: null,
    } as unknown as Awaited<ReturnType<SupabaseClient['auth']['getUser']>>);
    const rpc = vi.spyOn(user.client, 'rpc');
    const admin = vi.fn();

    await expect(
      loadOperationalOverview(user.client, admin)
    ).rejects.toMatchObject({ kind: 'unauthenticated' });
    expect(rpc).not.toHaveBeenCalled();
    expect(user.calls).toHaveLength(0);
    expect(admin).not.toHaveBeenCalled();
  });

  it('shows only the RLS-scoped tenant conversation counts to a broker and never opens admin', async () => {
    const user = fakeClient('corretor', 'sunt', conversationCounts);
    let adminOpened = false;
    const result = await loadOperationalOverview(user.client, () => {
      adminOpened = true;
      throw new Error('admin must not be opened');
    });

    expect(result).toEqual({
      counts: { abertas: 8, pendentes: 3, naoLidas: 2 },
      management: null,
    });
    expect(adminOpened).toBe(false);
    expect(user.calls).toHaveLength(3);
    expect(user.calls.every((call) => call.filters.tenant_id === 'sunt')).toBe(
      true
    );
  });

  it('rejects an unresolved tenant before reading any table or admin client', async () => {
    const user = fakeClient('owner', null, conversationCounts);
    let adminOpened = false;
    await expect(
      loadOperationalOverview(user.client, () => {
        adminOpened = true;
        throw new Error('admin must not be opened');
      })
    ).rejects.toThrow('tenant');
    expect(user.calls).toHaveLength(0);
    expect(adminOpened).toBe(false);
  });

  it('does not open admin when the tenant or role is blank', async () => {
    for (const [role, tenant] of [
      ['owner', '   '],
      [null, 'sunt'],
      ['   ', 'sunt'],
    ] as const) {
      const user = fakeClient(role, tenant, conversationCounts);
      let adminOpened = false;
      await expect(
        loadOperationalOverview(user.client, () => {
          adminOpened = true;
          throw new Error('admin must not be opened');
        })
      ).rejects.toThrow();
      expect(user.calls).toHaveLength(0);
      expect(adminOpened).toBe(false);
    }
  });

  it('counts management work per tenant without selecting payload, phone or message rows', async () => {
    const user = fakeClient('gestor', 'sunt', {
      ...conversationCounts,
      'whatsapp_broadcasts:aguardando_aprovacao': { count: 4, error: null },
      'whatsapp_broadcasts:aprovado,enviando': { count: 2, error: null },
      'whatsapp_broadcasts:pausado': { count: 1, error: null },
      'whatsapp_channels:ativo': { count: 2, error: null },
      'whatsapp_channels:undefined': { count: 3, error: null },
    });
    const admin = fakeClient('owner', 'sunt', {
      'whatsapp_outbox:pendente': { count: 9, error: null },
      'whatsapp_outbox:processando': { count: 1, error: null },
      'whatsapp_outbox:falhou': { count: 2, error: null },
      'whatsapp_outbox:morto': { count: 3, error: null },
      'whatsapp_outbox:simulado': { count: 5, error: null },
    });

    const result = await loadOperationalOverview(
      user.client,
      () => admin.client
    );

    expect(result.management).toEqual({
      campaigns: { awaitingApproval: 4, inProgress: 2, paused: 1 },
      channels: { total: 3, active: 2 },
      outbox: { pending: 9, processing: 1, failed: 2, dead: 3, simulated: 5 },
    });
    for (const call of [...user.calls, ...admin.calls]) {
      expect(call.selected).toBe('id');
      expect(call.options).toEqual({ count: 'exact', head: true });
      expect(call.filters.tenant_id).toBe('sunt');
    }
    expect(admin.calls.every((call) => call.table === 'whatsapp_outbox')).toBe(
      true
    );
  });

  it('marks a failed queue count unavailable instead of reporting zero', async () => {
    const user = fakeClient('owner', 'sunt', conversationCounts);
    const admin = fakeClient('owner', 'sunt', {
      'whatsapp_outbox:pendente': {
        count: null,
        error: { message: 'offline' },
      },
    });
    const result = await loadOperationalOverview(
      user.client,
      () => admin.client
    );
    expect(result.management?.outbox.pending).toBeNull();
    expect(result.management?.outbox.failed).toBe(0);
  });
});
