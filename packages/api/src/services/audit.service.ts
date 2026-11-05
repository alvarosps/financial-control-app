import type { DbExecutor } from '@fc/db';
import { auditLog } from '@fc/db';

export class AuditService {
  constructor(private db: DbExecutor) {}

  async log(
    userId: string,
    action: string,
    entityType: string,
    entityId?: string,
    previousData?: unknown,
    newData?: unknown,
  ) {
    await this.db.insert(auditLog).values({
      userId,
      action,
      entityType,
      ...(entityId !== undefined && { entityId }),
      ...(previousData !== undefined && { previousData }),
      ...(newData !== undefined && { newData }),
    });
  }
}
