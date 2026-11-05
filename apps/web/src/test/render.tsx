import { type RenderOptions, render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement, ReactNode } from 'react';
import rawPtMessages from '@/i18n/messages/pt-BR.json';

// Production app wraps codemod-extracted keys under `extracted.`, but
// components call `t('components-…-hash')` at the top level. For test
// purposes we lift the `extracted` namespace so `useTranslations()` can
// resolve keys without needing the real app's namespace strategy.
// Extracted keys are stored flat ("namespace-hyphen-form.hash"); next-intl's
// `t('ns.key')` lookup requires nested objects though, so we rehydrate them
// into `{ [namespace]: { [hash]: value } }` form for test rendering. This
// mirrors what a finalized i18n pipeline would emit and keeps tests decoupled
// from the production app's evolving key-storage strategy.
const rawExtracted = (rawPtMessages as Record<string, unknown>).extracted ?? {};
const nestedExtracted: Record<string, Record<string, string>> = {};
for (const [flatKey, value] of Object.entries(rawExtracted as Record<string, string>)) {
  const dot = flatKey.indexOf('.');
  if (dot === -1) continue;
  const ns = flatKey.slice(0, dot);
  const leaf = flatKey.slice(dot + 1);
  if (!nestedExtracted[ns]) nestedExtracted[ns] = {};
  nestedExtracted[ns][leaf] = value;
}
const { extracted: _extracted, ...rest } = rawPtMessages as Record<string, unknown>;
const ptMessages = { ...rest, ...nestedExtracted };

type Messages = typeof ptMessages;

type ProvidersProps = {
  children: ReactNode;
  locale?: string;
  messages?: Messages;
};

function AllProviders({ children, locale = 'pt-BR', messages = ptMessages }: ProvidersProps) {
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={messages}
      // Swallow missing-key errors; tests should not fail on unrelated
      // translation gaps (parity test covers coverage completeness).
      onError={() => {}}
      getMessageFallback={({ key }) => key}
    >
      {children}
    </NextIntlClientProvider>
  );
}

export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'> & { locale?: string; messages?: Messages },
) {
  const { locale, messages, ...rtlOptions } = options ?? {};
  return render(ui, {
    wrapper: ({ children }) => (
      <AllProviders locale={locale} messages={messages}>
        {children}
      </AllProviders>
    ),
    ...rtlOptions,
  });
}

export * from '@testing-library/react';
