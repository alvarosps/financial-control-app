'use client';

import { ChevronDown, ChevronRight, ClipboardList } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useMemo, useState } from 'react';
import { EmptyState } from '@/components/shared/EmptyState';
import { FilterTabs } from '@/components/shared/FilterTabs';
import { PageHeader } from '@/components/shared/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { type ColumnDef, DataTable } from '@/components/ui/data-table';
import { Skeleton } from '@/components/ui/skeleton';
import { usePageTitle } from '@/hooks/usePageTitle';
import { skeletonKeys } from '@/lib/skeleton-keys';
import { trpc } from '@/lib/trpc/client';

const ENTITY_TYPES = [
  'account',
  'category',
  'credit_card',
  'family_loan',
  'income',
  'loan',
  'scheduled_transaction',
  'transaction',
] as const;

type EntityType = (typeof ENTITY_TYPES)[number];

function isEntityType(value: string): value is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(value);
}

type BadgeVariant = NonNullable<Parameters<typeof Badge>[0]['variant']>;

const ACTION_VARIANT: Record<string, BadgeVariant> = {
  create: 'income',
  update: 'warning',
  delete: 'expense',
};

type AuditLogRow = {
  id: string;
  createdAt: string | Date;
  action: string;
  entityType: string;
  previousData: unknown;
  newData: unknown;
};

function JsonBlock({ data, label }: { data: unknown; label: string }) {
  const [expanded, setExpanded] = useState(false);

  if (data == null) return null;

  return (
    <div>
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 h-7 gap-1 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {label}
      </Button>
      {expanded && (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-elevated p-2 text-xs">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}

function AuditLogSkeleton() {
  return (
    <div className="space-y-2">
      {skeletonKeys(8).map((key) => (
        <Skeleton key={key} className="h-16 w-full rounded-xl" />
      ))}
    </div>
  );
}

export function AuditLogClient() {
  const locale = useLocale();
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone: 'America/Sao_Paulo',
      }),
    [locale],
  );
  const t = useTranslations();
  const tEntityType = useTranslations('auditLog.entityTypes');
  usePageTitle(t('pageTitles.auditLog'));
  const [entityTypeFilter, setEntityTypeFilter] = useState<string>('all');
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const { data, isLoading, error } = trpc.auditLog.list.useQuery({
    entityType: entityTypeFilter !== 'all' ? entityTypeFilter : undefined,
    page,
    pageSize,
  });

  function handleFilterChange(value: string) {
    setEntityTypeFilter(value);
    setPage(1);
  }

  const entityTypeLabel = useCallback(
    (entityType: string): string =>
      isEntityType(entityType) ? tEntityType(entityType) : entityType,
    [tEntityType],
  );

  const columns: ColumnDef<AuditLogRow>[] = useMemo(
    () => [
      {
        accessorKey: 'createdAt',
        header: t('auditLog.columns.timestamp'),
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-muted-foreground">
            {dateFormatter.format(new Date(row.original.createdAt))}
          </span>
        ),
        sortingFn: (a, b) =>
          new Date(a.original.createdAt).getTime() - new Date(b.original.createdAt).getTime(),
      },
      {
        accessorKey: 'entityType',
        header: t('auditLog.columns.entity'),
        enableSorting: false,
        cell: ({ row }) => (
          <Badge variant="outline" className="text-xs">
            {entityTypeLabel(row.original.entityType)}
          </Badge>
        ),
      },
      {
        accessorKey: 'action',
        header: t('auditLog.columns.action'),
        enableSorting: false,
        cell: ({ row }) => (
          <Badge variant={ACTION_VARIANT[row.original.action] ?? 'secondary'} className="text-xs">
            {row.original.action}
          </Badge>
        ),
      },
      {
        id: 'details',
        header: t('auditLog.columns.details'),
        enableSorting: false,
        cell: ({ row }) => {
          const { previousData, newData } = row.original;
          if (previousData == null && newData == null) {
            return <span className="text-xs text-muted-foreground">—</span>;
          }
          return (
            <div className="space-y-1">
              <JsonBlock
                data={previousData}
                label={`${t('auditLog.details.previous')} · ${t('auditLog.details.view')}`}
              />
              <JsonBlock
                data={newData}
                label={`${t('auditLog.details.new')} · ${t('auditLog.details.view')}`}
              />
            </div>
          );
        },
      },
    ],
    [t, entityTypeLabel, dateFormatter],
  );

  const filterTabs = useMemo(
    () => [
      { key: 'all', label: t('auditLog.filterAll') },
      ...ENTITY_TYPES.map((entityType) => ({ key: entityType, label: tEntityType(entityType) })),
    ],
    [t, tEntityType],
  );

  return (
    <div className="space-y-6">
      <PageHeader title={t('auditLog.title')} subtitle={t('auditLog.subtitle')} />

      <FilterTabs
        tabs={filterTabs}
        value={entityTypeFilter}
        onValueChange={handleFilterChange}
        className="flex-wrap"
      />

      {isLoading && <AuditLogSkeleton />}

      {error && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {t('auditLog.loadError')} {error.message}
        </div>
      )}

      {data && data.items.length === 0 && (
        <EmptyState
          icon={<ClipboardList className="h-12 w-12" />}
          title={t('auditLog.noRecords')}
        />
      )}

      {data && data.items.length > 0 && (
        <>
          <DataTable
            columns={columns}
            data={data.items as AuditLogRow[]}
            emptyMessage={t('auditLog.noRecords')}
          />

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {data.total}{' '}
              {data.total === 1
                ? t('auditLog.pagination.record')
                : t('auditLog.pagination.records')}{' '}
              {t('auditLog.pagination.page')} {data.page} {t('auditLog.pagination.of')}{' '}
              {data.totalPages}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                {t('auditLog.pagination.previous')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= data.totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                {t('auditLog.pagination.next')}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
