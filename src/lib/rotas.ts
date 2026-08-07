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
 */
export const ROTAS_PROTEGIDAS = [
  '/whatsapp-oficial',
  '/dashboard',
  '/inbox',
  '/contacts',
  '/pipelines',
  '/broadcasts',
  '/automations',
  '/settings',
] as const
