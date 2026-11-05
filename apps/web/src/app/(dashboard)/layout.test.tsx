import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DashboardLayout from './layout';

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  quickAdd: vi.fn(() => <div data-testid="quick-add" />),
  redirect: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/auth-server', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/components/layouts/MobileHeader', () => ({
  MobileHeader: () => <div>mobile header</div>,
}));
vi.mock('@/components/layouts/Sidebar', () => ({ Sidebar: () => <div>sidebar</div> }));
vi.mock('@/components/quick-add/QuickAdd', () => ({
  QuickAdd: mocks.quickAdd,
}));

describe('DashboardLayout authentication and quick-add composition', () => {
  beforeEach(() => vi.clearAllMocks());

  it('redirects an unauthenticated session without rendering dashboard content', async () => {
    const redirectSignal = new Error('redirect');
    mocks.getServerSession.mockResolvedValue(null);
    mocks.redirect.mockImplementation(() => {
      throw redirectSignal;
    });

    await expect(DashboardLayout({ children: <p>dashboard child</p> })).rejects.toBe(
      redirectSignal,
    );

    expect(mocks.redirect).toHaveBeenCalledWith('/login');
    expect(mocks.quickAdd).not.toHaveBeenCalled();
  });

  it('renders quick-add only for an authenticated session', async () => {
    mocks.getServerSession.mockResolvedValue({ user: { id: 'user-1' } });

    render(await DashboardLayout({ children: <p>dashboard child</p> }));

    expect(screen.getByText('dashboard child')).toBeInTheDocument();
    expect(screen.getByTestId('quick-add')).toBeInTheDocument();
  });
});
