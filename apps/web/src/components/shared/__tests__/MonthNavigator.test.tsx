import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import enMessages from '@/i18n/messages/en.json';
import ptMessages from '@/i18n/messages/pt-BR.json';
import { MonthNavigator } from '../MonthNavigator';

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

describe('MonthNavigator', () => {
  it('uses the selected language for calendar labels and controls', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MonthNavigator month={10} year={2026} onPrev={() => {}} onNext={() => {}} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('October 2026')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: enMessages.common.previousMonth }),
    ).toBeInTheDocument();
  });
  it('renders the month label with aria-live for screen-reader announcements', () => {
    wrap(<MonthNavigator month={3} year={2026} onPrev={() => {}} onNext={() => {}} />);
    const label = screen.getByText(/2026/);
    expect(label.getAttribute('aria-live')).toBe('polite');
  });

  it('calls onPrev and onNext when the nav buttons are clicked', () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    wrap(<MonthNavigator month={3} year={2026} onPrev={onPrev} onNext={onNext} />);
    fireEvent.click(screen.getByRole('button', { name: /mês anterior/i }));
    fireEvent.click(screen.getByRole('button', { name: /próximo mês/i }));
    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('applies the touch-hit utility to both buttons for a WCAG 2.5.8 hit-area', () => {
    wrap(<MonthNavigator month={3} year={2026} onPrev={() => {}} onNext={() => {}} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.className).toContain('touch-hit');
    }
  });

  it('defaults to the icon button size and accepts icon-lg', () => {
    const { rerender } = wrap(
      <MonthNavigator month={3} year={2026} onPrev={() => {}} onNext={() => {}} />,
    );
    expect(screen.getAllByRole('button')[0]?.className).toContain('size-8');

    rerender(
      <NextIntlClientProvider
        locale="pt-BR"
        messages={ptMessages as Record<string, unknown>}
        onError={() => {}}
        getMessageFallback={({ key }) => key}
      >
        <MonthNavigator
          month={3}
          year={2026}
          onPrev={() => {}}
          onNext={() => {}}
          buttonSize="icon-lg"
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getAllByRole('button')[0]?.className).toContain('size-9');
  });
});
