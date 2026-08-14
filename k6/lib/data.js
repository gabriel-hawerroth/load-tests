import { RUN_ID, EMAIL_DOMAIN } from './config.js';

export function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function randomFloat(min, max, decimals = 2) {
  return Number((Math.random() * (max - min) + min).toFixed(decimals));
}

export function pick(list) {
  return list[randomInt(0, list.length - 1)];
}

export function chance(probability) {
  return Math.random() < probability;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function isoDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Formato aceito por GET /cash-flow/get-monthly-releases. */
export function monthYear(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

/** Formato aceito por GET /invoice/get-month-values — MM/yyyy, não yyyy-MM (InvoiceMonth.parse). */
export function invoiceMonth(date) {
  return `${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

export function monthOffset(offset) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + offset, 1);
}

/** Data aleatória dentro do mês deslocado por `offset` (0 = mês corrente). */
export function dateInMonth(offset) {
  const base = monthOffset(offset);
  const daysInMonth = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();

  return new Date(base.getFullYear(), base.getMonth(), randomInt(1, daysInMonth));
}

export function uniqueEmail(vuId, seq) {
  return `lt-${RUN_ID}-${vuId}-${seq}@${EMAIL_DOMAIN}`.toLowerCase();
}

/**
 * E-mail dos usuários semeados. Ao contrário de `uniqueEmail`, **não** leva o RUN_ID:
 * é justamente por ser previsível que a execução seguinte consegue fazer login neles
 * em vez de criar tudo de novo.
 */
export function seedEmail(index) {
  return `seed-${index}@${EMAIL_DOMAIN}`.toLowerCase();
}

// ── Payloads ────────────────────────────────────────────────────────────────

const ACCOUNT_TYPES = ['CHECKING', 'SAVING', 'SALARY', 'BROKERAGE', 'CASH'];

export function accountPayload(label, type) {
  return {
    name: `${label} ${randomInt(1, 9999)}`.slice(0, 40),
    balance: randomFloat(500, 15000),
    investments: type === 'BROKERAGE',
    countsForOverallBalance: true,
    image: null,
    accountNumber: `${randomInt(10000, 99999)}-${randomInt(0, 9)}`,
    agency: `${randomInt(1, 9999)}`,
    code: randomInt(1, 999),
    type: type || pick(ACCOUNT_TYPES),
    primaryAccountId: null,
    visibleInCashFlow: true,
    grouper: false,
  };
}

export function creditCardPayload(paymentAccountId) {
  return {
    name: `Cartão ${randomInt(1, 9999)}`,
    cardLimit: randomFloat(2000, 20000),
    closeDay: randomInt(1, 28),
    invoiceDueDay: randomInt(1, 28),
    image: null,
    standardPaymentAccountId: paymentAccountId,
  };
}

export function categoryPayload(type) {
  return {
    name: `Categoria ${randomInt(1, 99999)}`,
    color: pick(['#7253C8', '#FCA52D', '#D9AA6A', '#82C8F1', '#5161B9']),
    icon: pick(['home', 'restaurant', 'directions_bus', 'medication', 'school']),
    type: type,
    essential: chance(0.4),
  };
}

export function subcategoryPayload(categoryId) {
  return {
    name: `Subcategoria ${randomInt(1, 99999)}`,
    essential: chance(0.4),
    categoryId: categoryId,
  };
}

const EXPENSE_DESCRIPTIONS = ['Mercado', 'Aluguel', 'Combustível', 'Farmácia', 'Restaurante', 'Internet'];
const REVENUE_DESCRIPTIONS = ['Salário', 'Freelance', 'Rendimento', 'Reembolso'];

/**
 * `accountId` e `creditCardId` são mutuamente exclusivos — Release.requireAccountOrCard
 * rejeita nenhum e rejeita os dois.
 */
export function releasePayload({ accountId, creditCardId, categoryId, subcategoryId, type, monthsBack = 0 }) {
  const isExpense = type === 'E';

  return {
    description: pick(isExpense ? EXPENSE_DESCRIPTIONS : REVENUE_DESCRIPTIONS),
    accountId: creditCardId ? null : accountId,
    amount: isExpense ? randomFloat(15, 900) : randomFloat(1500, 9000),
    type: type,
    done: chance(0.7),
    targetAccountId: null,
    categoryId: categoryId,
    subcategoryId: subcategoryId,
    date: isoDate(dateInMonth(-monthsBack)),
    time: `${pad(randomInt(0, 23))}:${pad(randomInt(0, 59))}`,
    observation: null,
    repeat: null,
    fixedBy: null,
    creditCardId: creditCardId || null,
  };
}

export function invoicePaymentPayload(creditCardId, paymentAccountId, date) {
  return {
    id: null,
    creditCardId: creditCardId,
    monthYear: invoiceMonth(date),
    paymentAccountId: paymentAccountId,
    paymentAmount: randomFloat(100, 2500),
    paymentDate: isoDate(date),
    paymentHour: `${pad(randomInt(8, 20))}:00`,
  };
}
