import exec from 'k6/execution';
import { sleep } from 'k6';

import { scenarios, thresholds } from './profiles.js';
import { get } from './lib/api.js';
import { onboard, seedUser, loginSeeded } from './flows/onboarding.js';
import { dashboard, readMix } from './flows/reads.js';
import { writeMix } from './flows/writes.js';
import {
  BASE_URL,
  PROFILE,
  RUN_ID,
  SEED_USERS,
  THINK_TIME_MAX,
  THINK_TIME_MIN,
  USE_SEED,
  WRITE_RATIO,
} from './lib/config.js';

export const options = {
  scenarios: scenarios,
  thresholds: thresholds,
  // O nginx do ambiente usa certificado auto-assinado (produção termina TLS no
  // nginx; sem TLS aqui o custo de handshake sumiria da conta).
  insecureSkipTLSVerify: true,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  setupTimeout: '2m',
};

function thinkTime() {
  return Math.random() * (THINK_TIME_MAX - THINK_TIME_MIN) + THINK_TIME_MIN;
}

export function setup() {
  const res = get('/auth/timezone', { name: 'GET /auth/timezone' });

  if (res.status !== 200) {
    throw new Error(`API não respondeu em ${BASE_URL}/auth/timezone (status ${res.status})`);
  }

  console.log(`perfil=${PROFILE} run=${RUN_ID} alvo=${BASE_URL} :: ${res.body}`);

  return { startedAt: Date.now() };
}

// Estado por VU: cada VU do cenário `journey` é uma pessoa. Na primeira iteração
// ela se cadastra e monta as contas/cartão/lançamentos; nas seguintes, usa o app.
let user = null;
let attempts = 0;

export function journey() {
  if (!user) {
    // Com USE_SEED o VU entra como usuário existente (login + carga do estado); sem
    // ele, se cadastra do zero. A diferença é o que a primeira iteração custa: ~4
    // requisições contra ~155.
    user = USE_SEED
      ? loginSeeded(((exec.vu.idInTest - 1) % SEED_USERS) + 1)
      : onboard(exec.vu.idInTest, `j${++attempts}`);

    if (!user) {
      // Cadastro falhou (rate limit, 5xx, banco travado). Espera e tenta de novo na
      // próxima iteração em vez de deixar o VU inútil pelo resto do teste.
      sleep(2);
      return;
    }

    sleep(thinkTime());
    return;
  }

  if (Math.random() < WRITE_RATIO) {
    writeMix(user);
  } else {
    readMix(user);
  }

  sleep(thinkTime());
}

// Fluxo de usuário novo puro, com taxa constante: mantém pressão de cadastro
// durante todo o teste, e não só durante a rampa do `journey`.
export function signup() {
  const fresh = onboard(exec.vu.idInTest, `s${exec.scenario.iterationInTest}`);

  if (!fresh) return;

  // Todo mundo cai na home logo depois de terminar o cadastro.
  dashboard(fresh);
}

// Popula o banco com usuários de e-mail previsível (`seed-N@…`) para que os perfis de
// concorrência não gastem a rampa cadastrando. Idempotente: quem já existe é pulado.
export function seed() {
  seedUser(exec.scenario.iterationInTest + 1);
}
