import type { DocKind } from './types.js';

/**
 * Y.Doc 命名约定。
 *
 * 表格（筹）按设计文档做 sheet 级分片：
 *   - `<docId>/workbook`   工作簿元数据（sheet 列表、顺序、权限），更新频率极低
 *   - `<docId>/sheet/<id>` 每个 sheet 独立的 Y.Doc
 * 文档（笺）一期不做真分片，但仍走统一命名规则，为二期分章预留：
 *   - `<docId>/body`
 * 思维导图（图）单文档单 Y.Doc，节点级 CRDT 协同：
 *   - `<docId>/mind`
 */
export function workbookDocumentName(docId: string): string {
  return `${docId}/workbook`;
}

export function sheetDocumentName(docId: string, sheetId = 'main'): string {
  return `${docId}/sheet/${sheetId}`;
}

export function bodyDocumentName(docId: string): string {
  return `${docId}/body`;
}

export function mindDocumentName(docId: string): string {
  return `${docId}/mind`;
}

export function documentNamesFor(docId: string, kind: DocKind): string[] {
  if (kind === 'doc') return [bodyDocumentName(docId)];
  if (kind === 'mindmap') return [mindDocumentName(docId)];
  return [workbookDocumentName(docId), sheetDocumentName(docId)];
}

/** 从 Y.Doc 名称反解文档 id，用于权限校验与持久化归属。 */
export function docIdFromDocumentName(documentName: string): string {
  const index = documentName.indexOf('/');
  return index === -1 ? documentName : documentName.slice(0, index);
}

/** 是否为可写的 Y.Doc（workbook 元数据目前只允许写者同步）。 */
export function isSheetDocument(documentName: string): boolean {
  return documentName.includes('/sheet/');
}
