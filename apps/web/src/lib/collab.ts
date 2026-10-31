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
