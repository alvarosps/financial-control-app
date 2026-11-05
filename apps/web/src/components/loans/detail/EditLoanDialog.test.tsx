import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { TRPCTestProvider } from '@/test/trpc';
import { EditLoanDialog, EMPTY_EDIT_LOAN_FORM } from './EditLoanDialog';

describe('EditLoanDialog', () => {
  it('submits a sourced annual percentage and a Brazilian money quote independently of the monthly rate', () => {
    const onSubmit = vi.fn();
    function Form() {
      const [form, setForm] = useState(EMPTY_EDIT_LOAN_FORM);
      return (
        <TRPCTestProvider>
          <EditLoanDialog
            open
            onOpenChange={() => {}}
            form={form}
            setForm={setForm}
            placeholderName="Loan"
            isPending={false}
            onSubmit={onSubmit}
          />
        </TRPCTestProvider>
      );
    }
    renderWithProviders(<Form />);
    for (const [label, value] of [
      ['CET anual (%)', '42,125'],
      ['Origem do CET', 'Contrato'],
      ['Data do CET', '2026-09-20'],
      ['Cotação para quitação (R$)', '4.123,45'],
      ['Origem da cotação', 'Banco'],
      ['Data da cotação', '2026-09-20'],
      ['Válida até', '2026-09-30'],
    ])
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        costEvidence: {
          annualCet: { rate: '0.42125000', source: 'Contrato', observedOn: '2026-09-20' },
          payoffQuote: {
            amount: '4123.45',
            source: 'Banco',
            quotedOn: '2026-09-20',
            validUntil: '2026-09-30',
          },
          economicResponsibility: 'unknown',
        },
      }),
    );
  });
});
