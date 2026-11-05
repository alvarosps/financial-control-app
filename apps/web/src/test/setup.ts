import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { server } from './msw-server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const TEST_ELEMENT_WIDTH = 800;
const TEST_ELEMENT_HEIGHT = 400;

function parseCssPixelValue(value: string, fallback: number) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function testRectFor(element: Element) {
  const htmlElement = element as HTMLElement;
  const width = parseCssPixelValue(htmlElement.style.width, TEST_ELEMENT_WIDTH);
  const height = parseCssPixelValue(htmlElement.style.height, TEST_ELEMENT_HEIGHT);

  return {
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

// Only mock browser APIs (external boundaries):
class ResizeObserverStub implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element) {
    this.callback([{ target, contentRect: testRectFor(target) } as ResizeObserverEntry], this);
  }

  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

if (typeof window !== 'undefined') {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return parseCssPixelValue(this.style.width, TEST_ELEMENT_WIDTH);
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return parseCssPixelValue(this.style.height, TEST_ELEMENT_HEIGHT);
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return parseCssPixelValue(this.style.width, TEST_ELEMENT_WIDTH);
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return parseCssPixelValue(this.style.height, TEST_ELEMENT_HEIGHT);
    },
  });
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return testRectFor(this);
  };

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
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
