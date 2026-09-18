/**
 * Para onde uma pessoa autenticada deve cair neste sistema.
 *
 * O fork WACRM manda tudo para `/dashboard`, que é a tela DELE — construída
 * sobre o modelo de dados dele (`accounts`, `contacts`, `deals`, `pipelines`),
 * que a SUNT não usa. O resultado é uma tela de painel com tudo zerado e um
 * menu inteiro de páginas que não conversam com nenhum dado real da SUNT.
 *
 * Quem entra aqui vem trabalhar no canal oficial de WhatsApp. A porta é o inbox.
 *
 * As telas do fork continuam acessíveis por URL — não foram removidas, para não
 * mexer no que não é nosso —, mas ninguém é levado até elas.
 */
export const ROTA_INICIAL = '/whatsapp-oficial/inbox'

/**
 * Prefixos que exigem sessão. O middleware devolve para `/login` quem chegar
 * sem estar autenticado.
 *
 * `/whatsapp-oficial` estava FORA desta lista: quem abrisse o inbox deslogado
 * recebia a página renderizada e só depois um erro vindo do servidor, em vez de
 * ser mandado para o login.
 *
 * As páginas herdadas do WACRM que moravam aqui (/dashboard, /contacts, …)
 * migraram para ROTAS_MORTAS abaixo: elas agora respondem 404 antes de a
 * checagem de sessão sequer rodar, então protegê-las virou letra morta.
 */
export const ROTAS_PROTEGIDAS = [
  '/whatsapp-oficial',
  '/inbox',
] as const

/**
 * Superfície herdada do WACRM que este fork NÃO usa — o middleware responde
 * 404 para tudo aqui, para todo mundo, ANTES de consultar sessão.
 *
 * Por que matar em vez de só "não linkar":
 *
 * - `/api/whatsapp/` (o prefixo INTEIRO, webhook incluso): as rotas herdadas
 *   escrevem com service_role em `.from('messages')`, que COLIDE com a tabela
 *   real da Sophia no projeto Supabase da SUNT. Hoje a escrita só não corrompe
 *   porque a coluna `message_id` não existe lá — uma migração inocente
 *   removeria esse acidente protetor.
 * - `/signup`: cria usuário no Supabase Auth do projeto SUNT via anon key —
 *   auto-cadastro aberto num sistema onde conta é provisionada pela gestão.
 * - Páginas do modelo de dados do WACRM (`accounts`/`contacts`/`deals`):
 *   renderizam telas zeradas que não conversam com nenhum dado da SUNT.
 * - `/api/automations`: devolvia `error.message` cru num 500 — vazamento de
 *   schema para quem provocasse o erro.
 *
 * A checagem casa o caminho exato ou o prefixo seguido de `/` — nunca um
 * prefixo "solto": `/api/whatsapp` NÃO pode capturar `/api/whatsapp-oficial`.
 */
export const ROTAS_MORTAS = [
  '/api/whatsapp',
  '/api/automations',
  '/api/account',
  '/api/ai',
  '/api/contacts',
  '/api/flows',
  '/api/invitations',
  '/api/quick-replies',
  '/api/v1/broadcasts',
  '/api/v1/me',
  '/api/v1/webhooks',
  '/signup',
  '/join',
  '/dashboard',
  '/contacts',
  '/pipelines',
  '/broadcasts',
  '/automations',
  '/flows',
  '/agents',
  '/settings',
  '/notifications',
] as const

/** Caminho exato ou descendente (`/x` ou `/x/…`) — o hífen não engana: `/api/whatsapp-oficial` passa. */
export function isRotaMorta(pathname: string): boolean {
  return ROTAS_MORTAS.some((rota) => pathname === rota || pathname.startsWith(`${rota}/`))
}
