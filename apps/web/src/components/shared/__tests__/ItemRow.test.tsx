import { describe, expect, it } from 'vitest';
import { ItemRow } from '@/components/shared/ItemRow';
import { renderWithProviders } from '@/test/render';

describe('ItemRow token usage', () => {
  it('uses the glass-border divider token', () => {
    const { container } = renderWithProviders(<ItemRow name="Strada" amount={1531} />);
    expect((container.firstChild as HTMLElement).className).toContain('border-glass-border');
  });

  it('progress bar fill uses the income token', () => {
    const { container } = renderWithProviders(
      <ItemRow name="Strada" amount={1531} progress={{ current: 18, total: 351 }} />,
    );
    expect(container.querySelector('.bg-income')).not.toBeNull();
    // the % label uses the income token too
    expect(container.querySelector('.text-income')).not.toBeNull();
  });
});
