import { send, ok, WRITE } from '../lib/api.js';
import * as d from '../lib/data.js';
import { releasesCreated, rateLimited } from '../lib/metrics.js';

function trackLimit(res) {
  if (res.status === 429) rateLimited.add(1);
  return res;
}

function categoryFor(user, type) {
  const list = type === 'E' ? user.expenseCategories : user.revenueCategories;
  return list.length > 0 ? d.pick(list) : null;
}

/** Lançamento avulso — a escrita mais comum do produto. */
export function addRelease(user) {
  const type = d.chance(0.8) ? 'E' : 'R';
  const category = categoryFor(user, type);
  if (!category) return;

  const subcategory =
    category.subcategories && category.subcategories.length > 0 ? d.pick(category.subcategories).id : null;

  const onCard = type === 'E' && user.cardId && d.chance(0.3);

  const payload = d.releasePayload({
    accountId: d.pick(user.accounts),
    creditCardId: onCard ? user.cardId : null,
    categoryId: category.id,
    subcategoryId: subcategory,
    type: type,
    monthsBack: 0,
  });

  const res = trackLimit(
    send('POST', '/cash-flow?repeatFor=1', payload, {
      token: user.token,
      name: 'POST /cash-flow',
      kind: WRITE,
    }),
  );

  if (ok(res, 'add release', 201)) {
    user.releases.push(res.json('id'));
    releasesCreated.add(1);
  }
}

/**
 * Compra parcelada: um POST vira `repeatFor` linhas em release + a série.
 * É a escrita mais pesada do fluxo de caixa, por isso entra com peso baixo.
 */
export function addInstallments(user) {
  const category = categoryFor(user, 'E');
  if (!category) return;

  const repeatFor = d.randomInt(3, 12);
  const payload = Object.assign(
    d.releasePayload({
      accountId: d.pick(user.accounts),
      creditCardId: user.cardId,
      categoryId: category.id,
      subcategoryId: null,
      type: 'E',
      monthsBack: 0,
    }),
    { repeat: 'INSTALLMENTS', done: false },
  );

  const res = trackLimit(
    send('POST', `/cash-flow?repeatFor=${repeatFor}`, payload, {
      token: user.token,
      name: 'POST /cash-flow (parcelado)',
      kind: WRITE,
    }),
  );

  if (ok(res, 'add installments', 201)) releasesCreated.add(repeatFor);
}

/** Marcar como pago/recebido — o clique mais frequente da tela de fluxo de caixa. */
export function toggleDone(user) {
  if (user.releases.length === 0) return;

  const id = d.pick(user.releases);
  const res = trackLimit(
    send('PATCH', `/cash-flow/update-done/${id}?done=${d.chance(0.5)}`, null, {
      token: user.token,
      name: 'PATCH /cash-flow/update-done',
      kind: WRITE,
    }),
  );

  ok(res, 'toggle done', 204);
}

/** Edição de lançamento avulso — UNNECESSARY porque não faz parte de série. */
export function editRelease(user) {
  if (user.releases.length === 0) return;

  const id = d.pick(user.releases);
  const category = categoryFor(user, 'E');
  if (!category) return;

  const payload = d.releasePayload({
    accountId: d.pick(user.accounts),
    creditCardId: null,
    categoryId: category.id,
    subcategoryId: null,
    type: 'E',
    monthsBack: 0,
  });

  const res = trackLimit(
    send('PUT', `/cash-flow/${id}?duplicatedReleaseAction=UNNECESSARY`, payload, {
      token: user.token,
      name: 'PUT /cash-flow/{id}',
      kind: WRITE,
    }),
  );

  // 400 aqui é esperado quando o id sorteado pertence a uma série (a ação correta
  // seria ALL/NEXTS/JUST_THIS); só o 5xx interessa.
  if (res.status >= 500) ok(res, 'edit release');
}

export function adjustBalance(user) {
  const id = d.pick(user.accounts);
  const res = trackLimit(
    send('PATCH', `/account/adjust-balance/${id}?newBalance=${d.randomFloat(100, 20000)}`, null, {
      token: user.token,
      name: 'PATCH /account/adjust-balance',
      kind: WRITE,
    }),
  );

  ok(res, 'adjust balance');
}

/** Pagamento de fatura: escrita cruzando cartão e conta. */
export function payInvoice(user) {
  if (!user.cardId) return;

  const res = trackLimit(
    send('POST', '/invoice/save-payment', d.invoicePaymentPayload(user.cardId, user.accounts[0], new Date()), {
      token: user.token,
      name: 'POST /invoice/save-payment',
      kind: WRITE,
    }),
  );

  ok(res, 'pay invoice', 201);
}

/** Cadastro de conta nova fora do onboarding. */
export function addAccount(user) {
  const res = trackLimit(
    send('POST', '/account', d.accountPayload('Conta', null), {
      token: user.token,
      name: 'POST /account',
      kind: WRITE,
    }),
  );

  if (ok(res, 'add account', 201)) user.accounts.push(res.json('id'));
}

export function writeMix(user) {
  const roll = Math.random();

  if (roll < 0.45) addRelease(user);
  else if (roll < 0.65) toggleDone(user);
  else if (roll < 0.78) editRelease(user);
  else if (roll < 0.86) addInstallments(user);
  else if (roll < 0.93) adjustBalance(user);
  else if (roll < 0.97) payInvoice(user);
  else addAccount(user);
}
