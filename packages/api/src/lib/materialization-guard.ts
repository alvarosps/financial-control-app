export type { MaterializationGuard } from '../services/materialization-guard.service.ts';

export interface MaterializationGuardLike {
  ensureMaterialized(userId: string, targetMonth: number, targetYear: number): Promise<void>;
}

export const noOpGuard: MaterializationGuardLike = {
  ensureMaterialized: async () => {},
};
