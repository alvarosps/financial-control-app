import { describe, expect, it } from 'vitest';
import { orderCategoriesByUsage } from './category-usage';

const categories = [
  { id: 'a', name: 'Alimentação' },
  { id: 'b', name: 'Transporte' },
  { id: 'c', name: 'Lazer' },
];

describe('orderCategoriesByUsage', () => {
  it('puts most-used categories first', () => {
    expect(
      orderCategoriesByUsage(categories, [
        { categoryId: 'b' },
        { categoryId: 'b' },
        { categoryId: 'c' },
        { categoryId: null },
      ]).map((category) => category.id),
    ).toEqual(['b', 'c', 'a']);
  });

  it('breaks ties alphabetically without mutating categories', () => {
    const input = [...categories];

    expect(orderCategoriesByUsage(input, []).map((category) => category.name)).toEqual([
      'Alimentação',
      'Lazer',
      'Transporte',
    ]);
    expect(input).toEqual(categories);
  });
});
