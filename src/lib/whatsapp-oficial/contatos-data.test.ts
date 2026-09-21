import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildContactSearchFilter,
  fetchHubContacts,
  normalizeContactRow,
  parseContactListQuery,
} from './contatos-data';

describe('contatos do Hub', () => {
  it('usa nome e telefone alternativos do lead legado quando os principais estão vazios', () => {
    const contact = normalizeContactRow({
      id: 'lead-1',
      nome: '  ',
      name: 'Ana',
      whatsapp: null,
      phone: '5547999990000',
      email: null,
      city: null,
      etapa: 'novo',
      temperatura: null,
      urgente: false,
      corretor_id: null,
      created_at: '2026-09-16T00:00:00Z',
    });

    expect(contact).toMatchObject({
      id: 'lead-1',
      nome: 'Ana',
      telefone: '5547999990000',
      etapa: 'novo',
      temCorretor: false,
    });
  });

  it('mostra o corretor do mesmo tenant quando a relação vem em lista', () => {
    const contact = normalizeContactRow({
      id: 'lead-2',
      nome: 'Bruna',
      name: null,
      whatsapp: '5547999991111',
      phone: null,
      email: null,
      city: null,
      etapa: null,
      temperatura: null,
      urgente: false,
      corretor_id: 'corretor-1',
      corretor: [{ id: 'corretor-1', nome: 'Equipe Norte' }],
      created_at: '2026-09-16T00:00:00Z',
    });

    expect(contact.corretorNome).toBe('Equipe Norte');
  });

  it('não permite que a busca altere a sintaxe do filtro PostgREST', () => {
    const filter = buildContactSearchFilter('Ana),status.eq.vendido');

    expect(filter).not.toContain('status.eq.vendido');
    expect(filter).not.toContain('),');
    expect(filter).toContain('nome.ilike.');
  });

  it('procura telefones pelo número contínuo mesmo com formatação digitada', () => {
    expect(buildContactSearchFilter('(47) 99999-0000')).toContain(
      'whatsapp.ilike.%47999990000%'
    );
  });

  it('descarta páginas e filtros inválidos e limita a busca', () => {
    const query = parseContactListQuery({
      page: '-3',
      visao: 'qualquer',
      q: ' A '.repeat(100),
    });
    expect(query).toMatchObject({ page: 1, visao: 'todos' });
    expect(query.q.length).toBeLessThanOrEqual(80);
  });

  it('não transforma uma busca só de símbolos em listagem total', () => {
    const query = parseContactListQuery({ q: '().,%_' });
    expect(query.buscaInvalida).toBe(true);
  });

  it('não apresenta lista vazia quando a contagem do banco está indisponível', async () => {
    const query = {
      order() {
        return this;
      },
      async range() {
        return { data: [], count: null, error: null };
      },
    };
    const client = {
      from() {
        return {
          select() {
            return query;
          },
        };
      },
    } as unknown as SupabaseClient;

    const result = await fetchHubContacts(client, parseContactListQuery({}));
    expect(result.erro).toBeTruthy();
    expect(result.total).toBe(0);
  });
});
