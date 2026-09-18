import type { SupabaseClient } from '@supabase/supabase-js';

export const CONTACT_PAGE_SIZE = 40;

export type ContactView = 'todos' | 'sem_corretor' | 'urgentes';

export type ContactListQuery = {
  q: string;
  page: number;
  visao: ContactView;
  buscaInvalida: boolean;
};

type QueryValue = string | string[] | undefined;

function first(value: QueryValue): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export function parseContactListQuery(
  params: Record<string, QueryValue>
): ContactListQuery {
  const q = first(params.q).trim().replace(/\s+/g, ' ').slice(0, 80).trim();
  const rawPage = first(params.page);
  const page =
    /^\d+$/.test(rawPage) && Number(rawPage) >= 1 && Number(rawPage) <= 10_000
      ? Number(rawPage)
      : 1;
  const rawView = first(params.visao);
  const visao: ContactView =
    rawView === 'sem_corretor' || rawView === 'urgentes' ? rawView : 'todos';
  return {
    q,
    page,
    visao,
    buscaInvalida: Boolean(q) && !buildContactSearchFilter(q),
  };
}

/** The `.or()` argument is raw PostgREST syntax, so never interpolate user text before this whitelist. */
export function buildContactSearchFilter(value: string): string | null {
  const name = value
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const digits = value.replace(/\D/g, '');
  const filters: string[] = [];
  if (name) {
    filters.push(`nome.ilike.%${name}%`, `name.ilike.%${name}%`);
  }
  if (digits) {
    filters.push(`whatsapp.ilike.%${digits}%`, `phone.ilike.%${digits}%`);
  }
  return filters.length ? filters.join(',') : null;
}

export type RawContactRow = {
  id: string;
  nome: string | null;
  name: string | null;
  whatsapp: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  etapa: string | null;
  temperatura: string | null;
  urgente: boolean | null;
  corretor_id: string | null;
  corretor?:
    | { id: string; nome: string | null }
    | { id: string; nome: string | null }[]
    | null;
  created_at: string;
};

export type HubContact = {
  id: string;
  nome: string;
  telefone: string | null;
  email: string | null;
  cidade: string | null;
  etapa: string | null;
  temperatura: string | null;
  urgente: boolean;
  temCorretor: boolean;
  corretorNome: string | null;
  criadoEm: string;
};

export function normalizeContactRow(row: RawContactRow): HubContact {
  const corretor = Array.isArray(row.corretor) ? row.corretor[0] : row.corretor;
  return {
    id: row.id,
    nome: row.nome?.trim() || row.name?.trim() || 'Sem nome',
    telefone: row.whatsapp?.trim() || row.phone?.trim() || null,
    email: row.email?.trim() || null,
    cidade: row.city?.trim() || null,
    etapa: row.etapa,
    temperatura: row.temperatura,
    urgente: row.urgente === true,
    temCorretor: Boolean(row.corretor_id),
    corretorNome: corretor?.nome?.trim() || null,
    criadoEm: row.created_at,
  };
}

const CONTACT_SELECT =
  'id,nome,name,whatsapp,phone,email,city,etapa,temperatura,urgente,corretor_id,created_at,corretor:corretores!leads_corretor_id_tenant_fkey_os(id,nome)';

/** Authenticated user client only. Production `leads_os_select` RLS enforces tenant and ownership. */
export async function fetchHubContacts(
  supabase: SupabaseClient,
  params: ContactListQuery
): Promise<{ contatos: HubContact[]; total: number; erro: string | null }> {
  let query = supabase.from('leads').select(CONTACT_SELECT, { count: 'exact' });
  if (params.visao === 'sem_corretor') query = query.is('corretor_id', null);
  if (params.visao === 'urgentes') query = query.eq('urgente', true);
  if (params.q) {
    const filter = buildContactSearchFilter(params.q);
    if (!filter) return { contatos: [], total: 0, erro: null };
    query = query.or(filter);
  }
  const from = (params.page - 1) * CONTACT_PAGE_SIZE;
  const { data, count, error } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, from + CONTACT_PAGE_SIZE - 1);

  if (error) return { contatos: [], total: 0, erro: error.message };
  if (count === null) {
    return {
      contatos: [],
      total: 0,
      erro: 'Contagem de contatos indisponível.',
    };
  }
  return {
    contatos: ((data ?? []) as RawContactRow[]).map(normalizeContactRow),
    total: count,
    erro: null,
  };
}
