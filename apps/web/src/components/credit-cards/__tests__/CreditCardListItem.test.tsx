import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { type CardSummary, CreditCardListItem } from '../CreditCardListItem';

const card: CardSummary = {
  cardId: 'card-1',
  cardName: 'Azul',
  color: null,
  canArchive: false,
  archiveBlockedReason: 'CURRENT_BILL',
  currentBill: {
    closingDate: null,
    dueDateSource: 'configuration',
    billId: null,
    statementId: 'card:2026-6',
    total: 500,
    unpaidTotal: 500,
    isPaid: false,
    month: 9,
    year: 2026,
    dueDay: 5,
    dueDate: '2026-10-05',
    transactionCount: 1,
  },
  previousBill: null,
  nextBillPreview: { total: 200, month: 10, year: 2026, transactionCount: 1 },
};

describe('CreditCardListItem', () => {
  it.each([
    { total: 500, unpaidTotal: 500, isPaid: false, payable: true },
    { total: 800, unpaidTotal: 300, isPaid: false, payable: true },
    { total: 500, unpaidTotal: 0, isPaid: true, payable: false },
    { total: 0, unpaidTotal: 0, isPaid: false, payable: false },
    { total: -100, unpaidTotal: 0, isPaid: false, payable: false },
    { total: 500, unpaidTotal: 0, isPaid: false, payable: false },
  ])('offers payment only for payable bills: %j', ({ payable, ...bill }) => {
    renderWithProviders(
      <CreditCardListItem
        card={{ ...card, currentBill: { ...card.currentBill, ...bill } }}
        creditLimit={1000}
        onPay={() => {}}
        onImport={() => {}}
      />,
    );
    expect(Boolean(screen.queryByRole('button', { name: 'Pagar fatura de Azul' }))).toBe(payable);
    expect(screen.getByRole('button', { name: 'Atualizar fatura de Azul' })).toBeEnabled();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/credit-cards/card-1');
  });

  it('supports keyboard actions outside the navigation link', async () => {
    const pay = vi.fn();
    const update = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <CreditCardListItem card={card} creditLimit={1000} onPay={pay} onImport={update} />,
    );
    const payButton = screen.getByRole('button', { name: 'Pagar fatura de Azul' });
    expect(payButton.closest('a')).toBeNull();
    await user.tab();
    expect(screen.getByRole('link')).toHaveFocus();
    await user.tab();
    expect(payButton).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(pay).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar fatura de Azul' }));
    expect(update).toHaveBeenCalledTimes(1);
  });
});
