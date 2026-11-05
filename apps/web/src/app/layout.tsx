import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { GlobalErrorBoundary } from '@/components/GlobalErrorBoundary';
import { Toaster } from '@/components/ui/sonner';
import { ThemeProvider } from '@/lib/providers/ThemeProvider';
import { TRPCProvider } from '@/lib/trpc/provider';
import './globals.css';
import { Geist, Geist_Mono, Space_Grotesk } from 'next/font/google';
import { cn } from '@/lib/utils';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });
const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-heading',
  display: 'swap',
});
const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-numeric',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Financial Control',
  description: 'Personal finance management with double-entry bookkeeping',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Financial Control',
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fafafc' },
    { media: '(prefers-color-scheme: dark)', color: '#15141f' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  return (
    <html
      lang={locale}
      className={cn('font-sans', geist.variable, spaceGrotesk.variable, geistMono.variable)}
      suppressHydrationWarning
    >
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <GlobalErrorBoundary>
            <ThemeProvider>
              <TRPCProvider>{children}</TRPCProvider>
              <Toaster />
            </ThemeProvider>
          </GlobalErrorBoundary>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
