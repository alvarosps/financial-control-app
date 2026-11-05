'use client';

import type { LoanPaymentMethod } from '@fc/shared';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { dateInputToDate, todayLocalISO } from '@/lib/dates';
import { invalidateLoanContext } from '@/lib/invalidate';
import { toMoneyInputString } from '@/lib/money';
import { trpc } from '@/lib/trpc/client';
import { resolveTRPCError } from '@/lib/trpc-errors';
import { toArray } from '@/lib/utils';
import { LoanPaymentMethodFields } from './LoanPaymentMethodFields';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function AddLoanDialog({ open, onOpenChange }: Props) {
  const t = useTranslations('components-loans-addloandialog');
  const tGlobal = useTranslations();
  const [name, setName] = useState('');
  const [loanCategory, setLoanCategory] = useState<'bank' | 'personal'>('bank');
  const [loanType, setLoanType] = useState<'consignado' | 'pessoal' | 'veiculo' | 'imobiliario'>(
    'pessoal',
  );
  const [monthlyPayment, setMonthlyPayment] = useState('');
  const [totalInstallments, setTotalInstallments] = useState('');
  // Empty by default: the backend derives the current installment from the
  // first-installment date. Filling it in overrides that (0/negative allowed).
  const [currentInstallment, setCurrentInstallment] = useState('');
  const [dueDay, setDueDay] = useState('');
  const [startDate, setStartDate] = useState(() => todayLocalISO());
  const [checkingAccountId, setCheckingAccountId] = useState('');
  const [monthlyInterestRate, setMonthlyInterestRate] = useState('');
  const [annualInterestRate, setAnnualInterestRate] = useState('');
  const [insuranceAmount, setInsuranceAmount] = useState('');
  const [insurancePaymentDay, setInsurancePaymentDay] = useState('');
  const [payoffCalculationType, setPayoffCalculationType] = useState<
    'sem_desconto' | 'consignado_mensal' | 'pessoal_diario' | 'cdc_veiculos'
  >('sem_desconto');
  const [principalAmount, setPrincipalAmount] = useState('');
  const [originalAmount, setOriginalAmount] = useState('');
  const [comment, setComment] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<LoanPaymentMethod | null>(null);
  const [incomeSourceAccountId, setIncomeSourceAccountId] = useState<string | null>(null);

  const utils = trpc.useUtils();
  const createMutation = trpc.loan.create.useMutation();
  const isPending = createMutation.isPending;
  const { data: rawAccounts } = trpc.account.list.useQuery();
  const checkingAccounts = toArray(rawAccounts).filter(
    (a) => (a.type === 'checking' || a.type === 'savings') && a.isActive,
  );

  function resetForm() {
    setName('');
    setLoanCategory('bank');
    setLoanType('pessoal');
    setMonthlyPayment('');
    setTotalInstallments('');
    setCurrentInstallment('');
    setDueDay('');
    setStartDate(todayLocalISO());
    setCheckingAccountId('');
    setMonthlyInterestRate('');
    setAnnualInterestRate('');
    setInsuranceAmount('');
    setInsurancePaymentDay('');
    setPayoffCalculationType('sem_desconto');
    setPrincipalAmount('');
    setOriginalAmount('');
    setComment('');
    setPaymentMethod(null);
    setIncomeSourceAccountId(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (
      !name.trim() ||
      !monthlyPayment ||
      !totalInstallments ||
      !dueDay ||
      !startDate ||
      !checkingAccountId ||
      !monthlyInterestRate
    ) {
      toast.error(t('fillRequired'));
      return;
    }

    const payParsed = toMoneyInputString(monthlyPayment);
    if (!payParsed) {
      toast.error(t('invalidPayment'));
      return;
    }

    try {
      // 1. Prepare interest rate (convert e.g. "1.5" percentage into decimal "0.015" for standard DB storage)
      const interestVal = parseFloat(monthlyInterestRate);
      const monthlyRateDecimal = (interestVal / 100).toString();

      let annualRateDecimal: string | undefined;
      if (annualInterestRate) {
        annualRateDecimal = (parseFloat(annualInterestRate) / 100).toString();
      }

      // 2. Prepare optional money strings
      const insParsed = insuranceAmount ? toMoneyInputString(insuranceAmount) : undefined;
      const princParsed = principalAmount ? toMoneyInputString(principalAmount) : undefined;
      const origParsed = originalAmount ? toMoneyInputString(originalAmount) : undefined;

      // 3. Create Loan
      await createMutation.mutateAsync({
        name: name.trim(),
        loanCategory,
        ...(paymentMethod ? { paymentMethod, incomeSourceAccountId } : {}),
        loanType: loanCategory === 'bank' ? loanType : 'pessoal',
        monthlyPayment: payParsed,
        totalInstallments: parseInt(totalInstallments, 10),
        // Only send when the user overrode it; otherwise the backend derives it
        // from the first-installment date.
        ...(currentInstallment.trim() !== '' &&
          Number.isFinite(parseInt(currentInstallment, 10)) && {
            currentInstallment: parseInt(currentInstallment, 10),
          }),
        dueDay: parseInt(dueDay, 10),
        startDate: dateInputToDate(startDate),
        checkingAccountId,
        monthlyInterestRate: monthlyRateDecimal,
        ...(annualRateDecimal && { annualInterestRate: annualRateDecimal }),
        ...(insParsed && { insuranceAmount: insParsed }),
        ...(insurancePaymentDay && { insurancePaymentDay: parseInt(insurancePaymentDay, 10) }),
        payoffCalculationType,
        ...(princParsed && { principalAmount: princParsed }),
        ...(origParsed && { originalAmount: origParsed }),
        ...(comment.trim() && { comment: comment.trim() }),
      });

      toast.success(t('saveSuccess'));
      await invalidateLoanContext(utils);
      resetForm();
      onOpenChange(false);
    } catch (error) {
      toast.error(resolveTRPCError(error, tGlobal));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (isPending) return;
        if (!v) resetForm();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <fieldset disabled={isPending} className="contents">
            <div className="grid grid-cols-2 gap-4">
              {/* Category */}
              <div className="space-y-2">
                <Label htmlFor="loan-category">{t('category')}</Label>
                <Select
                  value={loanCategory}
                  onValueChange={(val) => setLoanCategory(val as 'bank' | 'personal')}
                >
                  <SelectTrigger id="loan-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bank">{t('bank')}</SelectItem>
                    <SelectItem value="personal">{t('personal')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Loan Type */}
              {loanCategory === 'bank' && (
                <div className="space-y-2">
                  <Label htmlFor="loan-type">{t('loanType')}</Label>
                  <Select
                    value={loanType}
                    onValueChange={(val) =>
                      setLoanType(val as 'consignado' | 'pessoal' | 'veiculo' | 'imobiliario')
                    }
                  >
                    <SelectTrigger id="loan-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pessoal">{t('typePessoal')}</SelectItem>
                      <SelectItem value="consignado">{t('typeConsignado')}</SelectItem>
                      <SelectItem value="veiculo">{t('typeVeiculo')}</SelectItem>
                      <SelectItem value="imobiliario">{t('typeImobiliario')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            {/* Name */}
            <div className="space-y-2">
              <Label htmlFor="loan-name">{t('loanName')}</Label>
              <Input
                id="loan-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('loanNamePlaceholder')}
                required
              />
            </div>

            {/* Payment values */}
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="loan-payment">{t('monthlyPayment')}</Label>
                <Input
                  id="loan-payment"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={monthlyPayment}
                  onChange={(e) => setMonthlyPayment(e.target.value)}
                  placeholder="0,00"
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="loan-current-inst">{t('currentInstallment')}</Label>
                <Input
                  id="loan-current-inst"
                  type="number"
                  step="1"
                  value={currentInstallment}
                  onChange={(e) => setCurrentInstallment(e.target.value)}
                  placeholder={t('currentInstallmentPlaceholder')}
                />
                <p className="text-xs text-muted-foreground">{t('currentInstallmentHint')}</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="loan-total-inst">{t('totalInstallments')}</Label>
                <Input
                  id="loan-total-inst"
                  type="number"
                  min="1"
                  value={totalInstallments}
                  onChange={(e) => setTotalInstallments(e.target.value)}
                  placeholder="12"
                  required
                />
              </div>
            </div>

            {/* Date + Due Day + Debit Account */}
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="loan-due">{t('dueDay')}</Label>
                <Input
                  id="loan-due"
                  type="number"
                  min="1"
                  max="31"
                  value={dueDay}
                  onChange={(e) => setDueDay(e.target.value)}
                  placeholder={t('dueDayPlaceholder')}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="loan-start-date">{t('startDate')}</Label>
                <Input
                  id="loan-start-date"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="loan-debit-account">{t('debitAccount')}</Label>
                <Select
                  value={checkingAccountId}
                  onValueChange={(val) => setCheckingAccountId(val ?? '')}
                >
                  <SelectTrigger id="loan-debit-account">
                    <SelectValue placeholder={t('selectAccount')} />
                  </SelectTrigger>
                  <SelectContent>
                    {checkingAccounts.map((acc) => (
                      <SelectItem key={acc.id} value={acc.id}>
                        {acc.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Rates */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="loan-monthly-rate">{t('monthlyInterestRate')}</Label>
                <Input
                  id="loan-monthly-rate"
                  type="number"
                  step="0.0001"
                  min="0"
                  value={monthlyInterestRate}
                  onChange={(e) => setMonthlyInterestRate(e.target.value)}
                  placeholder={t('monthlyInterestRatePlaceholder')}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="loan-annual-rate">{t('annualInterestRate')}</Label>
                <Input
                  id="loan-annual-rate"
                  type="number"
                  step="0.01"
                  min="0"
                  value={annualInterestRate}
                  onChange={(e) => setAnnualInterestRate(e.target.value)}
                  placeholder={t('annualInterestRatePlaceholder')}
                />
              </div>
            </div>

            {/* Insurance */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="loan-insurance">{t('insuranceAmount')}</Label>
                <Input
                  id="loan-insurance"
                  type="number"
                  step="0.01"
                  min="0"
                  value={insuranceAmount}
                  onChange={(e) => setInsuranceAmount(e.target.value)}
                  placeholder="0,00"
                />
              </div>

              {insuranceAmount && parseFloat(insuranceAmount) > 0 && (
                <div className="space-y-2">
                  <Label htmlFor="loan-insurance-day">{t('insurancePaymentDay')}</Label>
                  <Input
                    id="loan-insurance-day"
                    type="number"
                    min="1"
                    max="31"
                    value={insurancePaymentDay}
                    onChange={(e) => setInsurancePaymentDay(e.target.value)}
                    placeholder={t('insurancePaymentDayPlaceholder')}
                  />
                </div>
              )}
            </div>

            {/* Payoff type + Original + Principal */}
            {loanCategory === 'bank' && (
              <div className="space-y-4 border-t pt-4">
                <p className="text-sm font-semibold">{t('payoffSettingsTitle')}</p>
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="loan-payoff-calc">{t('payoffCalcType')}</Label>
                    <Select
                      value={payoffCalculationType}
                      onValueChange={(val) =>
                        setPayoffCalculationType(
                          (val as
                            | 'sem_desconto'
                            | 'consignado_mensal'
                            | 'pessoal_diario'
                            | 'cdc_veiculos') ?? 'sem_desconto',
                        )
                      }
                    >
                      <SelectTrigger id="loan-payoff-calc">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="sem_desconto">{t('payoffSemDesconto')}</SelectItem>
                        <SelectItem value="consignado_mensal">
                          {t('payoffConsignadoMensal')}
                        </SelectItem>
                        <SelectItem value="pessoal_diario">{t('payoffPessoalDiario')}</SelectItem>
                        <SelectItem value="cdc_veiculos">{t('payoffCdcVeiculos')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="loan-principal">{t('principalAmount')}</Label>
                    <Input
                      id="loan-principal"
                      type="number"
                      step="0.01"
                      min="0"
                      value={principalAmount}
                      onChange={(e) => setPrincipalAmount(e.target.value)}
                      placeholder="0,00"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="loan-original">{t('originalAmount')}</Label>
                    <Input
                      id="loan-original"
                      type="number"
                      step="0.01"
                      min="0"
                      value={originalAmount}
                      onChange={(e) => setOriginalAmount(e.target.value)}
                      placeholder="0,00"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Comment */}
            <div className="space-y-2">
              <Label htmlFor="loan-comment">{t('comment')}</Label>
              <Textarea
                id="loan-comment"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder={t('commentPlaceholder')}
              />
            </div>

            <LoanPaymentMethodFields
              method={paymentMethod}
              sourceId={incomeSourceAccountId}
              onChange={(method, sourceId) => {
                setPaymentMethod(method);
                setIncomeSourceAccountId(sourceId);
              }}
            />
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={() => onOpenChange(false)}
                disabled={isPending}
              >
                {t('cancel')}
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
                {isPending ? t('saving') : t('add')}
              </Button>
            </DialogFooter>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
