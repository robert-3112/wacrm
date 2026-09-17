import { describe, expect, it } from 'vitest';
import { callbackErrorMessage, loginErrorMessage } from './login-message';

describe('loginErrorMessage', () => {
  it('gives a useful Portuguese instruction for wrong credentials', () => {
    expect(loginErrorMessage('invalid_credentials')).toBe(
      'E-mail ou senha incorretos.'
    );
  });

  it('distinguishes unconfirmed email and rate limits', () => {
    expect(loginErrorMessage('email_not_confirmed')).toContain(
      'Confirme seu e-mail'
    );
    expect(loginErrorMessage('over_request_rate_limit')).toContain('Aguarde');
  });

  it('does not display unknown provider errors to the user', () => {
    expect(loginErrorMessage('internal_database_error')).toBe(
      'Não foi possível entrar agora. Tente novamente.'
    );
    expect(loginErrorMessage(undefined)).toBe(
      'Não foi possível entrar agora. Tente novamente.'
    );
  });
});

describe('callbackErrorMessage', () => {
  it('explains invalid and expired recovery links', () => {
    expect(callbackErrorMessage('link_invalido')).toContain('inválido');
    expect(callbackErrorMessage('link_expirado')).toContain('expirou');
  });

  it('does not echo untrusted query text', () => {
    expect(callbackErrorMessage('<script>link falso</script>')).toBe(
      'Não foi possível validar o link. Peça um novo e-mail de recuperação.'
    );
    expect(callbackErrorMessage(null)).toBeNull();
  });
});
