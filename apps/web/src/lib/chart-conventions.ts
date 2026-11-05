/**
 * Shared recharts conventions so every chart reads as one system:
 * - CHART_ANIMATION: series animation aligned with --dur-base; pair it with
 *   isAnimationActive={!usePrefersReducedMotion()} at the call site.
 * - ZERO_LINE: the y=0 reference (overdraft boundary) — dashed, expense color.
 * - referenceBandProps: labelled dashed bands (average income, savings goal).
 */
export const CHART_ANIMATION = {
  animationDuration: 220,
  animationEasing: 'ease-out',
} as const;

export const ZERO_LINE = {
  stroke: 'var(--color-expense)',
  strokeDasharray: '3 3',
} as const;

export function referenceBandProps(label: string) {
  return {
    stroke: 'var(--color-muted-foreground)',
    strokeDasharray: '6 4',
    strokeWidth: 1.5,
    label: {
      value: label,
      position: 'insideTopRight',
      fill: 'var(--color-muted-foreground)',
      fontSize: 11,
    },
  } as const;
}
