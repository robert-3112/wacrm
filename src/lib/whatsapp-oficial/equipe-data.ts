import type { SupabaseClient } from '@supabase/supabase-js';

export const EQUIPE_PAGE_SIZE = 20;

export type EquipeFiltro = 'todos' | 'ativos' | 'inativos';

export type EquipeQuery = { filtro: EquipeFiltro; page: number };

export type EquipeMembro = {
  id: string;
  nome: string;
  ativo: boolean | null;
  papel: 'gestor' | 'corretor' | 'outro';
  emPlantao: boolean;
  contaVinculada: boolean;
  proprio: boolean;
  carteira: number | null;
  podeVerCarteira: boolean;
};

type CorretorRow = {
  id: string;
  nome: string;
  ativo: boolean | null;
  papel: string;
  em_plantao: boolean;
  user_id: string | null;
};

type EquipeResultado = {
  membros: EquipeMembro[];
  total: number;
  erro: string | null;
};

export function parseEquipeQuery(
  params: Record<string, string | string[] | undefined>
): EquipeQuery {
  const rawFiltro = Array.isArray(params.filtro)
    ? params.filtro[0]
    : params.filtro;
  const rawPage = Array.isArray(params.page) ? params.page[0] : params.page;
  const filtro: EquipeFiltro =
    rawFiltro === 'ativos' || rawFiltro === 'inativos' ? rawFiltro : 'todos';
  const page =
    rawPage &&
    /^\d+$/.test(rawPage) &&
    Number(rawPage) >= 1 &&
    Number(rawPage) <= 10_000
      ? Number(rawPage)
      : 1;
  return { filtro, page };
}

/**
 * Lê somente `corretores` do tenant visível pela RLS. `app_roles` não permite
 * ver o papel de acesso de terceiros, então `papel` é mostrado apenas como
 * função operacional, nunca como autorização do WhatsHub.
 */
export async function fetchEquipe(
  supabase: SupabaseClient,
  actorUserId: string,
  query: EquipeQuery
): Promise<EquipeResultado> {
  let request = supabase
    .from('corretores')
    .select('id,nome,ativo,papel,em_plantao,user_id', { count: 'exact' });
  if (query.filtro !== 'todos')
    request = request.eq('ativo', query.filtro === 'ativos');

  const from = (query.page - 1) * EQUIPE_PAGE_SIZE;
  const { data, count, error } = await request
    .order('nome', { ascending: true })
    .order('id', { ascending: true })
    .range(from, from + EQUIPE_PAGE_SIZE - 1);

  if (error || count === null) {
    console.error(
      '[whatsapp-oficial/equipe] failed to list brokers:',
      error?.message ?? 'missing count'
    );
    return {
      membros: [],
      total: 0,
      erro: 'Não foi possível carregar a equipe.',
    };
  }

  const rows = (data ?? []) as CorretorRow[];
  const { data: isGestao, error: gestaoError } =
    await supabase.rpc('crm_is_gestao');
  // An RPC failure cannot authorize broader lead reads; the user's own
  // carteira remains readable under `leads_os_select`.
  if (gestaoError)
    console.error(
      '[whatsapp-oficial/equipe] management role unavailable:',
      gestaoError.message
    );
  const podeVerTodas = !gestaoError && isGestao === true;

  const membros: EquipeMembro[] = rows.map((row) => ({
    id: row.id,
    nome: row.nome.trim() || 'Sem nome',
    ativo: row.ativo === true ? true : row.ativo === false ? false : null,
    papel:
      row.papel === 'gestor' || row.papel === 'corretor' ? row.papel : 'outro',
    emPlantao: row.em_plantao === true,
    contaVinculada: Boolean(row.user_id),
    proprio: row.user_id === actorUserId,
    carteira: null,
    podeVerCarteira: podeVerTodas || row.user_id === actorUserId,
  }));

  await Promise.all(
    membros.map(async (membro) => {
      if (!membro.podeVerCarteira) return;
      const { count: carteira, error: carteiraError } = await supabase
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .eq('corretor_id', membro.id);
      if (carteiraError || carteira === null) {
        console.error(
          '[whatsapp-oficial/equipe] failed to count assigned leads:',
          carteiraError?.message ?? 'missing count'
        );
        return;
      }
      membro.carteira = carteira;
    })
  );

  return { membros, total: count, erro: null };
}
