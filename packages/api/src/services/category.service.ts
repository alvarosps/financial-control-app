import type { DbExecutor } from '@fc/db';
import { categories, DEFAULT_EXPENSE_CATEGORIES, DEFAULT_REVENUE_CATEGORIES } from '@fc/db';
import { NotFoundError } from '@fc/domain';
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';

type CreateCategoryInput = {
  name: string;
  type: 'expense' | 'revenue' | 'transfer';
  parentId?: string;
  icon?: string;
  color?: string;
};

type UpdateCategoryInput = {
  name?: string;
  icon?: string;
  color?: string;
};

export class CategoryService {
  constructor(private db: DbExecutor) {}

  async ensureDefaultCategories(userId: string): Promise<{ created: number; existing: number }> {
    const existing = await this.db.select().from(categories).where(eq(categories.userId, userId));

    if (existing.length > 0) {
      return { created: 0, existing: existing.length };
    }

    const toInsert = [
      ...DEFAULT_EXPENSE_CATEGORIES.map((c) => ({
        userId,
        name: c.name,
        type: 'expense' as const,
        icon: c.icon,
        color: c.color,
        isSystem: true,
      })),
      ...DEFAULT_REVENUE_CATEGORIES.map((c) => ({
        userId,
        name: c.name,
        type: 'revenue' as const,
        icon: c.icon,
        color: c.color,
        isSystem: true,
      })),
    ];

    await this.db.insert(categories).values(toInsert);

    return { created: toInsert.length, existing: 0 };
  }

  async listByUser(userId: string) {
    return this.db.select().from(categories).where(eq(categories.userId, userId));
  }

  async getById(userId: string, categoryId: string) {
    const [category] = await this.db
      .select()
      .from(categories)
      .where(and(eq(categories.id, categoryId), eq(categories.userId, userId)));

    if (!category) {
      throw new NotFoundError('Categoria não encontrada');
    }

    return category;
  }

  async create(userId: string, input: CreateCategoryInput) {
    if (input.parentId) {
      const parent = await this.getById(userId, input.parentId);
      if (parent.type !== input.type)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Category parent must have the same type',
        });
    }
    const [category] = await this.db
      .insert(categories)
      .values({
        userId,
        name: input.name,
        type: input.type,
        ...(input.parentId !== undefined && { parentId: input.parentId }),
        ...(input.icon !== undefined && { icon: input.icon }),
        ...(input.color !== undefined && { color: input.color }),
      })
      .returning();

    return category;
  }

  async update(userId: string, categoryId: string, input: UpdateCategoryInput) {
    const [updated] = await this.db
      .update(categories)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.icon !== undefined && { icon: input.icon }),
        ...(input.color !== undefined && { color: input.color }),
        updatedAt: new Date(),
      })
      .where(and(eq(categories.id, categoryId), eq(categories.userId, userId)))
      .returning();

    if (!updated) {
      throw new NotFoundError('Categoria não encontrada');
    }

    return updated;
  }

  async delete(userId: string, categoryId: string) {
    // We still need to load the row to enforce the system-category guard, but
    // the getById is now ownership-filtered by its WHERE, so the subsequent
    // DELETE also adds the tenant predicate as defense-in-depth.
    const category = await this.getById(userId, categoryId);

    if (category.isSystem) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot delete system categories' });
    }

    await this.db
      .delete(categories)
      .where(and(eq(categories.id, categoryId), eq(categories.userId, userId)));
  }
}
