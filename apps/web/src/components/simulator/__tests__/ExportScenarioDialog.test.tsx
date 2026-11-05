import type { SimScenario } from '@fc/shared';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '@/lib/simulator/export-types';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import { ExportScenarioDialog } from '../ExportScenarioDialog';

const RUN: RunResult = {
  anchorCash: 1000,
  openingBalance: 1000,
  baseline: [],
  simulated: [],
  kpis: { openingNow: 1000, endingBaseline: 1300, endingSimulated: 1500, delta: 200 },
  alerts: {
    firstNegativeMonthBaseline: null,
    firstNegativeMonthSimulated: null,
    troughBaseline: { month: 6, year: 2026, balance: 1300 },
    troughSimulated: { month: 6, year: 2026, balance: 1500 },
  },
  forecast: [],
  assumptions: {
    familyReceiptPercent: 100,
    horizon: 2,
    anchorSource: 'wallet_cash',
    openingBalanceOverridden: false,
    asOf: '2026-06-16',
    currency: 'BRL',
  },
};

const SCENARIO: SimScenario = { name: 'Plano A', horizon: 2, levers: [] };

const writeText = vi.fn().mockResolvedValue(undefined);

// `userEvent.setup()` installs its own `navigator.clipboard` stub, so we must
// (re-)define ours *after* setup runs inside each test, not just in beforeEach.
function stubClipboard() {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

beforeEach(() => {
  stubClipboard();
  // jsdom has no object-URL impl; stub so Download wiring is exercisable.
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ExportScenarioDialog', () => {
  it('copies the active tab content to the clipboard', async () => {
    const user = userEvent.setup();
    // Re-assert our stub: userEvent.setup() replaces navigator.clipboard.
    stubClipboard();
    renderWithProviders(
      <ExportScenarioDialog run={RUN} scenario={SCENARIO} open onOpenChange={() => {}} />,
    );

    // Markdown is the default tab; its body should mention the scenario name.
    await waitFor(() => expect(screen.getByText(/Plano A/)).toBeTruthy());

    const copyBtn = screen.getByRole('button', { name: /copiar|copy/i });
    await user.click(copyBtn);

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toContain('Plano A');
  });

  it('triggers a download with the correct file extension per tab', async () => {
    const user = userEvent.setup();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderWithProviders(
      <ExportScenarioDialog run={RUN} scenario={SCENARIO} open onOpenChange={() => {}} />,
    );

    const downloadBtn = screen.getByRole('button', { name: /baixar|download/i });
    await user.click(downloadBtn);

    await waitFor(() => expect(globalThis.URL.createObjectURL).toHaveBeenCalled());
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });
});
