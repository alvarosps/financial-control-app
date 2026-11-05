const cardWriteContextBrand = Symbol('card-write-context');

export type CardWriteContext = {
  readonly userId: string;
  readonly [cardWriteContextBrand]: true;
};

/**
 * Capability minted only by card flows after acquiring their transaction locks.
 * Its symbol brand prevents generic routers from forging the required input.
 */
export function createCardWriteContext(userId: string): CardWriteContext {
  return { userId, [cardWriteContextBrand]: true };
}

export function assertCardWriteContext(context: CardWriteContext, userId: string): void {
  if (context.userId !== userId || context[cardWriteContextBrand] !== true) {
    throw new Error('Invalid card write context');
  }
}
