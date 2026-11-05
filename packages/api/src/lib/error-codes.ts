/**
 * Stable error-code contract for tRPC errors.
 *
 * Every TRPCError (or domain error whose `meta` carries an `i18nKey`) should
 * use `errorCause(code, extras?)` to attach a structured `cause` containing:
 *   - `i18nKey`: the translation key the web client will look up
 *   - `code`: the stable machine code (for logging / analytics)
 *   - any `extras` the caller wants to forward (e.g. `cardAccountId`)
 *
 * The tRPC server's `errorFormatter` mirrors `i18nKey` + `code` onto the wire
 * `data` payload so the browser's `resolveTRPCError()` can translate without
 * relying on the raw server `message` (which may be English or Portuguese).
 */
export const ERROR_CODES = [
  'auth.invalidSession',
  'auth.notAuthenticated',
  'rateLimited',
  'server.busy',
  'server.unexpected',
  'financial.periodClosed',
  'bill.alreadyPaid',
  'bill.nothingToPay',
  'bill.mixedCurrency',
  'bill.invalidPaymentWallet',
  'bill.paymentRepairRequired',
  'domain.invariantViolation',
  'validation.generic',
  'validation.startingOccurrence',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type ErrorCause = {
  i18nKey: `errors.${ErrorCode}`;
  code: ErrorCode;
} & Record<string, unknown>;

export function errorCause(code: ErrorCode, extras?: Record<string, unknown>): ErrorCause {
  return { ...extras, i18nKey: `errors.${code}`, code };
}
