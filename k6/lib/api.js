import http from 'k6/http';
import { check, fail } from 'k6';

import { BASE_URL } from './config.js';

// `kind` vira tag de métrica: os thresholds separam leitura, escrita e autenticação
// porque o custo de cada uma é diferente por natureza (bcrypt no login, JOIN pesado
// no relatório, INSERT simples no lançamento).
export const READ = 'read';
export const WRITE = 'write';
export const AUTH = 'auth';

function params(name, kind, token, extra) {
  const headers = { Accept: 'application/json' };

  if (token) {
    // Cookie explícito em vez do cookie jar: o jar do k6 é zerado a cada iteração,
    // e as iterações de regime precisam da sessão aberta na iteração anterior.
    headers.Cookie = `token=${token}`;
  }

  return Object.assign(
    {
      headers: headers,
      tags: { name: name, kind: kind },
      // Só a ativação redireciona (303 para o site); seguir o redirect mediria um
      // host que nem existe neste ambiente.
      redirects: 0,
    },
    extra || {},
  );
}

export function get(path, { token = null, name = path, kind = READ, extra = null } = {}) {
  return http.get(`${BASE_URL}${path}`, params(name, kind, token, extra));
}

export function send(method, path, body, { token = null, name = path, kind = WRITE, extra = null } = {}) {
  const p = params(name, kind, token, extra);
  p.headers['Content-Type'] = 'application/json';

  return http.request(method, `${BASE_URL}${path}`, body === null ? null : JSON.stringify(body), p);
}

export function batchGet(entries, token) {
  return http.batch(
    entries.map((e) => ['GET', `${BASE_URL}${e.path}`, null, params(e.name || e.path, READ, token)]),
  );
}

export function ok(res, label, expected = 200) {
  const passed = check(res, {
    [`${label} → ${expected}`]: (r) => r.status === expected,
  });

  if (!passed) {
    // Corpo truncado: um 400 em massa vira megabytes de log e derruba a própria
    // execução do k6.
    console.warn(`${label}: esperado ${expected}, veio ${res.status} — ${String(res.body).slice(0, 200)}`);
  }

  return passed;
}

export function okOrFail(res, label, expected = 200) {
  if (!ok(res, label, expected)) {
    fail(`${label} falhou com ${res.status}`);
  }

  return res;
}
