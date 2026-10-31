import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeApiDatabase, resetApiDatabase, setupApiDatabase } from './db.js';

// 本地没有 MinIO 时不能真实生成预签名地址（客户端会探测 bucket region）。
vi.mock('minio', () => ({
  Client: class {
    async presignedPutObject(bucket: string, name: string, expiry: number) {
      return `https://minio.local/${bucket}/${name}?expires=${expiry}`;
    }
  },
}));

let db: typeof import('../db.js');
let redisModule: typeof import('../redis.js');

beforeAll(async () => {
  await setupApiDatabase();
  db = await import('../db.js');
  redisModule = await import('../redis.js');
});

afterAll(async () => {
  await closeApiDatabase();
  redisModule.redis.disconnect();
});

describe('数据库与 Redis 健康检查', () => {
  it('pingDatabase 在主库可用时返回 true', async () => {
    expect(await db.pingDatabase()).toBe(true);
  });

  it('pingRedis 在 Redis 可用时返回 true，并发布成员变更事件', async () => {
    expect(await redisModule.pingRedis()).toBe(true);
    await expect(redisModule.publishAclChange('doc-1')).resolves.toBeUndefined();
  });

  it('Redis 断开后发布事件被捕获为告警，不影响接口', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    redisModule.redis.disconnect();
    await expect(redisModule.publishAclChange('doc-1')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('withTransaction 成功提交，异常时回滚', async () => {
    await resetApiDatabase();

    const committed = await db.withTransaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into users (email, display_name) values ('tx@example.com', '事务') returning id`,
      );
      return result.rows[0]!.id;
    });
    expect(committed).toBeTruthy();

    await expect(
      db.withTransaction(async (client) => {
        await client.query(
          `insert into users (email, display_name) values ('rollback@example.com', '回滚')`,
        );
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    const rows = await db.query(`select email from users order by email`);
    expect(rows.map((row: { email: string }) => row.email)).toEqual(['tx@example.com']);
  });

  it('连接池 idle 错误只记录日志，不使进程崩溃', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.pool.emit('error', new Error('idle connection lost'));
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('对象存储预签名', () => {
  it('为上传对象生成预签名 URL，无需访问 MinIO', async () => {
    const { presignUpload, storageBucket } = await import('../storage.js');
    const url = await presignUpload('attachments/demo.txt', 60);
    expect(url).toContain('attachments/demo.txt');
    expect(url).toContain(storageBucket);
    expect(url.startsWith('http')).toBe(true);
  });
});
