import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MoneyField } from '../MoneyField';

describe('MoneyField', () => {
  it('renders a labelled decimal-text input that accepts localized money', () => {
    render(<MoneyField id="amt" label="Valor" value="" onChange={() => {}} required />);
    const input = screen.getByLabelText('Valor') as HTMLInputElement;
    expect(input.type).toBe('text');
    expect(input.inputMode).toBe('decimal');
    expect(input.step).toBe('0.01');
    expect(input.min).toBe('0.01');
    expect(input.placeholder).toBe('0,00');
    expect(input.required).toBe(true);
  });
  it('supports min override for optional zero-based fields', () => {
    render(<MoneyField id="amt" label="Limite" value="" onChange={() => {}} min="0" />);
    expect((screen.getByLabelText('Limite') as HTMLInputElement).min).toBe('0');
  });
  it('propagates typed values through onChange as raw string', () => {
    const onChange = vi.fn();
    render(<MoneyField id="amt" label="Valor" value="" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Valor'), { target: { value: '123,45' } });
    expect(onChange).toHaveBeenCalledWith('123,45');
  });
});
