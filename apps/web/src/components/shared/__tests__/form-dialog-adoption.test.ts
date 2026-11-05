import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dialogPaths = [
  '../../accounts/AddAccountDialog.tsx',
  '../../accounts/EditAccountDialog.tsx',
  '../../categories/AddCategoryDialog.tsx',
  '../../categories/EditCategoryDialog.tsx',
];

describe('FormDialog adoption', () => {
  it.each(dialogPaths)('%s delegates the form shell to FormDialog', (relativePath) => {
    const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');

    expect(source).toContain("import { FormDialog } from '@/components/shared/FormDialog';");
    expect(source).not.toContain("from '@/components/ui/dialog'");
    expect(source).not.toContain("from '@/hooks/useMutationFormGuard'");
  });
});
