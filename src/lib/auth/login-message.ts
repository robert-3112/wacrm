export function loginErrorMessage(code: string | undefined): string {
  if (code === 'invalid_credentials') return 'E-mail ou senha incorretos.';
  if (code === 'email_not_confirmed')
    return 'Confirme seu e-mail antes de entrar.';
  if (code === 'over_request_rate_limit')
    return 'Muitas tentativas. Aguarde alguns minutos e tente novamente.';
  return 'Não foi possível entrar agora. Tente novamente.';
}

export function callbackErrorMessage(code: string | null): string | null {
  if (!code) return null;
  if (code === 'link_invalido')
    return 'O link de recuperação é inválido. Peça um novo e-mail.';
  if (code === 'link_expirado')
    return 'O link de recuperação expirou. Peça um novo e-mail.';
  return 'Não foi possível validar o link. Peça um novo e-mail de recuperação.';
}
