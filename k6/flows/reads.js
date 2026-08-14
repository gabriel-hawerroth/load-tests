import { check } from 'k6';

import { get, batchGet, ok } from '../lib/api.js';
import * as d from '../lib/data.js';
import { dashboardDuration, rateLimited } from '../lib/metrics.js';

function countRateLimited(responses) {
  for (const res of responses) {
    if (res.status === 429) rateLimited.add(1);
  }
}

/**
 * A home dispara as 6 chamadas de uma vez (é o que a documentação de rate limiting
 * chama de "6 requisições por carga de dashboard"). Medir em lote é o que se
 * aproxima do tempo que o usuário percebe.
 */
export function dashboard(user) {
  const interval = d.pick(['LAST_30_DAYS', 'CURRENT_MONTH']);
  const started = Date.now();

  const responses = batchGet(
    [
      { path: '/home/get-revenue-expense' },
      { path: '/home/get-accounts-list' },
      { path: '/home/get-upcoming-releases' },
      { path: `/home/get-spends-by-category?interval=${interval}`, name: 'GET /home/get-spends-by-category' },
      { path: '/home/get-credit-cards-list' },
      { path: `/home/get-essential-expenses?interval=${interval}`, name: 'GET /home/get-essential-expenses' },
    ],
    user.token,
  );

  dashboardDuration.add(Date.now() - started);
  countRateLimited(responses);

  check(responses, {
    'dashboard: 6 respostas 200': (rs) => rs.every((r) => r.status === 200),
  });
}

/** Tela de fluxo de caixa: mês corrente na maioria das vezes, navegação para trás no resto. */
export function cashFlowMonth(user) {
  const offset = d.chance(0.7) ? 0 : -d.randomInt(1, 3);
  const res = get(`/cash-flow/get-monthly-releases?monthYear=${d.monthYear(d.monthOffset(offset))}`, {
    token: user.token,
    name: 'GET /cash-flow/get-monthly-releases',
  });

  if (res.status === 429) rateLimited.add(1);
  ok(res, 'monthly releases');
}

/** Listas que a aplicação recarrega ao abrir formulários e trocar de tela. */
export function lists(user) {
  const responses = batchGet(
    [
      { path: '/account/get-by-user' },
      { path: '/account/basic-list?showSubAccounts=true', name: 'GET /account/basic-list' },
      { path: '/category/get-by-user' },
      { path: '/credit-card/get-by-user' },
      { path: '/user-configs/get-by-user' },
    ],
    user.token,
  );

  countRateLimited(responses);

  check(responses, {
    'listas: todas 200': (rs) => rs.every((r) => r.status === 200),
  });
}

/** Relatórios — as leituras mais caras da API (agregação por categoria/conta). */
export function reports(user) {
  const interval = d.pick(['LAST_30_DAYS', 'LAST_12_MONTHS']);

  const responses = batchGet(
    [
      { path: `/reports/releases-by-category?interval=${interval}`, name: 'GET /reports/releases-by-category' },
      { path: `/reports/releases-by-account?interval=${interval}`, name: 'GET /reports/releases-by-account' },
    ],
    user.token,
  );

  countRateLimited(responses);

  check(responses, {
    'relatórios: todas 200': (rs) => rs.every((r) => r.status === 200),
  });

  // Drill-down: abrir uma categoria do relatório para ver as subcategorias.
  if (d.chance(0.5) && user.expenseCategories.length > 0) {
    const category = d.pick(user.expenseCategories);

    const res = get(
      `/reports/releases-by-category/subcategories/${category.id}?interval=${interval}`,
      { token: user.token, name: 'GET /reports/releases-by-category/subcategories' },
    );

    if (res.status === 429) rateLimited.add(1);
    ok(res, 'report subcategories');
  }
}

/** Tela de faturas do cartão. */
export function invoices(user) {
  if (!user.cardId) return;

  const responses = batchGet(
    [
      { path: '/invoice/get-values' },
      {
        path: `/invoice/get-month-values?creditCardId=${user.cardId}&selectedMonth=${d.invoiceMonth(new Date())}`,
        name: 'GET /invoice/get-month-values',
      },
    ],
    user.token,
  );

  countRateLimited(responses);

  check(responses, {
    'faturas: todas 200': (rs) => rs.every((r) => r.status === 200),
  });
}

/** Uma "sessão de leitura": o que um usuário faz depois de abrir o app. */
export function readMix(user) {
  const roll = Math.random();

  if (roll < 0.45) dashboard(user);
  else if (roll < 0.7) cashFlowMonth(user);
  else if (roll < 0.85) lists(user);
  else if (roll < 0.95) reports(user);
  else invoices(user);
}
