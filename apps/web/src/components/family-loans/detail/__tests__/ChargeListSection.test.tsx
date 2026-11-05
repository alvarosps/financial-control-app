import { describe, expect, it, vi } from 'vitest';
import { fireEvent, renderWithProviders, screen } from '@/test/render';
import { type ChargeItem, ChargeListSection } from '../ChargeListSection';

function item(description: string, domainType: string, isPaid = false): ChargeItem {
  return {
    id: `${description}-transaction`,
    description,
    amount: '100.00',
    installmentNumber: domainType.includes('installment') ? 2 : null,
    totalInstallments: domainType.includes('installment') ? 6 : null,
    scheduledTransactionId: `${description}-schedule`,
    domainType,
    isPaid,
  };
}

describe('ChargeListSection edit actions', () => {
  it('edits installments, expenses and discounts but not fixed or settled items', () => {
    const installment = item('Parcela A', 'family_loan_installment');
    const fixed = item('Fixo A', 'family_loan_fixed_charge');
    const expense = item('Gasto A', 'family_loan_expense');
    const discount = item('Desconto A', 'family_loan_discount');
    const settled = item('Liquidado A', 'family_loan_expense', true);
    const onEditItem = vi.fn();
    const onDeleteItem = vi.fn();

    renderWithProviders(
      <ChargeListSection
        chargeTotal={400}
        discountTotal={100}
        instTotal={100}
        fixedTotal={100}
        oneTimeChargeTotal={200}
        cardTotal={0}
        pctInst={25}
        pctCard={0}
        pctFixed={25}
        pctOneTimeCharge={50}
        sortedInstallments={[installment]}
        filteredInstallments={[installment]}
        installmentSearch=""
        onInstallmentSearchChange={() => {}}
        cards={[]}
        cardNameMap={new Map()}
        borrowedCardBreakdown={[]}
        fixedChargeItems={[fixed]}
        expenseItems={[expense, settled]}
        sortedDiscounts={[discount]}
        ledger={{
          months: [
            {
              monthKey: '2026-07',
              owed: 300,
              paid: 100,
              remaining: 200,
              status: 'partially_paid',
              borrowedCardTotal: 0,
            },
          ],
          totals: {
            totalOutstanding: 200,
            totalOverdue: 0,
            totalOwed: 300,
            totalPaid: 100,
            creditBalance: 0,
          },
          payments: [],
        }}
        month={7}
        year={2026}
        onDeleteItem={onDeleteItem}
        onEditItem={onEditItem}
      />,
    );

    for (const current of [installment, expense, discount]) {
      fireEvent.click(
        screen.getByRole('button', { name: new RegExp(`editar ${current.description}`, 'i') }),
      );
      expect(onEditItem).toHaveBeenLastCalledWith(current);
    }
    expect(screen.queryByRole('button', { name: /editar Fixo A/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /editar Liquidado A/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /excluir Liquidado A/i })).not.toBeInTheDocument();
    expect(screen.getByText('Histórico liquidado')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Resumo do mês' })).toBeInTheDocument();
  });
});
