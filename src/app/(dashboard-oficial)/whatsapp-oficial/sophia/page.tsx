import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { OperationalScopeError } from '@/lib/whatsapp-oficial/operations-overview';
import {
  loadSophiaEntry,
  type SophiaEntry,
} from '@/lib/whatsapp-oficial/platform-entry-data';
import { SophiaEntryPanel } from '@/components/whatsapp-oficial/platform-entry-panels';

export const metadata: Metadata = { title: 'Sophia — WhatsHub' };
export const dynamic = 'force-dynamic';

export default async function SophiaPage() {
  let data: SophiaEntry | null = null;
  try {
    data = await loadSophiaEntry(await createClient());
  } catch (error) {
    if (
      error instanceof OperationalScopeError &&
      error.kind === 'unauthenticated'
    )
      redirect('/login');
  }
  return <SophiaEntryPanel data={data} />;
}
