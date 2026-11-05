import { beforeEach, describe, expect, it } from 'vitest';
import { CountUpAmount } from '@/components/shared/CountUpAmount';
import { mockMatchMedia } from '@/test/match-media';
import { renderWithProviders } from '@/test/render';

describe('CountUpAmount', () => {
  beforeEach(() => {
    // Reduced motion makes useCountUp return the target instantly, so the
    // assertions do not need to fake animation frames.
    mockMatchMedia(true);
  });

  it('renders the final formatted amount and exposes it as the aria-label', () => {
    const { getByLabelText, getByText } = renderWithProviders(
      <CountUpAmount amount={1234.56} variant="income" />,
    );

    expect(getByLabelText('R$ 1.234,56')).toBeInTheDocument();
    expect(getByText(/1\.234,56/)).toBeInTheDocument();
  });

  it('keeps AmountDisplay sign semantics and a signed aria-label for negatives', () => {
    const { getByLabelText, getByText } = renderWithProviders(
      <CountUpAmount amount={-200} showSign />,
    );

    expect(getByText(/-.*200,00/)).toBeInTheDocument();
    expect(getByLabelText('-R$ 200,00')).toBeInTheDocument();
  });

  it('keeps AmountDisplay sign semantics and a signed aria-label for positives', () => {
    const { getByLabelText, getByText } = renderWithProviders(
      <CountUpAmount amount={200} showSign />,
    );

    expect(getByText(/\+.*200,00/)).toBeInTheDocument();
    expect(getByLabelText('+R$ 200,00')).toBeInTheDocument();
  });
});
