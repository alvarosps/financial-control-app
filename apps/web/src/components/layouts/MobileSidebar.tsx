'use client';

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { LanguageSwitcher } from './LanguageSwitcher';
import { NavGroups } from './NavGroups';

type Props = {
  open: boolean;
  onClose: () => void;
};

export function MobileSidebar({ open, onClose }: Props) {
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="left"
        className="w-64 gap-0 border-glass-border bg-sidebar/95 p-0 backdrop-blur-md md:hidden"
      >
        <SheetHeader className="h-14 justify-center border-b border-glass-border px-4">
          <SheetTitle className="gradient-brand-text text-sm font-bold">
            Financial Control
          </SheetTitle>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto">
          <NavGroups onNavigate={onClose} />
        </div>
        <div className="border-t border-glass-border px-4 py-3">
          <LanguageSwitcher />
        </div>
      </SheetContent>
    </Sheet>
  );
}
