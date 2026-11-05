'use client';

import {
  ArrowDownCircle,
  ArrowUpCircle,
  MoreVertical,
  Pencil,
  Plus,
  Sparkles,
  Tag,
  Trash2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { AddCategoryDialog } from '@/components/categories/AddCategoryDialog';
import { DeleteCategoryDialog } from '@/components/categories/DeleteCategoryDialog';
import { EditCategoryDialog } from '@/components/categories/EditCategoryDialog';
import { EmptyState } from '@/components/shared/EmptyState';
import { FilterTabs } from '@/components/shared/FilterTabs';
import { PageHeader } from '@/components/shared/PageHeader';
import { SkeletonCard } from '@/components/shared/SkeletonCard';
import { StatCard } from '@/components/shared/StatCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { usePageTitle } from '@/hooks/usePageTitle';
import { skeletonKeys } from '@/lib/skeleton-keys';
import { trpc } from '@/lib/trpc/client';

type Category = {
  id: string;
  name: string;
  type: string;
  icon?: string | null;
  color?: string | null;
  isSystem: boolean;
};

type CategoryFilter = 'all' | 'expense' | 'revenue';

export function CategoriesClient() {
  const t = useTranslations();
  usePageTitle(t('categories.title'));

  const { data: rawData, isLoading, error } = trpc.category.list.useQuery();
  const data = (rawData ?? []) as Category[];

  const [filter, setFilter] = useState<CategoryFilter>('all');
  const [showAdd, setShowAdd] = useState(false);
  const [editCategory, setEditCategory] = useState<Category | null>(null);
  const [deleteCategory, setDeleteCategory] = useState<Category | null>(null);

  const { expense, revenue, customCount } = useMemo(() => {
    const expenseList = data.filter((c) => c.type === 'expense');
    const revenueList = data.filter((c) => c.type === 'revenue');
    return {
      expense: expenseList,
      revenue: revenueList,
      customCount: data.filter((c) => !c.isSystem).length,
    };
  }, [data]);

  const filtered = filter === 'expense' ? expense : filter === 'revenue' ? revenue : data;

  if (error) {
    return (
      <div className="text-expense">
        {t('common.error')}: {error.message}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('categories.title')}
        subtitle={t('categories.subtitle')}
        actions={
          <Button variant="brand" size="sm" onClick={() => setShowAdd(true)}>
            <Plus className="size-4" /> {t('common.add')}
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          tone="expense"
          label={t('categories.stats.expenseCount')}
          value={expense.length}
          icon={<ArrowDownCircle className="size-4" />}
        />
        <StatCard
          tone="income"
          label={t('categories.stats.revenueCount')}
          value={revenue.length}
          icon={<ArrowUpCircle className="size-4" />}
        />
        <StatCard
          tone="neutral"
          label={t('categories.stats.customCount')}
          value={customCount}
          icon={<Sparkles className="size-4" />}
        />
      </div>

      {data.length > 0 && (
        <FilterTabs
          tabs={[
            { key: 'all', label: t('categories.filters.all'), count: data.length },
            {
              key: 'expense',
              label: t('categories.filters.expense'),
              count: expense.length,
              icon: <ArrowDownCircle className="size-3.5" />,
            },
            {
              key: 'revenue',
              label: t('categories.filters.revenue'),
              count: revenue.length,
              icon: <ArrowUpCircle className="size-3.5" />,
            },
          ]}
          value={filter}
          onValueChange={(key) => setFilter(key as CategoryFilter)}
        />
      )}

      {isLoading && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {skeletonKeys(8).map((key) => (
            <SkeletonCard key={key} />
          ))}
        </div>
      )}

      {rawData && data.length === 0 && (
        <EmptyState
          icon={<Tag className="size-12" />}
          title={t('categories.noCategories')}
          description={t('categories.noCategoriesDesc')}
          action={
            <Button variant="brand" onClick={() => setShowAdd(true)}>
              <Plus className="size-4" /> {t('common.add')}
            </Button>
          }
        />
      )}

      {filtered.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {filtered.map((category) => (
            <Card key={category.id} surface="solid">
              <CardContent className="flex items-center gap-2 py-3">
                <span
                  className="size-3 shrink-0 rounded-full"
                  style={{ backgroundColor: category.color ?? 'var(--muted-foreground)' }}
                />
                <span className="text-lg">{category.icon ?? '📁'}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{category.name}</p>
                  {category.isSystem && (
                    <Badge variant="secondary" className="px-1 py-0 text-[10px]">
                      {t('categories.system')}
                    </Badge>
                  )}
                </div>
                {!category.isSystem && (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button variant="ghost" size="icon-sm" aria-label={category.name}>
                          <MoreVertical className="size-4" />
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setEditCategory(category)}>
                        <Pencil className="size-4" /> {t('common.edit')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => setDeleteCategory(category)}
                      >
                        <Trash2 className="size-4" /> {t('common.delete')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <AddCategoryDialog open={showAdd} onOpenChange={setShowAdd} />
      <EditCategoryDialog
        open={editCategory !== null}
        onOpenChange={(open) => {
          if (!open) setEditCategory(null);
        }}
        category={editCategory}
      />
      <DeleteCategoryDialog
        open={deleteCategory !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteCategory(null);
        }}
        category={deleteCategory}
      />
    </div>
  );
}
