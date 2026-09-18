import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { EQUIPE_PAGE_SIZE, fetchEquipe, parseEquipeQuery } from './equipe-data';

const brokers = [
  {
    id: 'broker-a',
    nome: 'Ana',
    ativo: true,
    papel: 'gestor',
    em_plantao: true,
    user_id: 'user-a',
  },
  {
    id: 'broker-b',
    nome: 'Bruno',
    ativo: false,
    papel: 'corretor',
    em_plantao: false,
    user_id: 'user-b',
  },
];

function makeSupabase({
  gestao = false,
  gestaoError = false,
  listError = false,
  countError = false,
  rows = brokers,
}: {
  gestao?: boolean;
  gestaoError?: boolean;
  listError?: boolean;
  countError?: boolean;
  rows?: Array<
    | (typeof brokers)[number]
    | (Omit<(typeof brokers)[number], 'ativo' | 'papel'> & {
        ativo: null;
        papel: string;
      })
  >;
} = {}) {
  const filters: Array<[string, unknown]> = [];
  const ranges: Array<[number, number]> = [];
  const countedBrokers: string[] = [];
  const listQuery = {
    eq: vi.fn((field: string, value: unknown) => {
      filters.push([field, value]);
      return listQuery;
    }),
    order: vi.fn(() => listQuery),
    range: vi.fn(async (from: number, to: number) => {
      ranges.push([from, to]);
      return listError
        ? { data: null, count: null, error: { message: 'db failed' } }
        : { data: rows, count: rows.length, error: null };
    }),
  };
  const supabase = {
    from: vi.fn((table: string) => {
      if (table === 'corretores') return { select: vi.fn(() => listQuery) };
      if (table === 'leads')
        return {
          select: vi.fn(() => ({
            eq: vi.fn(async (_field: string, id: string) => {
              countedBrokers.push(id);
              return countError
                ? { count: null, error: { message: 'count failed' } }
                : { count: id === 'broker-a' ? 2 : 0, error: null };
            }),
          })),
        };
      throw new Error(`Unexpected table ${table}`);
    }),
    rpc: vi.fn(async () =>
      gestaoError
        ? { data: null, error: { message: 'role unavailable' } }
        : { data: gestao, error: null }
    ),
  };
  return {
    supabase: supabase as unknown as SupabaseClient,
    filters,
    ranges,
    countedBrokers,
  };
}

describe('parseEquipeQuery', () => {
  it('aceita somente filtros e páginas conhecidos', () => {
    expect(parseEquipeQuery({ filtro: 'inativos', page: '2' })).toEqual({
      filtro: 'inativos',
      page: 2,
    });
    expect(parseEquipeQuery({ filtro: 'qualquer', page: '-1' })).toEqual({
      filtro: 'todos',
      page: 1,
    });
    expect(parseEquipeQuery({ filtro: 'ativos', page: '10001' })).toEqual({
      filtro: 'ativos',
      page: 1,
    });
  });
});

describe('fetchEquipe', () => {
  it('respeita paginação/filtro e mostra status e função do cadastro', async () => {
    const db = makeSupabase();
    const result = await fetchEquipe(db.supabase, 'user-a', {
      filtro: 'inativos',
      page: 2,
    });
    expect(db.filters).toEqual([['ativo', false]]);
    expect(db.ranges).toEqual([[EQUIPE_PAGE_SIZE, EQUIPE_PAGE_SIZE * 2 - 1]]);
    expect(result.membros[0]).toMatchObject({
      nome: 'Ana',
      ativo: true,
      papel: 'gestor',
      emPlantao: true,
      contaVinculada: true,
      proprio: true,
    });
    expect(result.membros[1]).toMatchObject({
      nome: 'Bruno',
      ativo: false,
      papel: 'corretor',
      emPlantao: false,
      contaVinculada: true,
      proprio: false,
    });
  });

  it('não consulta nem revela a carteira de outro corretor para um membro comum', async () => {
    const db = makeSupabase();
    const result = await fetchEquipe(db.supabase, 'user-a', {
      filtro: 'todos',
      page: 1,
    });
    expect(db.countedBrokers).toEqual(['broker-a']);
    expect(
      result.membros.map((member) => [member.podeVerCarteira, member.carteira])
    ).toEqual([
      [true, 2],
      [false, null],
    ]);
  });

  it('não transforma situação nula nem uma função desconhecida em cadastro inativo/corretor', async () => {
    const db = makeSupabase({
      rows: [{ ...brokers[0], ativo: null, papel: 'outro' }],
    });
    const result = await fetchEquipe(db.supabase, 'user-a', {
      filtro: 'todos',
      page: 1,
    });
    expect(result.membros[0]).toMatchObject({ ativo: null, papel: 'outro' });
  });

  it('mostra contagens exatas para a gestão, inclusive uma carteira vazia', async () => {
    const db = makeSupabase({ gestao: true });
    const result = await fetchEquipe(db.supabase, 'user-a', {
      filtro: 'todos',
      page: 1,
    });
    expect(db.countedBrokers).toEqual(['broker-a', 'broker-b']);
    expect(result.membros.map((member) => member.carteira)).toEqual([2, 0]);
  });

  it('falha fechado quando o papel de gestão não pode ser confirmado', async () => {
    const db = makeSupabase({ gestaoError: true });
    const result = await fetchEquipe(db.supabase, 'user-a', {
      filtro: 'todos',
      page: 1,
    });
    expect(db.countedBrokers).toEqual(['broker-a']);
    expect(result.membros[1].podeVerCarteira).toBe(false);
  });

  it('distingue falha de contagem de carteira vazia e falha de lista', async () => {
    const countDb = makeSupabase({ countError: true });
    const countResult = await fetchEquipe(countDb.supabase, 'user-a', {
      filtro: 'todos',
      page: 1,
    });
    expect(countResult.membros[0].carteira).toBeNull();
    const listDb = makeSupabase({ listError: true });
    const listResult = await fetchEquipe(listDb.supabase, 'user-a', {
      filtro: 'todos',
      page: 1,
    });
    expect(listResult).toEqual({
      membros: [],
      total: 0,
      erro: 'Não foi possível carregar a equipe.',
    });
    expect(listDb.countedBrokers).toEqual([]);
  });
});
