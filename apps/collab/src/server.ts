import { Database } from '@hocuspocus/extension-database';
import { Server } from '@hocuspocus/server';
import { LIMITS, docIdFromDocumentName, isSpectator, type CollabContext } from '@lingshu/shared';
import { env } from './env.js';
import { authenticateDocument } from './impl/auth.js';
import { persistence } from './impl/persistence.js';

/**
 * 单文档连接配额。按 socketId 记账，避免重复连接/断开时计数漂移。
 * 设计约束：200 人是明确上限，超出后拒绝新连接而不是无限弹性。
 */
const docSockets = new Map<string, Set<string>>();

/**
 * 每个文档当前持有“光标广播槽位”的 Yjs clientId 与最后活跃时间。
 * 200 人场景下光标是主要出站流量来源，只放行最近活跃的 N 个，
 * 其余由前端折叠为“+N 个光标”聚合标记。
 */
const cursorOwners = new Map<string, Map<number, number>>();

/** 每个文档里各客户端最后一次完整状态放行的时间，用于刷新 y-protocols 的超时计数。 */
const awarenessPublishedAt = new Map<string, Map<number, number>>();

/**
 * cursor/selection 之外是否发生了变化。
 * awareness 没有增量编码：一次光标移动会把整份 state（含 user）重新发一遍，
 * 所以只要其余字段没变，这次更新就没有广播价值。
 */
function changedBeyondEphemeral(
  next: Record<string, any>,
  previous: Record<string, any> | undefined,
): boolean {
  if (!previous) return true;
  for (const key of new Set([...Object.keys(next), ...Object.keys(previous)]) as Set<string>) {
    if (key === 'cursor' || key === 'selection') continue;
    if (JSON.stringify(next[key]) !== JSON.stringify(previous[key])) return true;
  }
  return false;
}

/**
 * awareness 出站治理：
 * 1. spectator 只保留在线状态（user），光标/选区一律剥离；
 * 2. 光标广播只放行最近活跃的 LIMITS.maxBroadcastCursors 个写者（槽位超时后让位）；
 * 3. 没有槽位的 client 若本次只有光标/选区变化，整条 state 从广播中剔除——
 *    否则每次移动都会把整份 awareness 重发一遍，200 人 × 25 个窗口 ≈ 30 MB/s。
 *    但 y-protocols 要求状态每 30s 至少更新一次，所以每 LIMITS.awarenessRepublishMs
 *    放行一次完整状态，避免在线成员被服务端按超时移除。
 */
function governAwareness(
  documentName: string,
  states: Map<number, Record<string, any>>,
  current: Map<number, Record<string, any>>,
  readOnly: boolean,
  now: number,
): void {
  const owners = cursorOwners.get(documentName) ?? new Map<number, number>();
  cursorOwners.set(documentName, owners);

  const published = awarenessPublishedAt.get(documentName) ?? new Map<number, number>();
  awarenessPublishedAt.set(documentName, published);

  // 停止移动光标的客户端让出槽位，避免长期占用
  for (const [clientId, lastSeen] of owners) {
    if (now - lastSeen > LIMITS.cursorOwnerStaleMs) owners.delete(clientId);
  }

  for (const [clientId, state] of states) {
    const previous = current.get(clientId);
    let holdsSlot = false;

    if (readOnly) {
      delete state.cursor;
      delete state.selection;
    } else if (owners.has(clientId)) {
      owners.set(clientId, now);
      holdsSlot = true;
    } else if (
      owners.size < LIMITS.maxBroadcastCursors &&
      (state.cursor !== undefined || state.selection !== undefined)
    ) {
      owners.set(clientId, now);
      holdsSlot = true;
    } else {
      delete state.cursor;
      delete state.selection;
    }

    // 持有槽位的人照常广播光标；其余人若只有光标在动，整条不广播，
    // 但定期放行一次，保证服务端不会把它判定为超时离线。
    if (!holdsSlot && !changedBeyondEphemeral(state, previous)) {
      const lastPublished = published.get(clientId) ?? now;
      if (now - lastPublished < LIMITS.awarenessRepublishMs) {
        states.delete(clientId);
        continue;
      }
    }
    published.set(clientId, now);
  }
}

function acquireSlot(documentName: string, socketId: string): void {
  const sockets = docSockets.get(documentName) ?? new Set<string>();
  if (sockets.size >= env.maxDocConnections) {
    throw new Error(`文档连接数已达上限（${env.maxDocConnections}）`);
  }
  sockets.add(socketId);
  docSockets.set(documentName, sockets);
}

function releaseSlot(documentName: string, socketId: string): void {
  const sockets = docSockets.get(documentName);
  if (!sockets) return;
  sockets.delete(socketId);
  if (sockets.size === 0) docSockets.delete(documentName);
}

export function createCollabServer(): Server<CollabContext> {
  return new Server<CollabContext>({
    port: env.port,
    quiet: true,

    // 快照落盘：Hocuspocus 用 debounce / maxDebounce 近似“30 秒或 500 次 update”
    debounce: LIMITS.snapshotIntervalMs,
    maxDebounce: LIMITS.snapshotIntervalMs,

    // awareness 治理第 4 层：服务端合并广播。
    // 窗口内同一 client 的 awareness 折叠为最新状态，200 连接时消息量按窗口收敛。
    flushDelay: env.awarenessThrottleMs,

    extensions: [
      new Database({
        fetch: async ({ documentName }) => persistence.load(documentName),
        store: async ({ documentName, state }) => {
          await persistence
            .saveSnapshot({
              documentName,
              documentId: docIdFromDocumentName(documentName),
              state,
            })
            .catch((error: unknown) => {
              // 存储故障不得打断实时协同
              console.error('[collab] 快照落盘失败', error);
            });
        },
      }),
    ],

    onAuthenticate: async ({ token, documentName, socketId, connectionConfig }) => {
      const result = await authenticateDocument({ token, documentName });
      if (!result.allowed) {
        throw new Error(result.reason);
      }
      acquireSlot(documentName, socketId);
      // spectator：服务端按只读连接处理，写入被丢弃
      connectionConfig.readOnly = result.readOnly;
      return result.context;
    },

    onDisconnect: async ({ documentName, socketId }) => {
      releaseSlot(documentName, socketId);
    },

    beforeHandleAwareness: async ({ states, awareness, context, documentName }) => {
      governAwareness(
        documentName,
        states,
        awareness.getStates(),
        context ? isSpectator(context.role) : false,
        Date.now(),
      );
    },

    afterUnloadDocument: async ({ documentName }) => {
      cursorOwners.delete(documentName);
      awarenessPublishedAt.delete(documentName);
    },

    onChange: async ({ documentName, update }) => {
      // op 流写入不进入广播热路径，失败只记录日志
      void persistence
        .appendOp(documentName, docIdFromDocumentName(documentName), update)
        .catch((error: unknown) => {
          console.error('[collab] op 流写入失败', error);
        });
    },
  });
}
