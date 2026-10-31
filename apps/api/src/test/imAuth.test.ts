import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 必须在导入任何业务模块之前切换到 IM 模式（setup.ts 默认是 local 模式）。
process.env.AUTH_MODE = 'im';
process.env.IM_USERINFO_URL = 'http://im.local/getInfo';

let query: typeof import('../db.js').query;
let resetDatabase: () => Promise<void>;
let closeDatabase: () => Promise<void>;
let imAuth: typeof import('../imAuth.js');

const fetchMock = vi.fn();

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeAll(async () => {
  const helpers = await import('./db.js');
  resetDatabase = helpers.resetApiDatabase;
  closeDatabase = helpers.closeApiDatabase;
  await helpers.setupApiDatabase();
  query = (await import('../db.js')).query;
  imAuth = await import('../imAuth.js');
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('IM 模式开关', () => {
  it('IM 模式下启用并确认已配置', () => {
    expect(imAuth.imAuthEnabled()).toBe(true);
    expect(imAuth.imAuthConfigured()).toBe(true);
  });
});

describe('resolveImSessionUser', () => {
  it('首次登录写入本地镜像，并按 token 缓存', async () => {
    fetchMock.mockResolvedValueOnce(
      respond({ user: { userId: 9001, userName: 'im-user', nickName: '', email: '' } }),
    );

    const user = await imAuth.resolveImSessionUser('token-a');
    expect(user).toEqual({ id: expect.any(String), displayName: 'im-user', email: '9001@im.local' });

    const rows = await query<{ id: string; email: string; display_name: string; im_user_id: string }>(
      `select id, email, display_name, im_user_id from users where im_user_id = '9001'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: user!.id,
      email: '9001@im.local',
      display_name: 'im-user',
      im_user_id: '9001',
    });

    const second = await imAuth.resolveImSessionUser('token-a');
    expect(second).toEqual(user);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('已有镜像时刷新展示名，邮箱保持本地记录', async () => {
    const inserted = await query<{ id: string }>(
      `insert into users (email, display_name, im_user_id)
       values ('mirror@im.local', '旧昵称', '9100') returning id`,
    );
    const id = inserted[0]!.id;

    fetchMock.mockResolvedValueOnce(
      respond({ user: { userId: 9100, nickName: '新昵称', email: 'new@example.com' } }),
    );
    const user = await imAuth.resolveImSessionUser('token-b');

    expect(user).toEqual({ id, displayName: '新昵称', email: 'mirror@im.local' });
    const rows = await query<{ display_name: string }>(`select display_name from users where id = $1`, [id]);
    expect(rows[0]!.display_name).toBe('新昵称');
  });

  it('IM 返回无效用户时得到 null', async () => {
    fetchMock.mockResolvedValueOnce(respond({ user: {} }));
    await expect(imAuth.resolveImSessionUser('token-c')).resolves.toBeNull();
  });

  it('401 与 403 都视为 token 无效，并缓存空结果', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(imAuth.resolveImSessionUser('token-d')).resolves.toBeNull();
    await expect(imAuth.resolveImSessionUser('token-d')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(imAuth.resolveImSessionUser('token-e')).resolves.toBeNull();
  });

  it('IM 服务 5xx 抛出不合适用错误', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await expect(imAuth.resolveImSessionUser('token-f')).rejects.toThrow('IM 身份服务返回 500');
  });

  it('网络异常向上抛出，登录接口可映射为 503', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    await expect(imAuth.resolveImSessionUser('token-g')).rejects.toThrow('connect ECONNREFUSED');
  });

  it('邮箱被本地历史账号占用时退回到 IM 占位邮箱', async () => {
    await query(`insert into users (email, display_name, im_user_id)
                 values ('dup@example.com', '本地用户', 'local-dup')`);

    fetchMock.mockResolvedValueOnce(
      respond({ user: { userId: 7777, userName: 'IM 用户', email: 'dup@example.com' } }),
    );
    const user = await imAuth.resolveImSessionUser('token-h');

    expect(user).toEqual({ id: expect.any(String), displayName: 'IM 用户', email: '7777@im.local' });
    const rows = await query<{ im_user_id: string }>(
      `select im_user_id from users where email = '7777@im.local'`,
    );
    expect(rows[0]!.im_user_id).toBe('7777');
  });

  it('占位邮箱同样冲突时向外抛出原始错误', async () => {
    await query(`insert into users (email, display_name, im_user_id)
                 values ('8888@im.local', '占位用户', 'local-x')`);

    fetchMock.mockResolvedValueOnce(
      respond({ user: { userId: 8888, nickName: '冲突用户', email: '8888@im.local' } }),
    );
    await expect(imAuth.resolveImSessionUser('token-i')).rejects.toThrow();

    const rows = await query(`select id from users where im_user_id = '8888'`);
    expect(rows).toHaveLength(0);
  });
});
