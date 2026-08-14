import { sleep } from 'k6';
import http from 'k6/http';

import { get, send, batchGet, ok, AUTH, WRITE } from '../lib/api.js';
import { activationToken } from '../lib/jwt.js';
import {
  PASSWORD,
  RELEASES_PER_USER,
  RELEASES_PER_MONTH,
  HISTORY_MONTHS,
} from '../lib/config.js';
import * as d from '../lib/data.js';
import {
  onboardingDuration,
  onboardingSuccess,
  usersCreated,
  releasesCreated,
} from '../lib/metrics.js';

// A provisão de categorias padrão roda em listener @Async, então não está pronta
// quando a resposta da ativação volta. 20 × 250ms cobre folgadamente o atraso
// observado mesmo com a VM saturada.
const CATEGORY_POLL_ATTEMPTS = 20;
const CATEGORY_POLL_INTERVAL = 0.25;

// Sondagem de existência: a recusa é resposta *esperada* quando o usuário ainda não
// foi semeado, e sem isto contaria como falha em http_req_failed. O login do Finax
// devolve 400 (BadCredentials virando bad request), não 401 — daí os dois na lista.
const PROBE = { responseCallback: http.expectedStatuses(200, 400, 401) };

function sessionCookie(res) {
  const cookies = res.cookies || {};
  const token = cookies.token;

  return token && token.length > 0 ? token[0].value : null;
}

/** `silent`: devolve null em vez de registrar check falho quando o login não passa. */
function doLogin(email, { silent = false } = {}) {
  const res = send(
    'POST',
    '/auth/login',
    { login: email, password: PASSWORD },
    { name: 'POST /auth/login', kind: AUTH, extra: silent ? PROBE : null },
  );

  const passed = silent ? res.status === 200 : ok(res, 'login');
  if (!passed) return null;

  const token = sessionCookie(res);
  if (!token) {
    if (!silent) console.warn('login sem cookie token — cookie Secure com BASE_URL em http?');
    return null;
  }

  return { id: res.json('id') || null, email: email, token: token };
}

/**
 * Cadastro → ativação → login. A ativação usa o endpoint real (e com ele a provisão
 * de categorias e user_configs); só o token é assinado localmente, porque o e-mail
 * que o carregaria nunca sai deste ambiente.
 *
 * `fixedEmail` é o que o perfil `seed` usa para criar endereços previsíveis; sem ele
 * o e-mail leva o RUN_ID e só serve para a execução corrente.
 */
export function registerActivateLogin(vuId, seq, fixedEmail = null) {
  const email = fixedEmail || d.uniqueEmail(vuId, seq);

  const registerRes = send(
    'POST',
    '/auth/register',
    { email: email, password: PASSWORD, firstName: 'Carga', lastName: `VU${vuId}` },
    { name: 'POST /auth/register', kind: AUTH },
  );

  if (!ok(registerRes, 'register')) return null;

  const userId = registerRes.json('id');
  if (!userId) return null;

  // Sempre 303: o controller redireciona também no erro. Quem prova que a ativação
  // funcionou é o login logo abaixo — usuário inativo é BadCredentials.
  const activateRes = get(`/login/activate-account/${userId}/${activationToken(email)}`, {
    name: 'GET /login/activate-account',
    kind: AUTH,
  });
  ok(activateRes, 'activate', 303);

  const session = doLogin(email);
  if (!session) return null;

  return Object.assign(session, { id: userId });
}

function waitForDefaultCategories(user) {
  for (let i = 0; i < CATEGORY_POLL_ATTEMPTS; i++) {
    const res = get('/category/get-by-user-with-subcategories', {
      token: user.token,
      name: 'GET /category/get-by-user-with-subcategories',
    });

    if (res.status === 200) {
      const categories = res.json();
      if (categories && categories.length > 0) return categories;
    }

    sleep(CATEGORY_POLL_INTERVAL);
  }

  return [];
}

/**
 * Os "cadastros padrões" de um usuário que acabou de entrar: duas contas, um cartão,
 * uma categoria própria com subcategoria e um punhado de lançamentos espalhados pelo
 * mês corrente e pelos dois anteriores (senão o dashboard e os relatórios leem sempre
 * conjunto vazio, e leitura de conjunto vazio não mede nada).
 */
export function provisionBaseline(user) {
  const accounts = [];

  for (const [label, type] of [['Conta Corrente', 'CHECKING'], ['Poupança', 'SAVING']]) {
    const res = send('POST', '/account', d.accountPayload(label, type), {
      token: user.token,
      name: 'POST /account',
      kind: WRITE,
    });

    if (ok(res, 'create account', 201)) accounts.push(res.json('id'));
  }

  if (accounts.length === 0) return null;

  const cardRes = send('POST', '/credit-card', d.creditCardPayload(accounts[0]), {
    token: user.token,
    name: 'POST /credit-card',
    kind: WRITE,
  });
  const cardId = ok(cardRes, 'create credit card', 201) ? cardRes.json('id') : null;

  const provisioned = waitForDefaultCategories(user);
  const expense = provisioned.filter((c) => c.type === 'E');
  const revenue = provisioned.filter((c) => c.type === 'R');

  if (expense.length === 0 || revenue.length === 0) {
    console.warn(`categorias padrão não provisionadas para ${user.email}`);
    return null;
  }

  // Uma categoria própria + subcategoria: o usuário real quase sempre cria as suas
  // além das padrão, e isso exercita POST /category e POST /subcategory.
  const ownCategoryRes = send('POST', '/category', d.categoryPayload('E'), {
    token: user.token,
    name: 'POST /category',
    kind: WRITE,
  });

  if (ok(ownCategoryRes, 'create category', 201)) {
    const ownCategoryId = ownCategoryRes.json('id');

    send('POST', '/subcategory', d.subcategoryPayload(ownCategoryId), {
      token: user.token,
      name: 'POST /subcategory',
      kind: WRITE,
    });
  }

  const releases = [];
  for (let i = 0; i < RELEASES_PER_USER; i++) {
    const isExpense = i % 4 !== 0;
    const category = d.pick(isExpense ? expense : revenue);
    const subcategory =
      category.subcategories && category.subcategories.length > 0
        ? d.pick(category.subcategories).id
        : null;

    const onCard = isExpense && cardId && d.chance(0.25);

    const payload = d.releasePayload({
      accountId: d.pick(accounts),
      creditCardId: onCard ? cardId : null,
      categoryId: category.id,
      subcategoryId: subcategory,
      type: isExpense ? 'E' : 'R',
      // Preenche mês a mês em vez de sortear: garante RELEASES_PER_MONTH em cada um
      // dos últimos HISTORY_MONTHS, e não uma distribuição irregular por azar do RNG.
      monthsBack: Math.min(Math.floor(i / RELEASES_PER_MONTH), HISTORY_MONTHS - 1),
    });

    const res = send('POST', '/cash-flow?repeatFor=1', payload, {
      token: user.token,
      name: 'POST /cash-flow',
      kind: WRITE,
    });

    if (ok(res, 'create release', 201)) {
      releases.push(res.json('id'));
      releasesCreated.add(1);
    }
  }

  return Object.assign(user, {
    accounts: accounts,
    cardId: cardId,
    expenseCategories: expense,
    revenueCategories: revenue,
    releases: releases,
  });
}

/** Jornada completa de usuário novo, medida como um bloco. */
export function onboard(vuId, seq) {
  const started = Date.now();

  const session = registerActivateLogin(vuId, seq);
  if (!session) {
    onboardingSuccess.add(false);
    return null;
  }

  const user = provisionBaseline(session);
  if (!user) {
    onboardingSuccess.add(false);
    return null;
  }

  onboardingDuration.add(Date.now() - started);
  onboardingSuccess.add(true);
  usersCreated.add(1);

  return user;
}

// ── Usuários semeados ───────────────────────────────────────────────────────

/**
 * Recarrega, para um usuário que já existe no banco, o mesmo estado que
 * `provisionBaseline` devolveria: contas, cartão, categorias e os lançamentos do mês.
 * São 4 chamadas — o custo de entrar no app, não o de se cadastrar.
 */
export function hydrate(session) {
  const [accountsRes, cardsRes, releasesRes] = batchGet(
    [
      { path: '/account/get-by-user' },
      { path: '/credit-card/get-by-user' },
      {
        path: `/cash-flow/get-monthly-releases?monthYear=${d.monthYear(new Date())}`,
        name: 'GET /cash-flow/get-monthly-releases',
      },
    ],
    session.token,
  );

  const accounts = (accountsRes.json() || []).map((a) => a.id).filter(Boolean);
  const categories = waitForDefaultCategories(session);
  const expense = categories.filter((c) => c.type === 'E');
  const revenue = categories.filter((c) => c.type === 'R');

  if (accounts.length === 0 || expense.length === 0 || revenue.length === 0) {
    console.warn(`estado incompleto para ${session.email} — o seed rodou até o fim?`);
    return null;
  }

  const cards = cardsRes.json() || [];
  const releases = (releasesRes.json() || []).map((r) => r.id).filter(Boolean);

  return Object.assign(session, {
    accounts: accounts,
    cardId: cards.length > 0 ? cards[0].id : null,
    expenseCategories: expense,
    revenueCategories: revenue,
    releases: releases,
  });
}

/**
 * Cria o usuário semeado de índice `index`, ou reaproveita se ele já existir — é o
 * login de sondagem que torna `make seed` repetível sem duplicar nada nem estourar
 * 409 de e-mail já cadastrado.
 */
export function seedUser(index) {
  const email = d.seedEmail(index);

  const existing = doLogin(email, { silent: true });
  if (existing) return existing;

  const started = Date.now();
  const session = registerActivateLogin(index, 'seed', email);
  if (!session) {
    onboardingSuccess.add(false);
    return null;
  }

  const user = provisionBaseline(session);
  if (!user) {
    onboardingSuccess.add(false);
    return null;
  }

  onboardingDuration.add(Date.now() - started);
  onboardingSuccess.add(true);
  usersCreated.add(1);

  return user;
}

/** Entrada de um usuário que já existe: login + carga do estado dele. */
export function loginSeeded(index) {
  const session = doLogin(d.seedEmail(index));

  return session ? hydrate(session) : null;
}
