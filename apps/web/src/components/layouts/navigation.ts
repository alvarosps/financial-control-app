import {
  ArrowLeftRight,
  BarChart3,
  CalendarCheck,
  ClipboardList,
  CreditCard,
  FlaskConical,
  Landmark,
  LayoutDashboard,
  type LucideIcon,
  Receipt,
  ReceiptText,
  Settings,
  Tag,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react';

// `nameKey`/`labelKey` are i18n message keys rendered via `t(...)`. Item keys
// live under `nav.*`; group labels under `nav.groups.*`.
export type NavItem = { nameKey: string; href: string; icon: LucideIcon };
export type NavGroup = { labelKey: string; items: readonly NavItem[] };

export const navGroups: readonly NavGroup[] = [
  {
    labelKey: 'nav.groups.overview',
    items: [
      { nameKey: 'nav.dashboard', href: '/dashboard', icon: LayoutDashboard },
      { nameKey: 'nav.daily', href: '/daily', icon: CalendarCheck },
      { nameKey: 'nav.projection', href: '/projection', icon: BarChart3 },
      { nameKey: 'nav.budgets', href: '/budgets', icon: BarChart3 },
      { nameKey: 'nav.simulator', href: '/simulator', icon: FlaskConical },
    ],
  },
  {
    labelKey: 'nav.groups.accounts',
    items: [
      { nameKey: 'nav.accounts', href: '/accounts', icon: Wallet },
      { nameKey: 'nav.creditCards', href: '/credit-cards', icon: CreditCard },
      { nameKey: 'nav.purchases', href: '/purchases', icon: ReceiptText },
      { nameKey: 'nav.transactions', href: '/transactions', icon: ArrowLeftRight },
      { nameKey: 'nav.monthlySpending', href: '/monthly-spending', icon: Receipt },
      { nameKey: 'nav.charges', href: '/charges', icon: ReceiptText },
    ],
  },
  {
    labelKey: 'nav.groups.credit',
    items: [
      { nameKey: 'nav.loans', href: '/loans', icon: Landmark },
      { nameKey: 'nav.familyLoans', href: '/family-loans', icon: Users },
      { nameKey: 'nav.income', href: '/income', icon: TrendingUp },
    ],
  },
  {
    labelKey: 'nav.groups.system',
    items: [
      { nameKey: 'nav.categories', href: '/categories', icon: Tag },
      { nameKey: 'nav.settings', href: '/settings', icon: Settings },
      { nameKey: 'nav.auditLog', href: '/audit-log', icon: ClipboardList },
    ],
  },
];

// Flat list retained for any consumer needing every item.
export const navigation: readonly NavItem[] = navGroups.flatMap((g) => g.items);
