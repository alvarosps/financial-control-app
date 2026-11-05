'use client';

import { ArrowLeft, Edit2, FileText, Plus, PowerOff, Users } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/shared/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

type Props = {
  accountName: string;
  showAddMenu: boolean;
  onToggleAddMenu: () => void;
  onEdit: () => void;
  onMonthlyReport: () => void;
  onDeactivate: () => void;
  onAddCard: () => void;
  onAddInstallment: () => void;
  onAddFixed: () => void;
  onAddOneTimeCharge: () => void;
  onRecordPayment: () => void;
  onAddDiscount: () => void;
};

export function FamilyLoanActionsBar({
  accountName,
  showAddMenu,
  onToggleAddMenu,
  onEdit,
  onMonthlyReport,
  onDeactivate,
  onAddCard,
  onAddInstallment,
  onAddFixed,
  onAddOneTimeCharge,
  onRecordPayment,
  onAddDiscount,
}: Props) {
  const t = useTranslations();
  return (
    <div className="space-y-4">
      <Link href="/family-loans">
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('components-family-loans-detail-familyloanactionsbar.back')}
        >
          <ArrowLeft className="size-4" />{' '}
          {t('components-family-loans-detail-familyloanactionsbar.back')}
        </Button>
      </Link>

      <PageHeader
        title={accountName}
        subtitle={t('components-family-loans-detail-familyloanactionsbar.familyLoan')}
        actions={
          <div className="flex items-center gap-2 overflow-x-auto flex-wrap">
            <Button variant="outline" size="sm" onClick={onEdit}>
              <Edit2 className="size-3.5" />{' '}
              {t('components-family-loans-detail-familyloanactionsbar.edit')}
            </Button>
            <Button variant="outline" size="sm" onClick={onMonthlyReport}>
              <FileText className="size-3.5" />{' '}
              {t('components-family-loans-detail-familyloanactionsbar.monthlyReport')}
            </Button>
            <Button variant="destructive" size="sm" onClick={onDeactivate}>
              <PowerOff className="size-3.5" />{' '}
              {t('components-family-loans-detail-familyloanactionsbar.deactivate')}
            </Button>
            <Button variant="outline" size="sm" onClick={onToggleAddMenu}>
              <Plus className="size-3.5" />
              {showAddMenu ? t('common.close') : t('common.add')}
            </Button>
          </div>
        }
      />

      <div className="flex items-center gap-2 flex-wrap">
        <Users className="size-4 text-muted-foreground" />
        <Badge variant="income" role="status">
          {t('components-family-loans-detail-familyloanactionsbar.active')}
        </Badge>
        <span className="text-sm text-muted-foreground">
          {t('components-family-loans-detail-familyloanactionsbar.personalCharge')}
        </span>
      </div>

      {/* Collapsible add actions */}
      {showAddMenu && (
        <div className="flex flex-wrap gap-2 rounded-lg border border-glass-border bg-surface-elevated p-3">
          <Button size="sm" onClick={onAddCard}>
            <Plus className="size-3.5" />{' '}
            {t('components-family-loans-detail-familyloanactionsbar.card')}
          </Button>
          <Button variant="outline" size="sm" onClick={onAddInstallment}>
            <Plus className="size-3.5" />{' '}
            {t('components-family-loans-detail-familyloanactionsbar.installment')}
          </Button>
          <Button variant="outline" size="sm" onClick={onAddFixed}>
            <Plus className="size-3.5" />{' '}
            {t('components-family-loans-detail-familyloanactionsbar.fixedCharge')}
          </Button>
          <Button variant="outline" size="sm" onClick={onAddOneTimeCharge}>
            <Plus className="size-3.5" />{' '}
            {t('components-family-loans-detail-familyloanactionsbar.oneTimeCharge')}
          </Button>
          <Button variant="outline" size="sm" onClick={onRecordPayment}>
            <Plus className="size-3.5" />{' '}
            {t('components-family-loans-detail-familyloanactionsbar.recordPayment')}
          </Button>
          <Button variant="outline" size="sm" onClick={onAddDiscount}>
            <Plus className="size-3.5" />{' '}
            {t('components-family-loans-detail-familyloanactionsbar.discount')}
          </Button>
        </div>
      )}
    </div>
  );
}
