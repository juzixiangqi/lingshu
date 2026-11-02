import { describe, expect, it } from 'vitest';
import { ACL_EVENT_CHANNEL, RESTORE_STATELESS_PAYLOAD } from '../acl.js';
import {
  bodyDocumentName,
  docIdFromDocumentName,
  documentNamesFor,
  isSheetDocument,
  sheetDocumentName,
  workbookDocumentName,
} from '../documents.js';
import { LIMITS } from '../limits.js';
import { broadcastsCursor, canWrite, isSpectator, pickTitle, WRITE_ROLES } from '../roles.js';
import { fnv1a32, parseShards, pickShard } from '../shard.js';

describe('acl 常量', () => {
  it('ACL 事件通道名稳定', () => {
    expect(ACL_EVENT_CHANNEL).toBe('lingshu:acl');
  });

  it('RESTORE_STATELESS_PAYLOAD 是可解析的控制消息', () => {
    expect(JSON.parse(RESTORE_STATELESS_PAYLOAD)).toEqual({ type: 'lingshu:restore' });
    expect(RESTORE_STATELESS_PAYLOAD).toBe(JSON.stringify({ type: 'lingshu:restore' }));
  });
});

describe('角色能力', () => {
  it('owner/editor 可写，spectator 只读', () => {
    expect(canWrite('owner')).toBe(true);
    expect(canWrite('editor')).toBe(true);
    expect(canWrite('spectator')).toBe(false);
    expect(WRITE_ROLES).toEqual(['owner', 'editor']);
  });

  it('isSpectator 与光标广播判定', () => {
    expect(isSpectator('spectator')).toBe(true);
    expect(isSpectator('editor')).toBe(false);
    expect(broadcastsCursor('owner')).toBe(true);
    expect(broadcastsCursor('editor')).toBe(true);
    expect(broadcastsCursor('spectator')).toBe(false);
  });

  it('按文档类型给出默认标题', () => {
    expect(pickTitle('doc')).toBe('未命名文档');
    expect(pickTitle('sheet')).toBe('未命名表格');
    expect(pickTitle('mindmap')).toBe('未命名导图');
  });
});

describe('文档命名约定', () => {
  it('生成各类 Y.Doc 名称', () => {
    expect(workbookDocumentName('abc')).toBe('abc/workbook');
    expect(sheetDocumentName('abc')).toBe('abc/sheet/main');
    expect(sheetDocumentName('abc', 's1')).toBe('abc/sheet/s1');
    expect(bodyDocumentName('abc')).toBe('abc/body');
  });

  it('按 kind 返回需要连接的文档名列表', () => {
    expect(documentNamesFor('abc', 'doc')).toEqual(['abc/body']);
    expect(documentNamesFor('abc', 'sheet')).toEqual(['abc/workbook', 'abc/sheet/main']);
    expect(documentNamesFor('abc', 'mindmap')).toEqual(['abc/mind']);
  });

  it('从文档名反解文档 id 并识别 sheet', () => {
    expect(docIdFromDocumentName('abc/body')).toBe('abc');
    expect(docIdFromDocumentName('abc')).toBe('abc');
    expect(docIdFromDocumentName('')).toBe('');
    expect(isSheetDocument('abc/sheet/main')).toBe(true);
    expect(isSheetDocument('abc/workbook')).toBe(false);
    expect(isSheetDocument('abc/body')).toBe(false);
  });
});

describe('限额常量', () => {
  it('关键限额符合验收基线', () => {
    expect(LIMITS.maxDocChars).toBe(80_000);
    expect(LIMITS.maxConnectionsPerDoc).toBe(200);
    expect(LIMITS.maxBroadcastCursors).toBe(20);
    expect(LIMITS.cursorBroadcastIntervalMs).toBe(100);
    expect(LIMITS.cursorOwnerStaleMs).toBe(5_000);
    expect(LIMITS.awarenessRepublishMs).toBe(10_000);
    expect(LIMITS.awarenessThrottleMs).toBe(40);
    expect(LIMITS.snapshotIntervalMs).toBe(30_000);
    expect(LIMITS.snapshotUpdateThreshold).toBe(500);
    expect(LIMITS.opLogRetentionDays).toBe(7);
  });

  it('限额之间保持单调关系', () => {
    expect(LIMITS.maxBroadcastCursors).toBeLessThanOrEqual(LIMITS.maxConnectionsPerDoc);
    expect(LIMITS.awarenessThrottleMs).toBeLessThanOrEqual(LIMITS.cursorBroadcastIntervalMs);
    expect(LIMITS.cursorOwnerStaleMs).toBeLessThan(LIMITS.awarenessRepublishMs);
    expect(LIMITS.opLogRetentionDays).toBeLessThanOrEqual(90);
  });
});

describe('一致性哈希分片', () => {
    const shards = ['ws://localhost:1234', 'ws://localhost:1235'];

    it('fnv1a32 稳定且为 32 位无符号整数', () => {
      const hash = fnv1a32('document-1');
      expect(hash).toBe(fnv1a32('document-1'));
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(hash)).toBe(true);
      expect(fnv1a32('')).toBe(0x811c9dc5);
      expect(fnv1a32('a')).not.toBe(fnv1a32('b'));
    });

  it('同一 key 永远落到同一分片', () => {
    for (const key of ['doc-a', 'doc-b', 'doc-c', '0e2f1a3c-...']) {
      expect(pickShard(key, shards)).toBe(pickShard(key, shards));
    }
  });

  it('单个分片直接返回，不建环', () => {
    expect(pickShard('anything', ['ws://only'])).toBe('ws://only');
  });

  it('空分片列表抛错', () => {
    expect(() => pickShard('key', [])).toThrow('pickShard: 分片列表为空');
  });

  it('文档 id 在两个分片间分布合理，且节点变更只迁移少量文档', () => {
    let left = 0;
    let right = 0;
    for (let index = 0; index < 2000; index += 1) {
      const shard = pickShard(`document-${index}`, shards);
      if (shard === shards[0]) left += 1;
      else right += 1;
    }
    expect(left).toBeGreaterThan(700);
    expect(right).toBeGreaterThan(700);

    let migrated = 0;
    for (let index = 0; index < 2000; index += 1) {
      const before = pickShard(`document-${index}`, shards);
      const after = pickShard(`document-${index}`, [...shards, 'ws://localhost:1236']);
      if (before !== after) migrated += 1;
    }
    // 3 节点只应迁移约 1/3 的 key，明显低于“全量重排”的一半以上
    expect(migrated).toBeGreaterThan(0);
    expect(migrated).toBeLessThan(1300);
  });

  it('parseShards 支持字符串与数组，并去除空白和空项', () => {
    expect(parseShards('a|b|c')).toEqual(['a', 'b', 'c']);
    expect(parseShards(' a | b | ')).toEqual(['a', 'b']);
    expect(parseShards(['a', ' b ', ''])).toEqual(['a', 'b']);
    expect(parseShards('')).toEqual([]);
    expect(parseShards([])).toEqual([]);
  });
});
