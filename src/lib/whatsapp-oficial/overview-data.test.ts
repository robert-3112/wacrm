import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadOverviewCounts } from './overview-data';

function fakeClient(
  results: Record<string, { count: number | null; error: unknown }>
) {
  const calls: Array<{
    field: string;
    options: unknown;
    filter: string;
    tenant: string;
  }> = [];
  const client = {
    from(table: string) {
      expect(table).toBe('whatsapp_conversations');
      return {
        select(field: string, options: unknown) {
          return {
            eq(column: string, value: string) {
              expect(column).toBe('tenant_id');
              expect(value).toBe('sunt');
              return {
                eq(filterColumn: string, filterValue: string) {
                  const key = `${filterColumn}:${filterValue}`;
                  calls.push({ field, options, filter: key, tenant: value });
                  return Promise.resolve(results[key]);
                },
                gt(filterColumn: string, filterValue: number) {
                  const key = `${filterColumn}:>${filterValue}`;
                  calls.push({ field, options, filter: key, tenant: value });
                  return Promise.resolve(results[key]);
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe('loadOverviewCounts', () => {
  it('counts only rows visible through the supplied session and asks PostgREST for exact head counts', async () => {
    const { client, calls } = fakeClient({
      'status:aberta': { count: 7, error: null },
      'status:pendente': { count: 3, error: null },
      'nao_lidas_corretor:>0': { count: 2, error: null },
    });

    await expect(loadOverviewCounts(client, 'sunt')).resolves.toEqual({
      abertas: 7,
      pendentes: 3,
      naoLidas: 2,
    });
    expect(calls).toHaveLength(3);
    expect(calls).toEqual(
      expect.arrayContaining([
        {
          field: 'id',
          options: { count: 'exact', head: true },
          filter: 'status:aberta',
          tenant: 'sunt',
        },
        {
          field: 'id',
          options: { count: 'exact', head: true },
          filter: 'status:pendente',
          tenant: 'sunt',
        },
        {
          field: 'id',
          options: { count: 'exact', head: true },
          filter: 'nao_lidas_corretor:>0',
          tenant: 'sunt',
        },
      ])
    );
  });

  it('does not show zero when a metric query fails', async () => {
    const { client } = fakeClient({
      'status:aberta': { count: 7, error: null },
      'status:pendente': {
        count: null,
        error: { message: 'connection failed' },
      },
      'nao_lidas_corretor:>0': { count: 2, error: null },
    });

    await expect(loadOverviewCounts(client, 'sunt')).rejects.toThrow(
      'Não foi possível carregar os indicadores'
    );
  });

  it('treats an unavailable count as an error rather than an empty queue', async () => {
    const { client } = fakeClient({
      'status:aberta': { count: null, error: null },
      'status:pendente': { count: 3, error: null },
      'nao_lidas_corretor:>0': { count: 2, error: null },
    });

    await expect(loadOverviewCounts(client, 'sunt')).rejects.toThrow(
      'Não foi possível carregar os indicadores'
    );
  });
});
