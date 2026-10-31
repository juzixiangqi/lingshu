import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// 默认 local 模式：IM 解析器不会被创建，但地址配置仍可被前端探测。
process.env.IM_USERINFO_URL = 'http://im.local/getInfo';

let imAuth: typeof import('../imAuth.js');
let closeDatabase: () => Promise<void>;

beforeAll(async () => {
  const helpers = await import('./db.js');
  closeDatabase = helpers.closeApiDatabase;
  imAuth = await import('../imAuth.js');
});

afterAll(async () => {
  await closeDatabase();
});

describe('IM 模式关闭时', () => {
  it('不启用 IM 解析器但能上报已配置', () => {
    expect(imAuth.imAuthEnabled()).toBe(false);
    expect(imAuth.imAuthConfigured()).toBe(true);
  });

  it('resolveImSessionUser 直接返回 null，不触发网络请求', async () => {
    await expect(imAuth.resolveImSessionUser('token')).resolves.toBeNull();
  });
});
