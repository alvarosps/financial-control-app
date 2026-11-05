/**
 * Overrides the jsdom matchMedia stub (see setup.ts) so a test can simulate
 * prefers-reduced-motion. Browser API = external boundary, mocking allowed.
 */
export function mockMatchMedia(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
