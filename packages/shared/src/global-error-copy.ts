/**
 * Static pt-BR copy for the Next.js root `global-error` boundary.
 *
 * The root global-error component replaces the application's root layout, so
 * the next-intl provider context is unavailable and translations cannot be
 * resolved. This is the documented exception to the i18n rule: the strings are
 * UI copy that intentionally lives outside `apps/web/src` because the locale
 * machinery is not reachable from that render path. Keep them in pt-BR (the
 * default app locale).
 */
export const GLOBAL_ERROR_COPY = {
  title: 'Erro na aplicação',
  description: 'Ocorreu um erro inesperado.',
  retry: 'Tentar novamente',
} as const;
