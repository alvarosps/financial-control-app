import type { ReactElement } from 'react';
import { renderWithProviders } from './render';
import { TRPCTestProvider } from './trpc';

export function renderDialog(ui: ReactElement) {
  return renderWithProviders(<TRPCTestProvider>{ui}</TRPCTestProvider>);
}
