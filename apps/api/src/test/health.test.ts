import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({
  pingDatabase: vi.fn(),
  query: vi.fn(),
  withTransaction: vi.fn(),
  pool: {},
}));

vi.mock('../redis.js', () => ({
  pingRedis: vi.fn(),
  publishAclChange: vi.fn(),
  redis: {},
}));

let app: import('hono').Hono;
let pingDatabase: ReturnType<typeof vi.fn>;
let pingRedis: ReturnType<typeof vi.fn>;
let isInfraError: (error: unknown) => boolean;

beforeAll(async () => {
  const db = await import('../db.js');
  const redisModule = await import('../redis.js');
  pingDatabase = db.pingDatabase as unknown as ReturnType<typeof vi.fn>;
  pingRedis = redisModule.pingRedis as unknown as ReturnType<typeof vi.fn>;

  const appModule = await import('../app.js');
  app = appModule.app;
  isInfraError = appModule.isInfraError;

  app.get('/__boom-infra', () => {
    const error = new Error('connect refused') as Error & { code?: string };
    error.code = 'ECONNREFUSED';
    throw error;
  });
  app.get('/__boom-generic', () => {
    throw new Error('unexpected');
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  pingDatabase.mockReset();
  pingRedis.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /api/health', () => {
  it('主库正常、Redis 异常时标记 degraded', async () => {
    pingDatabase.mockResolvedValue(true);
    pingRedis.mockResolvedValue(false);
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, db: true, redis: false, degraded: true });
    expect(body.storage).toEqual({ bucket: 'lingshu', endpoint: 'localhost:9000' });
    expect(body.shards).toEqual(['ws://localhost:1234', 'ws://localhost:1235']);
    expect(typeof body.uptimeSeconds).toBe('number');
  });

  it('主库不可用时 ok=false，Redis 正常不视为 degraded', async () => {
    pingDatabase.mockResolvedValue(false);
    pingRedis.mockResolvedValue(true);
    const body = await (await app.request('/api/health')).json();
    expect(body).toMatchObject({ ok: false, db: false, redis: true, degraded: false });
  });

  it('依赖全可用时 ok=true 且 degraded=false', async () => {
    pingDatabase.mockResolvedValue(true);
    pingRedis.mockResolvedValue(true);
    const body = await (await app.request('/api/health')).json();
    expect(body).toMatchObject({ ok: true, degraded: false });
  });

  it('根路由返回服务名与分片列表', async () => {
    const response = await app.request('/');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      service: 'lingshu-api',
      shards: ['ws://localhost:1234', 'ws://localhost:1235'],
    });
  });
});

describe('onError 映射', () => {
  it('基础设施错误码映射为 503', async () => {
    const response = await app.request('/__boom-infra');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: '依赖服务暂不可用，请稍后重试' });
  });

  it('普通异常映射为 500', async () => {
    const response = await app.request('/__boom-generic');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: '服务器内部错误' });
  });

  it('isInfraError 识别常见 pg/网络错误码', () => {
    for (const code of ['ECONNREFUSED', '08006', '57P01', '53300', 'ETIMEDOUT']) {
      expect(isInfraError({ code })).toBe(true);
    }
    expect(isInfraError({ code: 'XX000' })).toBe(false);
    expect(isInfraError({ code: 42 })).toBe(false);
    expect(isInfraError(null)).toBe(false);
    expect(isInfraError(new Error('plain'))).toBe(false);
  });
});
