'use client';

import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { trpc } from '@/lib/trpc/client';

export function FaturaProfileSelect({ cardId }: { cardId: string }) {
  const t = useTranslations();
  const utils = trpc.useUtils();
  const profiles = trpc.faturaImport.profiles.useQuery();
  const config = trpc.creditCard.getConfig.useQuery({ accountId: cardId });
  const upsert = trpc.creditCard.upsertConfig.useMutation({
    onSuccess: async () => {
      await utils.creditCard.getConfig.invalidate({ accountId: cardId });
      toast.success(t('components-credit-cards-import-faturaprofileselect.saved'));
    },
    onError: (error) =>
      toast.error(
        error.message || t('components-credit-cards-import-faturaprofileselect.saveFailed'),
      ),
  });

  const value = config.data?.billParserType ?? '';
  if (config.data === undefined || config.data === null) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Label htmlFor="fatura-profile" className="text-sm text-muted-foreground">
        {t('components-credit-cards-import-faturaprofileselect.label')}
      </Label>
      <Select
        value={value}
        disabled={upsert.isPending || profiles.isLoading}
        onValueChange={(billParserType) => {
          if (billParserType === null) return;
          upsert.mutate({
            accountId: cardId,
            closingDay: config.data.closingDay,
            dueDay: config.data.dueDay,
            ...(config.data.creditLimit === null ? {} : { creditLimit: config.data.creditLimit }),
            ...(config.data.isDueDayVariable === null
              ? {}
              : { isDueDayVariable: config.data.isDueDayVariable }),
            billParserType,
          });
        }}
      >
        <SelectTrigger id="fatura-profile" className="w-60">
          <SelectValue
            placeholder={t('components-credit-cards-import-faturaprofileselect.placeholder')}
          />
        </SelectTrigger>
        <SelectContent>
          {(profiles.data ?? []).map((profile) => (
            <SelectItem key={profile.id} value={profile.id}>
              {profile.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
