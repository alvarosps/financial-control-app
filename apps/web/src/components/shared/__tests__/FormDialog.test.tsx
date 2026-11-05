import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import ptMessages from '@/i18n/messages/pt-BR.json';
import { FormDialog } from '../FormDialog';

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider
      locale="pt-BR"
      messages={ptMessages as Record<string, unknown>}
      onError={() => {}}
      getMessageFallback={({ key }) => key}
    >
      {ui}
    </NextIntlClientProvider>,
  );
}

describe('FormDialog', () => {
  it('renders title, children inside a form and fires onSubmit', () => {
    const onSubmit = vi.fn();
    wrap(
      <FormDialog
        open
        onOpenChange={() => {}}
        title="Titulo do dialog"
        onSubmit={onSubmit}
        isPending={false}
      >
        <input aria-label="campo" />
      </FormDialog>,
    );
    expect(screen.getByText('Titulo do dialog')).toBeTruthy();
    const form = screen.getByLabelText('campo').closest('form');
    if (!form) throw new Error('expected form');
    fireEvent.submit(form);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('applies contentClassName to the dialog content', () => {
    wrap(
      <FormDialog
        open
        onOpenChange={() => {}}
        title="T"
        onSubmit={() => {}}
        isPending={false}
        contentClassName="max-w-xl"
      >
        <div />
      </FormDialog>,
    );
    expect(document.querySelector('.max-w-xl')).toBeTruthy();
  });

  it('cancel button closes when idle', () => {
    const onOpenChange = vi.fn();
    wrap(
      <FormDialog open onOpenChange={onOpenChange} title="T" onSubmit={() => {}} isPending={false}>
        <div />
      </FormDialog>,
    );
    fireEvent.click(screen.getByRole('button', { name: /cancelar/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('while pending: pending label shown, both buttons disabled, close blocked', () => {
    const onOpenChange = vi.fn();
    wrap(
      <FormDialog
        open
        onOpenChange={onOpenChange}
        title="T"
        onSubmit={() => {}}
        isPending
        pendingLabel="Salvando..."
      >
        <div />
      </FormDialog>,
    );
    expect((screen.getByRole('button', { name: /salvando/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: /cancelar/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
