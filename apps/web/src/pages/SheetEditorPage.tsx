import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as Y from 'yjs';
import {
  LocaleType,
  createUniver,
  defaultTheme,
  mergeLocales,
  type IWorkbookData,
} from '@univerjs/presets';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import zhCN from '@univerjs/preset-sheets-core/locales/zh-CN';
import '@univerjs/preset-sheets-core/lib/index.css';
import {
  UniverCollabBridgePlugin,
  YjsCollabTransport,
  createSheetsCollabBridgeConfig,
  getCollabBridgeService,
  getCollabBridgeServices,
  type CollabOp,
} from '@8space-lab/univer-collab-bridge';
import { LIMITS, workbookDocumentName, type DocDetail, type DocVersionSnapshot } from '@lingshu/shared';
import { getCurrentUser, getDoc, getToken } from '../lib/api';
import {
  RESTORE_STATELESS,
  connectDocument,
  decodeSnapshot,
  destroySession,
  type CollabSession,
} from '../lib/collab';
import { useSaveStatus } from '../lib/saveStatus';
import { MemberPanel } from '../components/MemberPanel';
import { SheetFileIO } from '../components/SheetFileIO';
import { VersionPanel } from '../components/VersionPanel';

type UniverAPI = ReturnType<typeof createUniver>['univerAPI'];

/**
 * 三个 sheet 用于验证跨 sheet 协同：bridge 的 op 带 subUnitId，
 * 同一个 workbook transport 里不同 sheet 的改动必须互不丢失。
 */
const SHEETS = [
  { id: 's1', name: 'Sheet1' },
  { id: 's2', name: 'Sheet2' },
  { id: 's3', name: 'Sheet3' },
] as const;

function buildWorkbookSnapshot(detail: DocDetail): Partial<IWorkbookData> {
  return {
    id: detail.id,
    name: detail.title,
    sheetOrder: SHEETS.map((sheet) => sheet.id),
    sheets: Object.fromEntries(
      SHEETS.map((sheet) => [
        sheet.id,
        {
          id: sheet.id,
          name: sheet.name,
          rowCount: 200,
          columnCount: 40,
          cellData: sheet.id === 's1' ? { 0: { 0: { v: '灵枢 · 筹' } } } : {},
        },
      ]),
    ),
  } as unknown as Partial<IWorkbookData>;
}

/**
 * bridge 的 onOp 只订阅注册之后的增量，重开表格时历史 op 不会自动回放，
 * 界面会退回空工作簿。这里等首次同步完成、桥服务注册后，再按顺序把 opLog
 * 重新交给 Univer；applyRemoteOp 会按 op.id 去重，因此同步期间已经自动应用
 * 的 op 不会被重复执行。
 */
async function restoreSheetHistory(session: CollabSession, clientId: string): Promise<number> {
  const started = Date.now();
  while (!session.provider.synced) {
    if (Date.now() - started > 30_000) throw new Error('等待协同同步超时');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  let service = getCollabBridgeService(clientId);
  while (!service) {
    if (Date.now() - started > 30_000) throw new Error('协同桥未就绪，无法恢复历史内容');
    await new Promise((resolve) => setTimeout(resolve, 50));
    service = getCollabBridgeService(clientId);
  }

  const ops = session.doc.getArray<CollabOp>('opLog').toArray();
  for (const op of ops) service.applyRemoteOp(op);
  return ops.length;
}

export function SheetEditorPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<DocDetail | null>(null);
  const [session, setSession] = useState<CollabSession | null>(null);
  const [status, setStatus] = useState('连接中');
  const [error, setError] = useState('');
  const [sheetApi, setSheetApi] = useState<UniverAPI | null>(null);
  const save = useSaveStatus(id, session);

  /**
   * 表格版本恢复：把历史快照的 opLog 整体写回当前 Y.Doc，再让所有在线客户端重载。
   * bridge 按 opLog 长度增量消费，无法应用“历史 op 被删除”这种变化，
   * 因此恢复后必须重载页面重建 Univer，而不是就地重放。
   */
  const restore = useCallback(
    async (snapshot: DocVersionSnapshot) => {
      if (!session) throw new Error('表格尚未连接，请稍后重试');
      if (snapshot.documentName !== session.documentName) {
        throw new Error('该版本不属于当前表格');
      }

      const restored = new Y.Doc();
      let ops: CollabOp[];
      try {
        Y.applyUpdate(restored, decodeSnapshot(snapshot.base64));
        ops = JSON.parse(JSON.stringify(restored.getArray<CollabOp>('opLog').toArray())) as CollabOp[];
      } finally {
        restored.destroy();
      }

      const live = session.doc.getArray<CollabOp>('opLog');
      live.delete(0, live.length);
      live.insert(0, ops);

      // 通知同文档的其他客户端重载；本地兜底重载，避免桥状态与 opLog 不一致
      session.provider.sendStateless(RESTORE_STATELESS);
      window.setTimeout(() => window.location.reload(), 800);
    },
    [session],
  );

  useEffect(() => {
    let disposed = false;
    let disposeUniver: (() => void) | null = null;
    let session: ReturnType<typeof connectDocument> | null = null;

    void (async () => {
      try {
        const doc = await getDoc(id);
        if (disposed || !containerRef.current) return;
        setDetail(doc);

        // bridge 的 transport 是 workbook 级：一份 Y.Doc 承载所有 sheet 的 op 流
        const workbookName = workbookDocumentName(doc.id);
        session = connectDocument(doc, workbookName);
        session.provider.on('status', (event: { status: string }) => setStatus(event.status));
        session.provider.on('synced', () => setStatus('已同步'));
        // 其他成员恢复版本后，本端无法增量应用被删除的 op，直接重载重建工作簿
        session.provider.on('stateless', ({ payload }: { payload: string }) => {
          if (payload === RESTORE_STATELESS) window.location.reload();
        });
        if (!disposed) setSession(session);

        const me = getCurrentUser();
        const clientId = String(session.doc.clientID);
        const { univer, univerAPI } = createUniver({
          locale: LocaleType.ZH_CN,
          locales: { [LocaleType.ZH_CN]: mergeLocales(zhCN) },
          theme: defaultTheme,
          presets: [UniverSheetsCorePreset({ container: containerRef.current })],
        });
        disposeUniver = () => univerAPI.dispose();

        univerAPI.createWorkbook(buildWorkbookSnapshot(doc));
        setSheetApi(univerAPI);

        // 插件 type 是 UNIVER_SHEET：必须先有 sheet 类型加载，Univer 才会把它 flush 进来，
        // 所以注册顺序固定为“建工作簿 → 注册桥”。
        univer.registerPlugin(UniverCollabBridgePlugin, {
          ...createSheetsCollabBridgeConfig(),
          clientId,
          user: { id: me?.id ?? clientId, name: me?.displayName ?? '匿名' },
          unitId: doc.id,
          transport: new YjsCollabTransport(session.doc),
        });

        // 重开表格：回放历史 op，否则界面只显示空工作簿
        const replayedOps = await restoreSheetHistory(session, clientId);
        if (disposed) return;
        if (replayedOps > 0) setStatus(`已同步 · 恢复 ${replayedOps} 条历史操作`);

        // M0 验证脚本通过该句柄直接驱动 Univer 命令，等价于用户在单元格里输入
        if (import.meta.env.DEV) {
          (window as unknown as Record<string, unknown>).__lingshuSheet = {
            univerAPI,
            clientId,
            doc: session.doc,
            bridge: () => getCollabBridgeService(clientId),
            services: () => getCollabBridgeServices(),
          };
        }
      } catch (err) {
        if (disposed) return;
        if (!getToken()) {
          navigate('/login', { replace: true });
          return;
        }
        setError(err instanceof Error ? err.message : '打开表格失败');
      }
    })();

    return () => {
      disposed = true;
      disposeUniver?.();
      if (session) destroySession(session);
      setSession(null);
      setSheetApi(null);
    };
  }, [id]);

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>{detail?.title ?? '表格'}</h1>
          <p className="muted">
            {detail
              ? `单文档上限 ${LIMITS.maxConnectionsPerDoc} 人 · ${status} · ${save.text}`
              : '加载中…'}
          </p>
        </div>
        <div className="actions">
          {detail ? (
            <SheetFileIO api={sheetApi} role={detail.role} title={detail.title} />
          ) : null}
          {detail ? <VersionPanel docId={detail.id} role={detail.role} onRestore={restore} /> : null}
          {detail ? <MemberPanel docId={detail.id} role={detail.role} /> : null}
          <button onClick={() => navigate('/')}>返回列表</button>
        </div>
      </header>

      {error ? <p className="error">{error}</p> : null}

      <div className="univer-container" ref={containerRef} />
    </div>
  );
}
