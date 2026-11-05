'use client';

import { Input } from '../ui/input';
import { Label } from '../ui/label';

type DateFieldProps = {
  id: string;
  label: string;
  value: string;
  onChange?: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
};

export function DateField({
  id,
  label,
  value,
  onChange,
  required = false,
  disabled = false,
  readOnly = false,
}: DateFieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="date"
        value={value}
        onChange={onChange ? (event) => onChange(event.target.value) : undefined}
        required={required}
        disabled={disabled}
        readOnly={readOnly}
      />
    </div>
  );
}
