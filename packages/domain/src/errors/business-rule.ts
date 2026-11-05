/**
 * Thrown when an operation is rejected because a domain business rule forbids
 * it in the current state — not a data-corruption signal (that's
 * `InvariantViolationError`), but a predictable "you can't do that right now"
 * outcome the caller should surface to the user. Mapped to tRPC
 * `BAD_REQUEST` at the API boundary.
 */
export class BusinessRuleError extends Error {
  readonly code = 'BUSINESS_RULE' as const;
  constructor(
    message: string,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'BusinessRuleError';
  }
}
