import type { DbExecutor } from '@fc/db';
import { userProfiles } from '@fc/db';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { CategoryService } from './category.service.ts';

const TEST_USER = {
  email: 'category-test@example.com',
  name: 'Category Test User',
  passwordHash: 'hashed',
};

const TEST_USER_2 = {
  email: 'category-test-2@example.com',
  name: 'Category Test User 2',
  passwordHash: 'hashed',
};

async function createTestUser(db: DbExecutor, data: typeof TEST_USER) {
  const [user] = await db.insert(userProfiles).values(data).returning();
  return user;
}

describe('CategoryService', () => {
  describe('ensureDefaultCategories', () => {
    it('seeds default categories for a new user (13 expense + 5 revenue = 18)', async () => {
      await withRollback(async (db) => {
        const service = new CategoryService(db);
        const user = await createTestUser(db, TEST_USER);

        const result = await service.ensureDefaultCategories(user.id);

        expect(result.created).toBe(18);
        expect(result.existing).toBe(0);

        const list = await service.listByUser(user.id);
        expect(list).toHaveLength(18);
      });
    });

    it('does not re-seed if categories already exist', async () => {
      await withRollback(async (db) => {
        const service = new CategoryService(db);
        const user = await createTestUser(db, TEST_USER);

        await service.ensureDefaultCategories(user.id);
        const second = await service.ensureDefaultCategories(user.id);

        expect(second.created).toBe(0);
        expect(second.existing).toBe(18);
      });
    });
  });

  describe('listByUser', () => {
    it('lists categories for a user', async () => {
      await withRollback(async (db) => {
        const service = new CategoryService(db);
        const user = await createTestUser(db, TEST_USER);

        await service.create(user.id, { name: 'Cat A', type: 'expense' });
        await service.create(user.id, { name: 'Cat B', type: 'revenue' });

        const list = await service.listByUser(user.id);

        expect(list).toHaveLength(2);
      });
    });

    it('does not return categories from another user', async () => {
      await withRollback(async (db) => {
        const service = new CategoryService(db);
        const user1 = await createTestUser(db, TEST_USER);
        const user2 = await createTestUser(db, TEST_USER_2);

        await service.create(user1.id, { name: 'User1 Cat', type: 'expense' });

        const list = await service.listByUser(user2.id);

        expect(list).toHaveLength(0);
      });
    });
  });

  describe('create', () => {
    it('rejects a parent belonging to another owner', async () => {
      await withRollback(async (db) => {
        const service = new CategoryService(db);
        const a = await createTestUser(db, TEST_USER);
        const b = await createTestUser(db, TEST_USER_2);
        const parent = await service.create(a.id, { name: 'Parent', type: 'expense' });
        await expect(
          service.create(b.id, { name: 'Child', type: 'expense', parentId: parent.id }),
        ).rejects.toThrow();
      });
    });
    it('creates a custom category', async () => {
      await withRollback(async (db) => {
        const service = new CategoryService(db);
        const user = await createTestUser(db, TEST_USER);

        const category = await service.create(user.id, {
          name: 'My Category',
          type: 'expense',
          icon: 'star',
          color: '#FF0000',
        });

        expect(category.name).toBe('My Category');
        expect(category.type).toBe('expense');
        expect(category.icon).toBe('star');
        expect(category.color).toBe('#FF0000');
        expect(category.isSystem).toBe(false);
        expect(category.userId).toBe(user.id);
      });
    });
  });

  describe('update', () => {
    it('updates category name', async () => {
      await withRollback(async (db) => {
        const service = new CategoryService(db);
        const user = await createTestUser(db, TEST_USER);
        const category = await service.create(user.id, { name: 'Old Name', type: 'expense' });

        const updated = await service.update(user.id, category.id, { name: 'New Name' });

        expect(updated.name).toBe('New Name');
      });
    });
  });

  describe('delete', () => {
    it('deletes a custom category', async () => {
      await withRollback(async (db) => {
        const service = new CategoryService(db);
        const user = await createTestUser(db, TEST_USER);
        const category = await service.create(user.id, { name: 'To Delete', type: 'expense' });

        await service.delete(user.id, category.id);

        const list = await service.listByUser(user.id);
        expect(list).toHaveLength(0);
      });
    });

    it('rejects deleting a system category', async () => {
      await withRollback(async (db) => {
        const service = new CategoryService(db);
        const user = await createTestUser(db, TEST_USER);

        await service.ensureDefaultCategories(user.id);
        const list = await service.listByUser(user.id);
        const systemCategory = list.find((c) => c.isSystem);
        if (!systemCategory) throw new Error('expected at least one system category');

        await expect(service.delete(user.id, systemCategory.id)).rejects.toThrow(
          'Cannot delete system categories',
        );
      });
    });
  });
});
