import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { MobileHeader } from '@/components/layouts/MobileHeader';
import { Sidebar } from '@/components/layouts/Sidebar';
import { QuickAdd } from '@/components/quick-add/QuickAdd';
import { getServerSession } from '@/lib/auth-server';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession();
  if (!session?.user) {
    redirect('/login');
  }

  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <MobileHeader />
      <main className="md:pl-64">
        <div className="p-4 md:p-8 max-w-7xl mx-auto">
          <Suspense>{children}</Suspense>
        </div>
      </main>
      <QuickAdd />
    </div>
  );
}
