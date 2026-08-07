import { redirect } from 'next/navigation'
import { ROTA_INICIAL } from '@/lib/rotas'

export default function RootPage() {
  redirect(ROTA_INICIAL)
}
