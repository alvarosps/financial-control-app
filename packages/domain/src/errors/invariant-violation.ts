/**
 * Thrown when code detects data violating a domain invariant that cannot be
 * recovered from automatically — e.g., a schedule with starting_occurrence
 * other than 1. Fail-fast; caller should surface a clear error to the user
 * and flag the data for manual correction.
 */
export class InvariantViolationError extends Error {
  constructor(
    message: string,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'InvariantViolationError';
  }
}
