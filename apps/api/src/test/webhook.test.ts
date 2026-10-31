import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MentionWebhookPayload } from '../webhook.js';

let env: { lingxiWebhookUrl: string };
let sendMentionWebhook: (payload: MentionWebhookPayload) => Promise<'sent' | 'skipped' | 'failed'>;

const payload: MentionWebhookPayload = {
  type: 'mention',
  documentId: 'doc-1',
  documentTitle: '标题',
  documentKind: 'doc',
  url: 'http://localhost:5173/doc/doc-1',
  actor: { id: 'user-1', displayName: '发起人' },
  recipients: [{ id: 'user-2', displayName: '接收人', email: 'to@example.com' }],
  excerpt: '摘要',
  occurredAt: '2026-01-01T00:00:00.000Z',
};

beforeAll(async () => {
  env = (await import('../env.js')).env;
  ({ sendMentionWebhook } = await import('../webhook.js'));
});

beforeEach(() => {
  env.lingxiWebhookUrl = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendMentionWebhook', () => {
  it('未配置 webhook 地址时 skipped，不发起请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await sendMentionWebhook(payload)).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('2xx 响应返回 sent，并 POST JSON 负载', async () => {
    env.lingxiWebhookUrl = 'http://webhook.local/mention';
    const fetchMock = vi.fn(async () => new Response('ok', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await sendMentionWebhook(payload)).toBe('sent');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://webhook.local/mention');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual(payload);
  });

  it('非 2xx 返回 failed', async () => {
    env.lingxiWebhookUrl = 'http://webhook.local/mention';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })));
    expect(await sendMentionWebhook(payload)).toBe('failed');
  });

  it('网络异常返回 failed 且不抛出', async () => {
    env.lingxiWebhookUrl = 'http://webhook.local/mention';
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('network'))));
    expect(await sendMentionWebhook(payload)).toBe('failed');
  });
});
