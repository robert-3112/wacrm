import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { OperationalScopeError } from '@/lib/whatsapp-oficial/operations-overview';
import {
  loadSettingsEntry,
  type SettingsEntry,
} from '@/lib/whatsapp-oficial/platform-entry-data';
import { SettingsEntryPanel } from '@/components/whatsapp-oficial/platform-entry-panels';

export const metadata: Metadata = { title: 'Configurações — WhatsHub' };
export const dynamic = 'force-dynamic';

export default async function ConfiguracoesPage() {
  let data: SettingsEntry | null = null;
  try {
    data = await loadSettingsEntry(await createClient());
  } catch (error) {
    if (
      error instanceof OperationalScopeError &&
      error.kind === 'unauthenticated'
    )
      redirect('/login');
  }
  return <SettingsEntryPanel data={data} />;
}
