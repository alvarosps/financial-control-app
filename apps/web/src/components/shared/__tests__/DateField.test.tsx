import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DateField } from '../DateField';

describe('DateField', () => {
  it('renders a labelled date input', () => {
    render(<DateField id="d" label="Data" value="2026-07-04" onChange={() => {}} required />);
    const input = screen.getByLabelText('Data') as HTMLInputElement;
    expect(input.type).toBe('date');
    expect(input.value).toBe('2026-07-04');
    expect(input.required).toBe(true);
  });
  it('propagates changes as YYYY-MM-DD string', () => {
    const onChange = vi.fn();
    render(<DateField id="d" label="Data" value="" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Data'), { target: { value: '2026-01-15' } });
    expect(onChange).toHaveBeenCalledWith('2026-01-15');
  });
  it('supports read-only display without onChange', () => {
    render(<DateField id="d" label="Inicio" value="2026-07-04" disabled readOnly />);
    const input = screen.getByLabelText('Inicio') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.readOnly).toBe(true);
  });
});
