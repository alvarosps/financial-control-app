import { describe, expect, it } from 'vitest';
import { ChartSkeleton } from '@/components/shared/ChartSkeleton';
import { renderWithProviders } from '@/test/render';

describe('ChartSkeleton', () => {
  it('gates placeholder animation behind motion-safe', () => {
    const { container } = renderWithProviders(<ChartSkeleton />);
    const animatedPlaceholders = [...container.querySelectorAll('[class*="animate-pulse"]')];

    expect(animatedPlaceholders).toHaveLength(7);
    for (const placeholder of animatedPlaceholders) {
      expect(placeholder.classList).toContain('motion-safe:animate-pulse');
      expect(placeholder.classList).not.toContain('animate-pulse');
    }
  });
});
