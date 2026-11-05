/**
 * Thrown when a tenant-scoped lookup or write targets a row that either does
 * not exist or does not belong to the acting user. Mapped to tRPC NOT_FOUND
 * in the API layer so IDOR probes cannot distinguish between the two cases.
 */
export class NotFoundError extends Error {
  readonly code = 'NOT_FOUND' as const;
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}
