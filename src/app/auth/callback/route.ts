import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolvePublicBaseUrl } from '@/lib/base-url'

/**
 * Troca o `code` do e-mail por uma sessão e segue para `next`.
 *
 * POR QUE ESTA ROTA EXISTE: `forgot-password/page.tsx:31` manda o e-mail de
 * redefinição apontando para `/auth/callback?next=/reset-password`, e NENHUMA das
 * duas rotas existia — o link do e-mail caía em 404 e não havia como recuperar
 * senha. Veio quebrado do WACRM upstream.
 *
 * Também serve o retorno da confirmação de e-mail do cadastro
 * (`signup/page.tsx:67`), que usa o mesmo caminho.
 */

/**
 * `next` vem da URL, ou seja, do lado de fora. Sem esta validação um link
 * `?next=https://site-falso/` transformaria um endpoint de AUTENTICAÇÃO em
 * redirecionamento aberto — e o pior tipo, porque a vítima chega nele já tendo
 * clicado num e-mail legítimo do sistema.
 *
 * Só caminho interno passa. `//evil.com` e `/\evil.com` são recusados: o
 * navegador trata os dois como protocol-relative e sairia do domínio.
 */
export function destinoSeguro(next: string | null): string {
  if (!next || !next.startsWith('/')) return '/dashboard'
  if (next.startsWith('//') || next.startsWith('/\\')) return '/dashboard'
  return next
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const next = destinoSeguro(url.searchParams.get('next'))

  // NAO usar `url.origin`: atras do proxy do Coolify ele e `https://localhost:3000`,
  // o host interno do contêiner. Foi exatamente esse o defeito — o link de
  // redefinicao levava a localhost e o navegador dava ERR_CONNECTION_REFUSED.
  const base = resolvePublicBaseUrl(request, url.origin, '[auth/callback]')

  // O Supabase manda `error_description` quando o link expirou ou já foi usado.
  // Devolver ao login com o motivo é melhor que um 404 mudo, que foi o que o
  // Robert viu.
  const erroExterno = url.searchParams.get('error_description')
  if (erroExterno) {
    return NextResponse.redirect(
      new URL(`/login?erro=${encodeURIComponent(erroExterno)}`, base),
    )
  }

  if (!code) {
    return NextResponse.redirect(new URL('/login?erro=link_invalido', base))
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)

  if (error) {
    // Só o nome do erro no log: a mensagem do Supabase pode ecoar parte do link.
    console.error('[auth/callback] falha ao trocar o code por sessão:', error.name)
    return NextResponse.redirect(new URL('/login?erro=link_expirado', base))
  }

  return NextResponse.redirect(new URL(next, base))
}
