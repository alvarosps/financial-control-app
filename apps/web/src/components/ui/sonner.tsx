'use client';

import { useTheme } from 'next-themes';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

export function Toaster(props: ToasterProps) {
  const { resolvedTheme } = useTheme();
  const theme: ToasterProps['theme'] =
    resolvedTheme === 'dark' || resolvedTheme === 'light' ? resolvedTheme : 'system';

  return <Sonner theme={theme} richColors closeButton {...props} />;
}
