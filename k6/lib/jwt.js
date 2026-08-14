import crypto from 'k6/crypto';
import encoding from 'k6/encoding';

import { JWT_SECRET } from './config.js';

// O link de ativação chega por e-mail, e e-mail é justamente o que este ambiente não
// tem (SES está em buraco negro). Como o token é um JWT HS256 simétrico e o segredo
// é o mesmo que passamos para a API, o k6 assina o token que o AuthTokenAdapter
// assinaria — a ativação passa pelo endpoint real, com a provisão de categorias
// padrão e user_configs acontecendo exatamente como em produção.
//
// Contrato copiado de security/TokenService.java: HS256, iss=api-finax, sub=e-mail,
// claim `purpose` e exp (1h para ACTIVATE_ACCOUNT).
const ISSUER = 'api-finax';

function b64url(value) {
  return encoding.b64encode(value, 'rawurl');
}

export function mintToken(email, purpose, ttlSeconds) {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'HS256' }));
  const payload = b64url(
    JSON.stringify({
      iss: ISSUER,
      sub: email,
      purpose: purpose,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    }),
  );

  const signature = crypto.hmac('sha256', JWT_SECRET, `${header}.${payload}`, 'base64rawurl');

  return `${header}.${payload}.${signature}`;
}

export function activationToken(email) {
  return mintToken(email, 'ACTIVATE_ACCOUNT', 3600);
}
