import { describe, expect, it } from 'vitest';
import { markdownCodeSpan } from '../../../../../scripts/lib/markdown';

describe('Markdown report code spans', () => {
  it('keeps backslashes literal and uses a fence longer than embedded backticks', () => {
    expect(markdownCodeSpan('path\\`label``')).toBe('``` path\\`label`` ```');
  });

  it('keeps newlines and HTML inside one literal report entry', () => {
    expect(markdownCodeSpan('<img src=x>\r\n- next')).toBe('` <img src=x> - next `');
  });

  it('pads values starting and ending in backticks so the fences cannot combine', () => {
    expect(markdownCodeSpan('`value`')).toBe('`` `value` ``');
  });
});
