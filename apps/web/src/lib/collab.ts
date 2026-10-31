import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import type { DocDetail } from '@lingshu/shared';
import { getToken } from './api';

export interface CollabSession {
  documentName: string;
  doc: Y.Doc;
  provider: HocuspocusProvider;
}

/**
 * 连接文档所属的协同分片。
 * 分片地址由 API 按 document_id 做一致性哈希给出，前端不自行选片。
 */
export function connectDocument(detail: DocDetail, documentName: string): CollabSession {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: detail.collab.url,
    name: documentName,
    token: getToken() ?? '',
    document: doc,
  });
  return { documentName, doc, provider };
}

export function destroySession(session: CollabSession): void {
  session.provider.destroy();
  session.doc.destroy();
}

/** 历史版本快照以 base64 传输，这里转回 Yjs 二进制。 */
export function decodeSnapshot(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * 表格恢复用的一次性协同消息：opLog 被整体替换后，其他客户端无法增量应用，
 * 必须重载页面重建 Univer；服务端只转发这一种控制消息。
 */
export { RESTORE_STATELESS_PAYLOAD as RESTORE_STATELESS } from '@lingshu/shared';
