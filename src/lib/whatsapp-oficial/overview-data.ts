import type { SupabaseClient } from '@supabase/supabase-js';

export interface OverviewCounts {
  abertas: number;
  pendentes: number;
  naoLidas: number;
}

export async function loadOverviewCounts(
  supabase: SupabaseClient
): Promise<OverviewCounts> {
  // The caller supplies the authenticated client so RLS scopes every count to
  // conversations this operator may actually see. `head` avoids transferring
  // rows and an exact count avoids the Data API row limit.
  const [abertas, pendentes, naoLidas] = await Promise.all([
    supabase
      .from('whatsapp_conversations')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'aberta'),
    supabase
      .from('whatsapp_conversations')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pendente'),
    supabase
      .from('whatsapp_conversations')
      .select('id', { count: 'exact', head: true })
      .gt('nao_lidas_corretor', 0),
  ]);

  if (
    [abertas, pendentes, naoLidas].some(
      (result) => result.error || result.count === null
    )
  ) {
    throw new Error('Não foi possível carregar os indicadores');
  }

  return {
    abertas: abertas.count!,
    pendentes: pendentes.count!,
    naoLidas: naoLidas.count!,
  };
}
