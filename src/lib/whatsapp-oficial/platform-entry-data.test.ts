import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchTravasSaida } from './gestao-server';
import { loadSettingsEntry, loadSophiaEntry } from './platform-entry-data';

vi.mock('./gestao-server', () => ({ fetchTravasSaida: vi.fn() }));

type CountResult = {
  count: number | null;
  error: { message: string; code?: string } | null;
};

function client({
  role = 'corretor',
  tenant = 'tenant-1',
  authenticated = true,
  rpcError = false,
  enabled = { count: 3, error: null },
  disabled = { count: 0, error: null },
  throws = false,
}: {
  role?: string | null;
  tenant?: string | null;
  authenticated?: boolean;
  rpcError?: boolean;
  enabled?: CountResult;
  disabled?: CountResult;
  throws?: boolean;
} = {}) {
  const reads: Array<Record<string, unknown>> = [];
  const value = {
    auth: {
      getUser: async () => ({
        data: {
          user: authenticated
            ? { id: 'u1', email: 'user@example.invalid' }
            : null,
        },
        error: null,
      }),
    },
    rpc: vi.fn(async (name: string) => ({
      data: name === 'os_current_tenant_id' ? tenant : role,
      error: rpcError ? { message: 'RPC unavailable' } : null,
    })),
    from(table: string) {
      const filters: Record<string, unknown> = { table };
      const q = {
        select(columns: string, options: unknown) {
          Object.assign(filters, { columns, options });
          return q;
        },
        eq(key: string, value: unknown) {
          filters[key] = value;
          return q;
        },
        in(key: string, value: unknown) {
          filters[key] = value;
          return q;
        },
        then(
          resolve: (r: CountResult) => unknown,
          reject: (error: Error) => unknown
        ) {
          reads.push({ ...filters });
          return (
            throws
              ? Promise.reject(new Error('offline'))
              : Promise.resolve(filters.sophia_ativa ? enabled : disabled)
          ).then(resolve, reject);
        },
      };
      return q;
    },
  } as unknown as SupabaseClient;
  return { value, reads };
}

describe('platform entry data', () => {
  it('counts visible open/pending conversations per tenant, selecting no content', async () => {
    const c = client();
    expect((await loadSophiaEntry(c.value)).counts).toEqual({
      enabled: 3,
      disabled: 0,
    });
    expect(c.reads).toHaveLength(2);
    expect(c.reads.map((r) => r.sophia_ativa)).toEqual([true, false]);
    for (const r of c.reads) {
      expect(r).toEqual({
        table: 'whatsapp_conversations',
        columns: 'id',
        options: { count: 'exact', head: true },
        tenant_id: 'tenant-1',
        status: ['aberta', 'pendente'],
        sophia_ativa: r.sophia_ativa,
      });
    }
  });

  it('does not turn a missing column into zero', async () => {
    const missing = {
      count: null,
      error: { code: '42703', message: 'column unavailable' },
    };
    expect(
      (
        await loadSophiaEntry(
          client({ enabled: missing, disabled: missing }).value
        )
      ).counts
    ).toEqual({ enabled: null, disabled: null });
  });

  it.each([null, -1, 0.5, NaN, Infinity])(
    'keeps an invalid count %s unavailable without losing the other count',
    async (count) => {
      expect(
        (
          await loadSophiaEntry(
            client({ enabled: { count, error: null } }).value
          )
        ).counts
      ).toEqual({ enabled: null, disabled: 0 });
    }
  );

  it('does not trust a count accompanied by an error', async () => {
    expect(
      (
        await loadSophiaEntry(
          client({ enabled: { count: 4, error: { message: 'unavailable' } } })
            .value
        )
      ).counts
    ).toEqual({ enabled: null, disabled: 0 });
  });

  it('keeps network failures unavailable', async () => {
    expect(
      (await loadSophiaEntry(client({ throws: true }).value)).counts
    ).toEqual({ enabled: null, disabled: null });
  });

  it.each(['corretor', 'viewer', 'unrecognized'])(
    'does not read controls for role %s',
    async (role) => {
      const c = client({ role });
      const result = await loadSettingsEntry(c.value);
      expect(result.travas).toBeNull();
      expect(result.scope.isManagement).toBe(false);
      expect(fetchTravasSaida).not.toHaveBeenCalled();
      expect(c.reads).toHaveLength(0);
    }
  );

  it.each([
    { tenant: null },
    { tenant: '   ' },
    { role: null },
    { role: '   ' },
    { rpcError: true },
    { authenticated: false },
  ])(
    'fails closed before either page reads data when scope is invalid: %j',
    async (options) => {
      const c = client(options);
      await expect(loadSophiaEntry(c.value)).rejects.toThrow();
      await expect(loadSettingsEntry(c.value)).rejects.toThrow();
      expect(c.reads).toHaveLength(0);
      expect(fetchTravasSaida).not.toHaveBeenCalled();
      if (options.authenticated === false)
        expect(c.value.rpc).not.toHaveBeenCalled();
    }
  );

  it('preserves unavailable settings when the controls reader fails', async () => {
    vi.mocked(fetchTravasSaida).mockRejectedValueOnce(new Error('unavailable'));
    const c = client({ role: 'gestor' });
    const result = await loadSettingsEntry(c.value);
    expect(result.scope.isManagement).toBe(true);
    expect(result.travas).toBeNull();
    expect(fetchTravasSaida).toHaveBeenCalledWith(c.value);
  });

  it.each(['owner', 'admin', 'gestor', 'lider'])(
    'preserves an unknown database switch for %s',
    async (role) => {
      vi.mocked(fetchTravasSaida).mockResolvedValueOnce({
        modo: 'shadow',
        broadcastEnvLigado: false,
        broadcastBancoLigado: null,
        envioMetaLigado: false,
        envioEvolutionLigado: false,
        pilotoLigado: true,
      });
      const c = client({ role });
      const result = await loadSettingsEntry(c.value);
      expect(result.travas?.broadcastBancoLigado).toBeNull();
      expect(result.scope.userEmail).toBe('user@example.invalid');
      expect(fetchTravasSaida).toHaveBeenCalledTimes(1);
      expect(fetchTravasSaida).toHaveBeenCalledWith(c.value);
    }
  );
});
