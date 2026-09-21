import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ImportarContatosClient } from './importar-client'

export const metadata: Metadata = {
  title: 'Importar contatos — WhatsHub',
  robots: { index: false, follow: false, nocache: true },
}

export default async function ImportarContatosPage() {
  const supabase = await createClient()
  const { data: permitido, error } = await supabase.rpc('crm_is_admin_owner')
  if (error || permitido !== true) notFound()
  return <ImportarContatosClient />
}
