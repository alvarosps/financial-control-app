import type { UseMutationResult } from '@tanstack/react-query';

export function useMutationFormGuard(mutation: Pick<UseMutationResult, 'isPending'>) {
  const isPending = mutation.isPending;
  return {
    isPending,
    fieldsetProps: {
      disabled: isPending,
      'aria-busy': isPending,
    } as const,
    submitProps: {
      disabled: isPending,
      'aria-busy': isPending,
    } as const,
    formProps: {
      'aria-busy': isPending,
    } as const,
  };
}
