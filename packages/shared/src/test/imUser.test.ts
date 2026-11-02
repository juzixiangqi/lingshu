import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImUserInfoUnavailableError, createImUserResolver } from '../imUser.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(handler: (...args: any[]) => Response | Promise<Response>) {
  const mock = vi.fn(handler);
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createImUserResolver', () => {
  it('未配置 userinfoUrl 时抛出身份服务不可用', async () => {
    const resolver = createImUserResolver({ userinfoUrl: '' });
    await expect(resolver('token')).rejects.toThrow(ImUserInfoUnavailableError);
    await expect(resolver('token')).rejects.toThrow('未配置 IM_USERINFO_URL');
  });

  it('带 token 请求 /getInfo，归一化邮箱与昵称并缓存结果', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({
        user: { userId: 123, userName: '张三', nickName: '', email: 'Zhang@Example.COM ' },
      }),
    );
    const resolver = createImUserResolver({
      userinfoUrl: 'http://im.local/getInfo',
      tokenHeader: 'Authorization',
      tokenPrefix: 'Bearer',
    });

    const user = await resolver('token-1');
    expect(user).toEqual({ imUserId: '123', email: 'zhang@example.com', displayName: '张三' });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers).toEqual({ Authorization: 'Bearer token-1' });
    expect(init.signal).toBeInstanceOf(AbortSignal);

    await resolver('token-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('昵称优先于用户名且截断到 40 字，数量型 userId 转字符串', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ user: { userId: 42, userName: 'fallback', nickName: 'n'.repeat(50) } }),
    );
    const resolver = createImUserResolver({ userinfoUrl: 'http://im.local/getInfo' });

    const user = await resolver('token-2');
    expect(user?.imUserId).toBe('42');
    expect(user?.displayName).toHaveLength(40);
    expect(user?.email).toBe('42@im.local');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('缺少 userId 的响应视为 token 无效', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ msg: 'invalid' }));
    const resolver = createImUserResolver({ userinfoUrl: 'http://im.local/getInfo' });

    await expect(resolver('token-3')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('userId 为空白字符串时视为 token 无效', async () => {
    stubFetch(() => jsonResponse({ user: { userId: '   ' } }));
    const resolver = createImUserResolver({ userinfoUrl: 'http://im.local/getInfo' });
    await expect(resolver('token-4')).resolves.toBeNull();
  });

  it('user 字段缺失时视为 token 无效', async () => {
    stubFetch(() => jsonResponse({ code: 200 }));
    const resolver = createImUserResolver({ userinfoUrl: 'http://im.local/getInfo' });
    await expect(resolver('token-5')).resolves.toBeNull();
  });

  it('401 返回 null，并把无效结果缓存一个周期', async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 401 }));
    const resolver = createImUserResolver({ userinfoUrl: 'http://im.local/getInfo' });

    await expect(resolver('expired')).resolves.toBeNull();
    await expect(resolver('expired')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('403 返回 null', async () => {
    stubFetch(() => new Response(null, { status: 403 }));
    const resolver = createImUserResolver({ userinfoUrl: 'http://im.local/getInfo' });
    await expect(resolver('forbidden')).resolves.toBeNull();
  });

  it('5xx 抛出席位服务不可用并带上状态码', async () => {
    stubFetch(() => new Response(null, { status: 503 }));
    const resolver = createImUserResolver({ userinfoUrl: 'http://im.local/getInfo' });
    await expect(resolver('token-6')).rejects.toThrow('IM 身份服务返回 503');
  });

  it('非 JSON 响应抛出不带原始解析错误', async () => {
    stubFetch(() => new Response('not json', { status: 200 }));
    const resolver = createImUserResolver({ userinfoUrl: 'http://im.local/getInfo' });
    await expect(resolver('token-7')).rejects.toThrow('IM 身份服务返回了非 JSON 响应');
  });

  it('网络异常包装为身份服务不可用', async () => {
    stubFetch(() => Promise.reject(new Error('connect ECONNREFUSED')));
    const resolver = createImUserResolver({ userinfoUrl: 'http://im.local/getInfo' });
    await expect(resolver('token-8')).rejects.toThrow('connect ECONNREFUSED');
  });

  it('非 Error 的异常使用兜底文案', async () => {
    stubFetch(() => Promise.reject('boom'));
    const resolver = createImUserResolver({ userinfoUrl: 'http://im.local/getInfo' });
    await expect(resolver('token-9')).rejects.toThrow('IM 身份服务请求失败');
  });

  it('自定义 token 请求头与前缀，前缀缺少空格时自动补上', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ user: { userId: 11, userName: 'name' } }));
    const resolver = createImUserResolver({
      userinfoUrl: 'http://im.local/getInfo',
      tokenHeader: 'X-Im-Token',
      tokenPrefix: 'tk-',
    });

    await resolver('abc');
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers).toEqual({ 'X-Im-Token': 'tk- abc' });
  });

  it('前缀为空时不添加前缀', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ user: { userId: 12, userName: 'name' } }));
    const resolver = createImUserResolver({
      userinfoUrl: 'http://im.local/getInfo',
      tokenHeader: 'Authorization',
      tokenPrefix: '',
    });

    await resolver('abc');
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers).toEqual({ Authorization: 'abc' });
  });

  it('超过缓存上限时淘汰最早写入的 token', async () => {
    const fetchMock = stubFetch((_url: string, init: { headers: Record<string, string> }) => {
      const header = Object.values(init.headers)[0] ?? '';
      return jsonResponse({ user: { userId: header.replace('Bearer ', ''), userName: 'name' } });
    });
    const resolver = createImUserResolver({
      userinfoUrl: 'http://im.local/getInfo',
      cacheMaxEntries: 1,
    });

    await resolver('token-a');
    await resolver('token-b');
    await resolver('token-a');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('缓存上限为 0 时仍可解析首次请求', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ user: { userId: 13, userName: 'name' } }));
    const resolver = createImUserResolver({ userinfoUrl: 'http://im.local/getInfo', cacheMaxEntries: 0 });
    await expect(resolver('token-c')).resolves.toMatchObject({ imUserId: '13' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
