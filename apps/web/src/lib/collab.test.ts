import type { DocDetail } from '@lingshu/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hocuspocus = vi.hoisted(() => {
  const instances: Array<{
    options: Record<string, unknown>;
    destroy: ReturnType<typeof vi.fn>;
  }> = [];

  class FakeProvider {
    options: Record<string, unknown>;
    destroy = vi.fn();

    constructor(options: Record<string, unknown>) {
      this.options = options;
      instances.push(this);
    }
  }

  return { instances, FakeProvider };
});

const api = vi.hoisted(() => ({ token: 'session-token' as string | null }));

vi.mock('@hocuspocus/provider', () => ({ HocuspocusProvider: hocuspocus.FakeProvider }));
vi.mock('./api', () => ({ getToken: () => api.token }));

async function loadCollab() {
  return import('./collab.js');
}

const detail: DocDetail = {
  id: 'doc-1',
  kind: 'doc',
  title: '示例',
  role: 'editor',
  updatedAt: '2026-01-01T00:00:00.000Z',
  collab: { url: 'ws://localhost:1234', documentNames: ['doc-1/body'] },
};

beforeEach(() => {
  hocuspocus.instances.length = 0;
  api.token = 'session-token';
});

describe('connectDocument', () => {
  it('用分片地址与当前 token 建立 Provider 与 Y.Doc', async () => {
    const { connectDocument } = await loadCollab();
    const session = connectDocument(detail, 'doc-1/body');

    expect(session.documentName).toBe('doc-1/body');
    expect(session.doc).toBeInstanceOf(Object);
    expect(hocuspocus.instances).toHaveLength(1);

    const provider = hocuspocus.instances[0]!;
    expect(provider.options).toEqual({
      url: 'ws://localhost:1234',
      name: 'doc-1/body',
      token: 'session-token',
      document: session.doc,
    });
    expect(session.provider).toBe(provider);
  });

  it('没有登录 token 时使用空字符串', async () => {
    const { connectDocument } = await loadCollab();
    api.token = null;
    connectDocument(detail, 'doc-1/body');

    expect(hocuspocus.instances[0]!.options.token).toBe('');
  });
});

describe('destroySession', () => {
  it('销毁 provider 与 Y.Doc', async () => {
    const { connectDocument, destroySession } = await loadCollab();
    const session = connectDocument(detail, 'doc-1/body');

    const destroyDoc = vi.spyOn(session.doc, 'destroy');
    destroySession(session);

    expect(session.provider.destroy).toHaveBeenCalledTimes(1);
    expect(destroyDoc).toHaveBeenCalledTimes(1);
  });
});

describe('collabStatusLabel', () => {
  it('把 Hocuspocus 状态映射为中文提示', async () => {
    const { collabStatusLabel } = await loadCollab();

    expect(collabStatusLabel('connecting')).toBe('连接中');
    expect(collabStatusLabel('connected')).toBe('已连接');
    expect(collabStatusLabel('disconnected')).toBe('协同服务断开，正在重连…');
    expect(collabStatusLabel('unknown')).toBe('unknown');
  });
});

describe('decodeSnapshot', () => {
  it('把 base64 快照还原为 Uint8Array', async () => {
    const { decodeSnapshot } = await loadCollab();
    const bytes = decodeSnapshot('AAECAw==');

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes)).toEqual([0, 1, 2, 3]);
  });

  it('空字符串解码为空数组', async () => {
    const { decodeSnapshot } = await loadCollab();
    expect(Array.from(decodeSnapshot(''))).toEqual([]);
  });
});

describe('RESTORE_STATELESS', () => {
  it('转发服务端可识别的控制消息', async () => {
    const { RESTORE_STATELESS } = await loadCollab();
    expect(JSON.parse(RESTORE_STATELESS)).toEqual({ type: 'lingshu:restore' });
  });
});
