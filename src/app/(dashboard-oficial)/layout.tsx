import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { OficialInboxHeader } from '@/components/whatsapp-oficial/oficial-inbox-header';

/**
 * Layout for the SUNT WhatsHub pages.
 *
 * Deliberately does NOT reuse `(dashboard)/dashboard-shell.tsx` /
 * `useAuth()` / `AuthProvider`: those are built around the WACRM
 * `profiles`/`accounts` (account_id + account_role) model, which does not
 * exist for this schema — SUNT authorization is `public.corretores` +
 * `public.app_roles` (`crm_is_gestao()`/`crm_current_corretor_id()`, see
 * `docs/WHATSAPP-OFFICIAL-ARCHITECTURE.md`). Reusing the WACRM shell would
 * either crash (no `profiles` row for a SUNT user) or silently render a
 * degraded nav built for a different data model — this mission's own
 * instructions warn against exactly that ("não reaproveite... sem
 * adaptar"). This is a small, self-contained server-side auth guard
 * instead: same Supabase Auth session (same project, same `auth.users` as
 * the rest of the SUNT CRM — corretores/app_roles resolve `auth.uid()`
 * directly), just without the WACRM account-model baggage.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default async function DashboardOficialLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  return (
    <div className="bg-background flex h-dvh min-h-0 flex-col overflow-hidden">
      <a
        href="#conteudo-whathub"
        className="focus:bg-background focus:text-foreground focus:ring-ring sr-only focus:not-sr-only focus:fixed focus:z-50 focus:m-3 focus:rounded-md focus:px-4 focus:py-2 focus:ring-2"
      >
        Ir para o conteúdo
      </a>
      <OficialInboxHeader userEmail={user.email ?? null} />
      <main
        id="conteudo-whathub"
        className="min-h-0 flex-1 overflow-hidden"
        tabIndex={-1}
      >
        {children}
      </main>
    </div>
  );
}
