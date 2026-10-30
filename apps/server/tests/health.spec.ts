import { describe, expect, it, vi } from 'vitest';
import { db } from '../src/db/db';
import { HealthController } from '../src/app.module';

describe('数据库就绪探针', () => {
  it('数据库查询失败时返回可供部署回滚识别的 503', async () => {
    const query = vi.spyOn(db, 'execute').mockRejectedValueOnce(new Error('connection refused'));
    try {
      await expect(new HealthController().ready()).rejects.toMatchObject({ status: 503 });
    } finally {
      query.mockRestore();
    }
  });
});
