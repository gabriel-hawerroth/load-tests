import { PROFILE } from './lib/config.js';

function env(name, fallback) {
  const value = __ENV[name];
  return value === undefined || value === '' ? Number(fallback) : Number(value);
}

// VUS = usuários simultâneos em regime; SIGNUP_RATE = cadastros novos por minuto,
// sustentados durante todo o teste (não só na rampa).
const VUS = env('VUS', 40);
const SIGNUP_RATE = env('SIGNUP_RATE', 10);
const DURATION_MIN = env('DURATION', 8);

const SEED_USERS = env('SEED_USERS', 800);
const SEED_VUS = env('SEED_VUS', 20);

// Degraus do perfil `capacity`. Cada um sobe em 1 minuto e fica CAPACITY_STEP_MINUTES
// em patamar — é o patamar que vale, a rampa sempre distorce.
const CAPACITY_STEPS = (__ENV.CAPACITY_STEPS || '100,200,400,800')
  .split(',')
  .map(Number)
  .filter((n) => n > 0);
const CAPACITY_STEP_MINUTES = env('CAPACITY_STEP_MINUTES', 2);

function capacityStages() {
  const stages = [];

  for (const target of CAPACITY_STEPS) {
    stages.push({ duration: '1m', target: target });
    stages.push({ duration: `${CAPACITY_STEP_MINUTES}m`, target: target });
  }

  stages.push({ duration: '1m', target: 0 });

  return stages;
}

function journeyRamp(steadyMinutes, peak) {
  return {
    executor: 'ramping-vus',
    exec: 'journey',
    startVUs: 0,
    // A rampa é onde os cadastros acontecem: cada VU novo é um usuário novo
    // fazendo registro → ativação → cadastros padrões. Depois dela, os mesmos
    // usuários passam a ler.
    stages: [
      { duration: '1m', target: peak },
      { duration: `${steadyMinutes}m`, target: peak },
      { duration: '30s', target: 0 },
    ],
    gracefulRampDown: '30s',
  };
}

function signupStream(totalMinutes, ratePerMinute) {
  return {
    executor: 'constant-arrival-rate',
    exec: 'signup',
    rate: ratePerMinute,
    timeUnit: '1m',
    duration: `${totalMinutes}m`,
    // Cadastro é caro (bcrypt + provisão de categorias): sobra de VU pré-alocada
    // evita que o k6 falhe em manter a taxa quando a API desacelera.
    preAllocatedVUs: Math.max(4, Math.ceil(ratePerMinute / 2)),
    maxVUs: Math.max(20, ratePerMinute * 3),
    startTime: '30s',
  };
}

const PROFILES = {
  // Valida o pipeline inteiro em ~1 minuto. É o que se roda depois de mexer no harness.
  smoke: {
    journey: { executor: 'per-vu-iterations', exec: 'journey', vus: 2, iterations: 6, maxDuration: '3m' },
    signup: { executor: 'per-vu-iterations', exec: 'signup', vus: 1, iterations: 2, maxDuration: '3m' },
  },

  // Carga de regime: é este o número que responde "a VM aguenta X usuários".
  baseline: {
    journey: journeyRamp(DURATION_MIN, VUS),
    signup: signupStream(DURATION_MIN + 1, SIGNUP_RATE),
  },

  // Sobe até quebrar. Procure o joelho: onde p95 dispara e http_req_failed sai de zero.
  stress: {
    journey: {
      executor: 'ramping-vus',
      exec: 'journey',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 25 },
        { duration: '2m', target: 25 },
        { duration: '1m', target: 50 },
        { duration: '2m', target: 50 },
        { duration: '1m', target: 100 },
        { duration: '2m', target: 100 },
        { duration: '1m', target: 200 },
        { duration: '3m', target: 200 },
        { duration: '1m', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
    signup: signupStream(14, SIGNUP_RATE),
  },

  // Não é medição: enche o banco com SEED_USERS usuários completos, de e-mail
  // previsível, para o perfil `capacity` usar. Roda uma vez; repetir só cria o que
  // faltar. Cuidado ao dar `make clean` depois — o seed vai junto.
  seed: {
    seed: {
      executor: 'shared-iterations',
      exec: 'seed',
      vus: SEED_VUS,
      iterations: SEED_USERS,
      maxDuration: '90m',
    },
  },

  // Quantos usuários simultâneos a VM aguenta. Aqui ninguém se cadastra: os VUs fazem
  // login em usuários que já existem, então o que está sendo medido é concorrência de
  // uso, e não a tempestade de cadastro que dominava a rampa do `stress`.
  capacity: {
    journey: {
      executor: 'ramping-vus',
      exec: 'journey',
      startVUs: 0,
      stages: capacityStages(),
      // Generoso de propósito: perto do joelho as iterações demoram, e um rampDown
      // curto mataria justamente as requisições lentas que interessam medir.
      gracefulRampDown: '1m',
    },
  },

  // Vazamento de memória, bloat de tabela e degradação lenta só aparecem no tempo.
  soak: {
    journey: journeyRamp(60, Math.min(VUS, 25)),
    signup: signupStream(61, Math.min(SIGNUP_RATE, 4)),
  },
};

export const scenarios = PROFILES[PROFILE] || PROFILES.baseline;

// Os limites separam por natureza de chamada: `auth` carrega bcrypt (custo de CPU
// deliberado), `write` carrega INSERT + regra de negócio, `read` é o que o usuário
// encara olhando para a tela.
export const thresholds = {
  http_req_failed: ['rate<0.02'],
  checks: ['rate>0.98'],
  'http_req_duration{kind:read}': ['p(95)<800', 'p(99)<2000'],
  'http_req_duration{kind:write}': ['p(95)<1200'],
  'http_req_duration{kind:auth}': ['p(95)<4000'],
  dashboard_duration: ['p(95)<1500'],
  onboarding_success: ['rate>0.95'],
};
