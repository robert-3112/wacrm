/**
 * Resolve a URL pública sob a qual esta instância é acessada.
 *
 * POR QUE ISTO PRECISA EXISTIR: atrás de um proxy reverso (Coolify, Vercel,
 * nginx), `request.url` carrega o host INTERNO que o contêiner enxerga —
 * `http://localhost:3000`. Quem monta um redirect ou um link a partir dele
 * manda o usuário para um endereço que só existe dentro do servidor.
 *
 * Isso já causou um defeito real: o link de redefinição de senha levava a
 * `https://localhost:3000/reset-password` e o navegador dava
 * ERR_CONNECTION_REFUSED — não havia como recuperar a senha.
 *
 * EXTRAÍDO de `src/app/api/account/invitations/route.ts`, onde a mesma cadeia
 * já existia (e sem teste). Duas cópias de lógica de host divergiriam, e host
 * é decisão de segurança — ver a nota sobre allow-list abaixo.
 *
 * Ordem de resolução, primeiro que casar vence:
 *
 *   1. `NEXT_PUBLIC_SITE_URL` — configuração explícita do operador. Vence tudo.
 *   2. `X-Forwarded-Host` (+ `X-Forwarded-Proto`) — o que todo proxy reverso
 *      põe. É isto que faz funcionar sem obrigar a configurar env var.
 *   3. Cabeçalho `Host` + o protocolo em que a requisição chegou — deploy sem
 *      proxy nenhum.
 *   4. O `fallback` que o chamador informar.
 *
 * DEFESA EM PROFUNDIDADE — `ALLOWED_INVITE_HOSTS`
 * Os caminhos 2 e 3 confiam num cabeçalho que o cliente pode forjar. Num deploy
 * atrás de proxy o proxy sobrescreve, então é confiável. Num deploy exposto
 * direto, alguém poderia mandar `Host: site-falso` e receber de volta um link
 * apontando para lá. Com `ALLOWED_INVITE_HOSTS` preenchido (lista separada por
 * vírgula), host fora da lista cai no fallback com aviso no log.
 *
 * O nome da variável nasceu no fluxo de convites e foi mantido para não quebrar
 * quem já a configurou — ela vale para qualquer host derivado da requisição.
 */

function parseAllowedHosts(): readonly string[] | null {
  const raw = process.env.ALLOWED_INVITE_HOSTS?.trim()
  if (!raw) return null
  const list = raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
  return list.length > 0 ? list : null
}

function isHostAllowed(hostname: string, allowList: readonly string[] | null): boolean {
  if (!allowList) return true // Sem lista → permissivo (comportamento legado).
  return allowList.includes(hostname.toLowerCase())
}

export function resolvePublicBaseUrl(
  request: Request,
  fallback: string,
  rotuloDoLog = '[base-url]',
): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')

  const allowList = parseAllowedHosts()

  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  if (forwardedHost && isHostAllowed(forwardedHost, allowList)) {
    return `${forwardedProto || 'https'}://${forwardedHost}`
  }

  const host = request.headers.get('host')?.trim()
  if (host && isHostAllowed(host, allowList)) {
    // O protocolo de `request.url` é o que o framework viu — confiável em
    // deploy sem proxy, que é justamente o caso que chega aqui.
    const reqProto = new URL(request.url).protocol.replace(':', '')
    return `${reqProto}://${host}`
  }

  // Chega aqui quando NÃO havia cabeçalho Host algum (praticamente impossível
  // vindo de um navegador real) OU quando havia allow-list e nenhum candidato
  // casou. O aviso é o sinal de que alguém está sondando com Host forjado.
  if (allowList && (forwardedHost || host)) {
    console.warn(`${rotuloDoLog} host fora da allow-list recusado:`, {
      forwardedHost,
      host,
      allowList,
    })
  } else {
    console.warn(`${rotuloDoLog} não foi possível derivar a URL base da requisição`)
  }
  return fallback
}
