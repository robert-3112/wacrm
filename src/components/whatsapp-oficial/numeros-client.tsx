'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, ShieldCheck, Smartphone, Wifi, WifiOff } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { statusCanalVariant } from '@/lib/whatsapp-oficial/canal-status'
import type { WhatsAppCanal } from '@/types/whatsapp-oficial'

type Provider = 'meta_cloud' | 'evolution'
interface FormValues {
  nome: string; numeroDisplay: string; provider: Provider; phoneNumberId: string
  wabaId: string; evolutionInstance: string; credential: string
}
const EMPTY: FormValues = { nome: '', numeroDisplay: '', provider: 'meta_cloud', phoneNumberId: '', wabaId: '', evolutionInstance: '', credential: '' }

const MESSAGES: Record<string, string> = {
  canal_ja_cadastrado: 'Este número ou instância já está cadastrado neste tenant.',
  tenant_ambiguo: 'Sua conta atua em mais de um tenant. Defina o tenant com a administração.',
  meta_nao_confirmou_numero: 'A Meta não confirmou o número com esta credencial.',
  meta_numero_divergente: 'A Meta retornou um ID diferente do cadastrado.',
  meta_waba_divergente: 'O número não pertence ao WABA cadastrado.',
  meta_waba_nao_confirmado: 'Não foi possível confirmar o número no WABA inteiro.',
  meta_nao_confirmou_waba: 'A Meta não confirmou o WABA com esta credencial.',
  evolution_instancia_desconectada: 'A instância Evolution está desconectada.',
  evolution_nao_configurada_no_servidor: 'A Evolution ainda não foi configurada neste servidor.',
  evolution_origem_nao_permitida: 'A instância não pertence à Evolution autorizada.',
  evolution_nao_confirmou_instancia: 'A Evolution não confirmou esta instância.',
  provider_indisponivel: 'Não foi possível consultar o provedor agora.',
  credencial_indisponivel: 'A credencial do canal está ausente ou não pôde ser lida.',
  criptografia_nao_configurada: 'A criptografia do servidor precisa ser configurada.',
  status_alterado: 'O estado do canal mudou. Atualize a tela e tente novamente.',
}
function message(slug: unknown): string {
  return typeof slug === 'string' ? (MESSAGES[slug] ?? slug.replaceAll('_', ' ')) : 'Operação não concluída.'
}

export function NumerosClient({ canais, podeGerir, evolutionDisponivel }: {
  canais: WhatsAppCanal[]; podeGerir: boolean; evolutionDisponivel: boolean
}) {
  const router = useRouter()
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState<FormValues>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, string>>({})
  const [target, setTarget] = useState<{ canal: WhatsAppCanal; next: 'ativo' | 'pausado' } | null>(null)
  const [error, setError] = useState<string | null>(null)
  function update<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function createChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const payload = form.provider === 'meta_cloud'
      ? { nome: form.nome, numeroDisplay: form.numeroDisplay, provider: form.provider, phoneNumberId: form.phoneNumberId, wabaId: form.wabaId, credential: form.credential }
      : { nome: form.nome, numeroDisplay: form.numeroDisplay, provider: form.provider, evolutionInstance: form.evolutionInstance, credential: form.credential }
    try {
      const response = await fetch('/api/whatsapp-oficial/canais', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(message(result.error))
      setForm(EMPTY)
      setCreateOpen(false)
      toast.success('Canal cadastrado inativo. Teste a conexão antes de ativá-lo.')
      router.refresh()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não foi possível cadastrar o canal.')
    } finally { setBusy(false) }
  }

  async function testChannel(canal: WhatsAppCanal) {
    setTesting(canal.id)
    try {
      const response = await fetch(`/api/whatsapp-oficial/canais/${canal.id}/teste`, { method: 'POST' })
      const result = await response.json() as { ok?: boolean; reason?: string; detalhe?: string }
      setTestResults((current) => ({ ...current, [canal.id]: response.ok && result.ok
        ? `Conexão confirmada${result.detalhe ? `: ${result.detalhe}` : ''}. Nenhuma mensagem enviada.`
        : message(result.reason) }))
    } catch {
      setTestResults((current) => ({ ...current, [canal.id]: 'Não foi possível consultar a conexão.' }))
    } finally { setTesting(null) }
  }

  async function changeStatus() {
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/whatsapp-oficial/canais/${target.canal.id}/status`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: target.next, expectedStatus: target.canal.status }),
      })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(message(result.error))
      toast.success(target.next === 'pausado' ? 'Canal pausado; pendências preservadas.' : 'Canal ativado.')
      setTarget(null)
      router.refresh()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não foi possível alterar o canal.')
    } finally { setBusy(false) }
  }

  return <div className="space-y-4">
    <Alert><ShieldCheck /><AlertTitle>Escolha a conexão adequada para cada número</AlertTitle>
      <AlertDescription>Para campanhas oficiais, use a API da Meta. Para manter também o WhatsApp Business no celular do corretor, a conexão precisa ser pelo Coexistence oficial.</AlertDescription>
    </Alert>
    <details className="border-border rounded-xl border px-4 py-3 text-sm">
      <summary className="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-offset-4">Entenda as opções de conexão</summary>
      <dl className="mt-3 space-y-3 text-xs">
        <div><dt className="font-medium">API oficial da Meta</dt><dd className="text-muted-foreground mt-1">Envios e recebimentos pelo sistema. O cadastro abaixo vincula uma conexão já configurada na Meta.</dd></div>
        <div><dt className="font-medium">Coexistence · Business no celular + API oficial</dt><dd className="text-muted-foreground mt-1">Depende da elegibilidade do número, cadastro incorporado da Meta e confirmação do titular no aplicativo. A vinculação guiada ainda não está disponível neste painel; adicionar credenciais não conclui esse processo.</dd></div>
        <div><dt className="font-medium">Evolution · conexão independente</dt><dd className="text-muted-foreground mt-1">Uma sessão vinculada por QR Code não se torna oficial. Essa conexão não substitui o Coexistence para campanhas pela API da Meta.</dd></div>
      </dl>
      <p className="text-muted-foreground mt-3 text-xs">Cadastrar ou testar uma conexão não ativa disparos nem a Sophia. Campanhas continuam sujeitas a consentimento, templates, descadastro e limites.</p>
    </details>
    <div className="flex items-center justify-between gap-3">
      <p className="text-muted-foreground text-sm">{canais.length === 1 ? '1 número visível' : `${canais.length} números visíveis`}</p>
      {podeGerir && <Button onClick={() => { setError(null); setCreateOpen(true) }}><Plus aria-hidden="true" /> Adicionar número</Button>}
    </div>
    {canais.length === 0 ? <Alert><AlertTitle>Nenhum número visível</AlertTitle><AlertDescription>
      {podeGerir ? 'Cadastre o primeiro canal. Ele ficará inativo até a conexão ser testada e ativada.' : 'Não há canais cadastrados para sua conta ou seu papel não permite visualizá-los.'}
    </AlertDescription></Alert> : <ul className="grid gap-3 md:grid-cols-2">{canais.map((canal) => <li key={canal.id} className="border-border bg-card flex flex-col justify-between gap-4 rounded-2xl border p-5">
      <div className="flex min-w-0 gap-4"><span className="bg-primary/10 text-primary flex size-11 shrink-0 items-center justify-center rounded-xl"><Smartphone className="size-5" aria-hidden="true" /></span>
        <div className="min-w-0"><h2 className="font-heading text-foreground truncate text-base font-semibold">{canal.nome}</h2>
          <p className="text-muted-foreground mt-1 text-sm">{canal.numero_display || 'Número não informado'}</p>
          <p className="text-muted-foreground mt-1 text-xs">{canal.provider === 'meta_cloud' ? 'API oficial da Meta' : 'Evolution'}</p></div></div>
      <div className="flex flex-wrap gap-2">{canal.is_default && <Badge variant="outline"><ShieldCheck className="mr-1 size-3" />Padrão</Badge>}
        <Badge variant={statusCanalVariant(canal.status)}>{canal.status === 'ativo' ? 'Cadastro ativo' : canal.status === 'pausado' ? 'Pausado' : 'Inativo'}</Badge></div>
      {podeGerir && <div className="border-border flex flex-wrap gap-2 border-t pt-3">
        <Button variant="outline" size="sm" disabled={testing === canal.id} onClick={() => testChannel(canal)}><Wifi aria-hidden="true" /> {testing === canal.id ? 'Testando…' : 'Testar conexão'}</Button>
        <Button variant={canal.status === 'ativo' ? 'destructive' : 'outline'} size="sm" onClick={() => { setError(null); setTarget({ canal, next: canal.status === 'ativo' ? 'pausado' : 'ativo' }) }}>
          {canal.status === 'ativo' ? <WifiOff aria-hidden="true" /> : <Wifi aria-hidden="true" />}{canal.status === 'ativo' ? 'Pausar' : 'Ativar'}
        </Button></div>}
      {testResults[canal.id] && <p className="text-muted-foreground text-xs" role="status">{testResults[canal.id]}</p>}
    </li>)}</ul>}

    <Dialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (!open) { setForm(EMPTY); setError(null) } }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle>Adicionar número</DialogTitle>
        <DialogDescription>O canal nasce inativo. Guarde a credencial no cofre; a tela não a exibirá depois.</DialogDescription></DialogHeader>
        <form onSubmit={createChannel} className="space-y-4">
          <div className="space-y-1"><Label htmlFor="canal-nome">Nome do canal</Label><Input id="canal-nome" required maxLength={100} value={form.nome} onChange={(e) => update('nome', e.target.value)} placeholder="Equipe Blumenau" /></div>
          <div className="space-y-1"><Label htmlFor="canal-numero">Número exibido</Label><Input id="canal-numero" maxLength={40} value={form.numeroDisplay} onChange={(e) => update('numeroDisplay', e.target.value)} placeholder="+55 ..." /></div>
          <div className="space-y-1"><Label htmlFor="canal-provider">Conexão</Label><select id="canal-provider" className="border-input bg-background h-8 w-full rounded-lg border px-2.5 text-sm" value={form.provider} onChange={(e) => update('provider', e.target.value as Provider)}>
            <option value="meta_cloud">API oficial da Meta</option><option value="evolution" disabled={!evolutionDisponivel}>Evolution{!evolutionDisponivel ? ' — configure o servidor' : ''}</option>
          </select></div>
          {form.provider === 'meta_cloud' ? <>
            <div className="space-y-1"><Label htmlFor="canal-phone-id">Phone Number ID</Label><Input id="canal-phone-id" required inputMode="numeric" value={form.phoneNumberId} onChange={(e) => update('phoneNumberId', e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="canal-waba-id">WABA ID</Label><Input id="canal-waba-id" required inputMode="numeric" value={form.wabaId} onChange={(e) => update('wabaId', e.target.value)} /></div>
          </> : <div className="space-y-1"><Label htmlFor="canal-instance">Instância Evolution</Label><Input id="canal-instance" required value={form.evolutionInstance} onChange={(e) => update('evolutionInstance', e.target.value)} /></div>}
          <div className="space-y-1"><Label htmlFor="canal-credencial">{form.provider === 'meta_cloud' ? 'Access token da Meta' : 'API key da Evolution'}</Label>
            <Input id="canal-credencial" required type="password" autoComplete="new-password" value={form.credential} onChange={(e) => update('credential', e.target.value)} /></div>
          {error && <p className="text-destructive text-sm" role="alert">{error}</p>}
          <DialogFooter><Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>Cancelar</Button>
            <Button type="submit" disabled={busy}>{busy ? 'Cadastrando…' : 'Cadastrar inativo'}</Button></DialogFooter>
        </form></DialogContent>
    </Dialog>
    <Dialog open={Boolean(target)} onOpenChange={(open) => { if (!open) { setTarget(null); setError(null) } }}>
      <DialogContent><DialogHeader><DialogTitle>{target?.next === 'pausado' ? 'Pausar canal?' : 'Ativar canal?'}</DialogTitle>
        <DialogDescription>{target?.next === 'pausado'
          ? 'Mensagens pendentes ficam na fila para uma futura retomada. Uma chamada que já chegou ao provedor pode ser concluída e exigirá reconciliação.'
          : 'A conexão será testada novamente antes da ativação. As travas globais de envio continuam independentes.'}</DialogDescription></DialogHeader>
        {error && <p className="text-destructive text-sm" role="alert">{error}</p>}
        <DialogFooter><Button variant="outline" onClick={() => setTarget(null)}>Cancelar</Button>
          <Button variant={target?.next === 'pausado' ? 'destructive' : 'default'} disabled={busy} onClick={changeStatus}>
            {busy ? 'Aguarde…' : target?.next === 'pausado' ? 'Confirmar pausa' : 'Testar e ativar'}
          </Button></DialogFooter></DialogContent>
    </Dialog>
  </div>
}
