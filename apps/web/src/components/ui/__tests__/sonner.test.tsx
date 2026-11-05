import { act, render, screen } from '@testing-library/react';
import { toast } from 'sonner';
import { describe, expect, it } from 'vitest';
import { ThemeProvider } from '@/lib/providers/ThemeProvider';
import { Toaster } from '../sonner';

describe('Toaster (global sonner mount)', () => {
  it('shows a toast fired via toast.error', async () => {
    render(
      <ThemeProvider>
        <Toaster />
      </ThemeProvider>,
    );

    act(() => {
      toast.error('Falha ao salvar');
    });

    expect(await screen.findByText('Falha ao salvar')).toBeInTheDocument();
  });
});
