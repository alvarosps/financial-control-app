import { SignOutButton } from '@/components/layouts/SignOutButton';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { LanguageSwitcher } from './LanguageSwitcher';
import { NavGroups } from './NavGroups';

export function Sidebar() {
  return (
    <aside className="hidden border-r border-glass-border bg-glass-bg backdrop-blur-md md:fixed md:inset-y-0 md:flex md:w-64 md:flex-col">
      <div className="flex flex-1 flex-col overflow-y-auto">
        <div className="flex h-16 items-center border-b border-glass-border px-6">
          <h1 className="gradient-brand-text text-lg font-bold tracking-tight">
            Financial Control
          </h1>
        </div>
        <NavGroups />
        <div className="flex flex-col gap-2 border-t border-glass-border px-6 py-4">
          <p className="text-xs text-muted-foreground">Financial Control v2</p>
          <LanguageSwitcher />
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <SignOutButton />
          </div>
        </div>
      </div>
    </aside>
  );
}
