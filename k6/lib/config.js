function env(name, fallback) {
  const value = __ENV[name];
  return value === undefined || value === '' ? fallback : value;
}

export const BASE_URL = env('BASE_URL', 'https://nginx').replace(/\/$/, '');

// Precisa ser idêntico ao FINAX_SECRET_TOKEN da API: é com ele que o k6 assina o
// token de ativação (ver lib/jwt.js) e evita depender do e-mail que nunca sai.
export const JWT_SECRET = env('JWT_SECRET', 'loadtest-secret-token');

// Identifica a execução dentro dos e-mails gerados. Sem um RUN_ID novo a cada
// execução, o segundo teste sobre o mesmo banco recebe 409 de e-mail já cadastrado.
export const RUN_ID = env('RUN_ID', `${Date.now()}`);

export const PROFILE = env('PROFILE', 'baseline');

// Fatia das iterações de regime que escrevem em vez de só ler. O uso real do Finax
// é dominado por leitura (dashboard, fluxo de caixa, relatórios).
export const WRITE_RATIO = Number(env('WRITE_RATIO', '0.15'));

// Atende a PasswordPolicy: 8+ caracteres, maiúscula, dígito e especial.
export const PASSWORD = env('LOAD_PASSWORD', 'LoadTest123!');

export const EMAIL_DOMAIN = env('EMAIL_DOMAIN', 'loadtest.local');

// Histórico que cada usuário novo cria no cadastro inicial: RELEASES_PER_MONTH
// lançamentos em cada um dos últimos HISTORY_MONTHS meses. É o que define o tamanho
// do banco por usuário e, com ele, o custo do fluxo de caixa, do dashboard e dos
// relatórios — as leituras que filtram por período.
export const RELEASES_PER_MONTH = Number(env('RELEASES_PER_MONTH', '50'));
export const HISTORY_MONTHS = Number(env('HISTORY_MONTHS', '3'));

// Override direto do total, para quando o objetivo for encurtar o onboarding (que a
// RELEASES_PER_MONTH alta encarece) sem mudar a forma do histórico.
export const RELEASES_PER_USER = Number(
  env('RELEASES_PER_USER', String(RELEASES_PER_MONTH * HISTORY_MONTHS)),
);

// ── Usuários semeados ───────────────────────────────────────────────────────
// Quantos usuários o perfil `seed` cria (e quantos o `capacity` tem para usar).
export const SEED_USERS = Number(env('SEED_USERS', '800'));

// Com USE_SEED, o VU não se cadastra: faz login num usuário que já existe e recarrega
// o estado dele. É o que separa "quantos usuários simultâneos o app aguenta" de
// "quantos cadastros por minuto o app aguenta" — no perfil antigo as duas perguntas
// estavam misturadas, porque a rampa era feita de cadastros.
export const USE_SEED = env('USE_SEED', PROFILE === 'capacity' ? 'true' : 'false') === 'true';

// Pausa entre iterações, simulando leitura de tela.
export const THINK_TIME_MIN = Number(env('THINK_TIME_MIN', '0.5'));
export const THINK_TIME_MAX = Number(env('THINK_TIME_MAX', '2.5'));
