'use client';

import { Input } from '../ui/input';
import { Label } from '../ui/label';

type MoneyFieldProps = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  min?: string;
  step?: string;
  placeholder?: string;
};

export function MoneyField({
  id,
  label,
  value,
  onChange,
  required = false,
  min = '0.01',
  step = '0.01',
  placeholder = '0,00',
}: MoneyFieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="text"
        inputMode="decimal"
        step={step}
        min={min}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required={required}
      />
    </div>
  );
}
