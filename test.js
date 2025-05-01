import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'https://localhost:8080';
const USERNAME = __ENV.USERNAME || 'user@example.com';
const PASSWORD = __ENV.PASSWORD || 'password';

export function setup() {
  const payload = JSON.stringify({ login: USERNAME, password: PASSWORD });
  const params = { headers: { 'Content-Type': 'application/json' } };
  const res = http.post(`${BASE_URL}/auth/login`, payload, params);
  check(res, { 'login status é 200': (r) => r.status === 200 });
  return res.json('token');
}

export const options = {
  vus: 50, // usuários virtuais simultâneos
  duration: '30s', // duração total do teste
};

export default function (token) {
  const params = { headers: { Authorization: `Bearer ${token}` } };
  const res = http.get(`${BASE_URL}/endpoint`, params);

  check(res, {
    'status é 200': (r) => r.status === 200,
  });

  sleep(1); // espera 1s antes da próxima requisição
}
