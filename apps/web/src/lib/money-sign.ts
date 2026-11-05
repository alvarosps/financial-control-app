/** Normalize a user money string to `[-]\d+\.\d{2}` (preserves a leading minus). */
export function toSignedMoney(input: string): string | null {
  const trimmed = input.trim();
  if (
    !/^-?(?:\d+|\d{1,3}(?:\.\d{3})+),\d{1,2}$/.test(trimmed) &&
    !/^-?\d+(?:\.\d{1,2})?$/.test(trimmed)
  )
    return null;
  const normalized = trimmed.includes(',')
    ? trimmed.replaceAll('.', '').replace(',', '.')
    : trimmed;
  const [whole, fraction = ''] = normalized.split('.');
  const digits = whole.replace('-', '').replace(/^0+(?=\d)/, '');
  if (digits.length > 10) return null;
  const negative = whole.startsWith('-') && (digits !== '0' || /[1-9]/.test(fraction));
  return `${negative ? '-' : ''}${digits}.${fraction.padEnd(2, '0')}`;
}
