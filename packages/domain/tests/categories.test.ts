import { describe, expect, it } from 'vitest';
import { PRESET_EXPENSE_CATEGORIES } from '../src/constants/categories';

describe('预置分类', () => {
  it('一级支出分类恰为 12 个且不重名(M03-F01)', () => {
    expect(PRESET_EXPENSE_CATEGORIES).toHaveLength(12);
    const names = PRESET_EXPENSE_CATEGORIES.map((c) => c.name);
    expect(new Set(names).size).toBe(12);
  });
});
