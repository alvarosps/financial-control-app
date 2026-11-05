import { Money } from '@fc/domain';
import { defaultLocale } from '@/i18n/config';

export type MonthlyReportItem = {
  description: string;
  amount: string | number;
  installmentNumber?: number | null;
  totalInstallments?: number | null;
};

export type MonthlyReportLabels = {
  description: string;
  value: string;
  installment: string;
  sections: {
    cards: { title: string; total: string };
    installments: { title: string; total: string };
    fixedCharges: { title: string; total: string };
    oneTimeCharges: { title: string; total: string };
    discounts: { title: string; total: string };
  };
};

export type FamilyLoanMonthlyReport = {
  locale?: string;
  month: number;
  year: number;
  labels: MonthlyReportLabels;
  totals: {
    grandTotal: number;
    cards: number;
    installments: number;
    fixedCharges: number;
    oneTimeCharges: number;
    discounts: number;
  };
  cards: MonthlyReportItem[];
  installments: MonthlyReportItem[];
  fixedCharges: MonthlyReportItem[];
  oneTimeCharges: MonthlyReportItem[];
  discounts: MonthlyReportItem[];
};

const DESCRIPTION_WIDTH = 24;
const VALUE_WIDTH = 14;
const segmenter = new Intl.Segmenter('pt-BR', { granularity: 'grapheme' });
const currencyFormatter = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
});

function graphemes(value: string): string[] {
  return [...segmenter.segment(value)].map((segment) => segment.segment);
}

function graphemeLength(value: string): number {
  return graphemes(value).length;
}

function padEndGraphemes(value: string, width: number): string {
  return `${value}${' '.repeat(Math.max(0, width - graphemeLength(value)))}`;
}

function normalizeDescription(value: string): string {
  return value.normalize('NFC').replace(/`/g, "'").replace(/\s+/g, ' ').trim();
}

function splitLongWord(word: string): string[] {
  const parts = graphemes(word);
  const chunks: string[] = [];
  for (let index = 0; index < parts.length; index += DESCRIPTION_WIDTH) {
    chunks.push(parts.slice(index, index + DESCRIPTION_WIDTH).join(''));
  }
  return chunks;
}

function wrapDescription(value: string): string[] {
  const normalized = normalizeDescription(value) || '-';
  const lines: string[] = [];
  let current = '';

  for (const word of normalized.split(' ')) {
    if (graphemeLength(word) > DESCRIPTION_WIDTH) {
      if (current) {
        lines.push(current);
        current = '';
      }
      const chunks = splitLongWord(word);
      lines.push(...chunks.slice(0, -1));
      current = chunks.at(-1) ?? '';
      continue;
    }

    const candidate = current ? `${current} ${word}` : word;
    if (graphemeLength(candidate) <= DESCRIPTION_WIDTH) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);
  return lines;
}

function moneyValue(value: string | number): number {
  return typeof value === 'number'
    ? Money.fromNumber(value, 'BRL').toNumber()
    : Money.fromString(value, 'BRL').toNumber();
}

function formatMoney(value: string | number, negative = false): string {
  const normalized = Math.abs(moneyValue(value)) < 0.005 ? 0 : Math.abs(moneyValue(value));
  const formatted = currencyFormatter.format(normalized).replace(/[\u00a0\u202f]/g, ' ');
  return negative && normalized !== 0 ? `-${formatted}` : formatted;
}

function formatTableMoney(value: string | number, negative = false): string {
  const formatted = formatMoney(value, negative);
  const match = /^(-?R\$ )(.*)$/.exec(formatted);
  if (!match) return formatted.padStart(VALUE_WIDTH);
  return `${match[1]}${match[2].padStart(VALUE_WIDTH - match[1].length)}`;
}

function compareItems(left: MonthlyReportItem, right: MonthlyReportItem): number {
  const byInstallment = (right.installmentNumber ?? -1) - (left.installmentNumber ?? -1);
  if (byInstallment !== 0) return byInstallment;
  const leftDescription = normalizeDescription(left.description);
  const rightDescription = normalizeDescription(right.description);
  const byDescription = leftDescription.localeCompare(rightDescription, 'pt-BR');
  if (byDescription !== 0) return byDescription;
  return String(left.amount).localeCompare(String(right.amount));
}

function sectionLines(input: {
  title: string;
  totalLabel: string;
  total: number;
  items: MonthlyReportItem[];
  labels: MonthlyReportLabels;
  showInstallment: boolean;
  negativeTotal?: boolean;
}): string[] {
  if (input.items.length === 0 && Math.abs(input.total) < 0.005) return [];
  const sorted = [...input.items].sort(compareItems);
  const installmentWidth = input.showInstallment
    ? Math.max(
        graphemeLength(input.labels.installment),
        ...sorted.map((item) =>
          graphemeLength(
            item.installmentNumber != null && item.totalInstallments != null
              ? `${item.installmentNumber}/${item.totalInstallments}`
              : '',
          ),
        ),
      )
    : 0;
  const lines = [
    input.title,
    input.showInstallment
      ? `${padEndGraphemes(input.labels.description, DESCRIPTION_WIDTH)}  ${input.labels.value.padEnd(VALUE_WIDTH)}  ${input.labels.installment.padStart(installmentWidth)}`
      : `${padEndGraphemes(input.labels.description, DESCRIPTION_WIDTH)}  ${input.labels.value.padEnd(VALUE_WIDTH)}`,
  ];

  for (const item of sorted) {
    const descriptionLines = wrapDescription(item.description);
    const value = formatTableMoney(item.amount);
    const installment =
      item.installmentNumber != null && item.totalInstallments != null
        ? `${item.installmentNumber}/${item.totalInstallments}`
        : '';
    descriptionLines.forEach((description, index) => {
      const valueColumn = index === 0 ? value : '';
      const installmentColumn = index === 0 ? installment : '';
      lines.push(
        input.showInstallment
          ? `${padEndGraphemes(description, DESCRIPTION_WIDTH)}  ${valueColumn.padEnd(VALUE_WIDTH)}  ${installmentColumn.padStart(installmentWidth)}`
          : `${padEndGraphemes(description, DESCRIPTION_WIDTH)}  ${valueColumn.padEnd(VALUE_WIDTH)}`,
      );
    });
  }

  const total = formatTableMoney(input.total, input.negativeTotal);
  lines.push(
    input.showInstallment
      ? `${padEndGraphemes(input.totalLabel, DESCRIPTION_WIDTH)}  ${total}  ${''.padStart(installmentWidth)}`
      : `${padEndGraphemes(input.totalLabel, DESCRIPTION_WIDTH)}  ${total}`,
  );
  return lines;
}

export function buildFamilyLoanMonthlyReport(input: FamilyLoanMonthlyReport): string {
  const locale = input.locale ?? defaultLocale;
  const monthLabel = new Intl.DateTimeFormat(locale, {
    month: 'long',
    timeZone: 'UTC',
  })
    .format(new Date(Date.UTC(input.year, input.month - 1, 1)))
    .normalize('NFC')
    .toLocaleUpperCase(locale);
  const header = `${monthLabel}/${input.year}`.padEnd(DESCRIPTION_WIDTH + 2);
  const lines = [`${header}${formatMoney(input.totals.grandTotal).padStart(VALUE_WIDTH)}`];
  const sections = [
    sectionLines({
      title: input.labels.sections.cards.title,
      totalLabel: input.labels.sections.cards.total,
      total: input.totals.cards,
      items: input.cards,
      labels: input.labels,
      showInstallment: false,
    }),
    sectionLines({
      title: input.labels.sections.installments.title,
      totalLabel: input.labels.sections.installments.total,
      total: input.totals.installments,
      items: input.installments,
      labels: input.labels,
      showInstallment: true,
    }),
    sectionLines({
      title: input.labels.sections.fixedCharges.title,
      totalLabel: input.labels.sections.fixedCharges.total,
      total: input.totals.fixedCharges,
      items: input.fixedCharges,
      labels: input.labels,
      showInstallment: false,
    }),
    sectionLines({
      title: input.labels.sections.oneTimeCharges.title,
      totalLabel: input.labels.sections.oneTimeCharges.total,
      total: input.totals.oneTimeCharges,
      items: input.oneTimeCharges,
      labels: input.labels,
      showInstallment: false,
    }),
    sectionLines({
      title: input.labels.sections.discounts.title,
      totalLabel: input.labels.sections.discounts.total,
      total: input.totals.discounts,
      items: input.discounts,
      labels: input.labels,
      showInstallment: true,
      negativeTotal: true,
    }),
  ].filter((section) => section.length > 0);

  for (const section of sections) {
    lines.push('', ...section);
  }
  return lines.join('\n');
}
