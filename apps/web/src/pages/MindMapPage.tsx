import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import MindElixir from 'mind-elixir';
import 'mind-elixir/style.css';
import type { MindElixirData, MindElixirInstance } from 'mind-elixir';
import * as Y from 'yjs';
import type { DocDetail, DocVersionSnapshot } from '@lingshu/shared';
import {
  collabStatusLabel,
  connectDocument,
  decodeSnapshot,
  destroySession,
  type CollabSession,
} from '../lib/collab';
import {
  initializeMind,
  mindDataFromTree,
  readTree,
  treeFromMindData,
  treeSignature,
  writeTree,
  type MindNodeMap,
  type MindNodeRecord,
} from '../lib/mindmap';
import { getCurrentUser, getDoc, getToken, updateDocIcon } from '../lib/api';
import { useSaveStatus } from '../lib/saveStatus';
import { DocIconPicker } from '../components/DocIconPicker';
import { MemberPanel } from '../components/MemberPanel';
import { NotificationBell } from '../components/NotificationBell';
import { VersionPanel } from '../components/VersionPanel';

const ROLE_LABEL: Record<DocDetail['role'], string> = {
  owner: '所有者',
  editor: '可编辑',
  spectator: '只读',
};

/** 远端协作者的选中态：节点 id 来自 awareness，不落库。 */
interface PeerPresence {
  clientId: number;
  userId: string;
  name: string;
  color: string;
  selection: string[];
}

const PRESENCE_COLORS = [
  '#2f6fed',
  '#0f9d76',
  '#d97706',
  '#c026d3',
  '#dc2626',
  '#0891b2',
  '#7c3aed',
  '#db2777',
];

/** 同一用户在固定文档里的颜色保持稳定，刷新后不会变色。 */
function presenceColor(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return PRESENCE_COLORS[hash % PRESENCE_COLORS.length] ?? '#2f6fed';
}

type RestoreHandler = (snapshot: DocVersionSnapshot) => Promise<void>;
type SelectNodesArg = Parameters<MindElixirInstance['selectNodes']>[0];

interface BoardProps {
  detail: DocDetail;
  session: CollabSession;
  registerRestore: (handler: RestoreHandler | null) => void;
  statusText: string;
  saveText: string;
}

/** 正在编辑节点文本时不要用远端数据重建画布，否则输入框会被销毁。 */
function isEditingNode(container: HTMLElement): boolean {
  const active = document.activeElement;
  return !!active && active !== container && container.contains(active);
}

/**
 * 导图协同：mind-elixir 负责渲染交互，Y.Doc 里存扁平节点表。
 * 本地操作做 150ms 合并后写回，远端变更按节点级差异重建画布。
 */
function MindMapBoard({ detail, session, registerRestore, statusText, saveText }: BoardProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const mindRef = useRef<MindElixirInstance | null>(null);
  const layoutRef = useRef<((direction: number) => void) | null>(null);
  const [hint, setHint] = useState('');
  const [peers, setPeers] = useState<PeerPresence[]>([]);
  const [direction, setDirection] = useState<number>(MindElixir.SIDE);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    let disposed = false;
    let mind: MindElixirInstance | null = null;
    let pushTimer: number | undefined;
    let selectionTimer: number | undefined;
    let pendingRemote: MindElixirData | null = null;
    let pendingSelection: string[] = [];
    let remotePeers: PeerPresence[] = [];
    let applyingDirection = false;
    let onFocusOut: (() => void) | null = null;
    let onPointerDown: (() => void) | null = null;

    const nodes: MindNodeMap = session.doc.getMap<MindNodeRecord>('nodes');
    // 布局方向是文档级状态，和节点分开存，避免 writeTree 清理时误删
    const config = session.doc.getMap<number>('config');
    const editable = detail.role !== 'spectator';
    const awareness = session.provider.awareness;
    const me = getCurrentUser();
    const meId = me?.id ?? 'anonymous';

    const collectPeers = (): PeerPresence[] => {
      if (!awareness) return [];
      const collected: PeerPresence[] = [];
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID) return;
        const info = state?.user as { id?: string; name?: string; color?: string } | undefined;
        if (!info) return;
        const userId = info.id ?? `client-${clientId}`;
        collected.push({
          clientId,
          userId,
          name: info.name ?? '匿名',
          color: info.color ?? presenceColor(userId),
          selection: Array.isArray(state?.selection)
            ? (state.selection as unknown[]).filter((id): id is string => typeof id === 'string')
            : [],
        });
      });
      return collected;
    };

    /** 把远端选中态画到节点上；节点重建后需要重新调用。 */
    const paintPresence = (): void => {
      if (!mind) return;
      el.querySelectorAll<HTMLElement>('me-tpc.remote-selected').forEach((node) => {
        node.classList.remove('remote-selected');
        node.style.removeProperty('--presence-color');
        node.querySelectorAll('.mindmap-presence-tag').forEach((tag) => tag.remove());
      });
      const byNode = new Map<string, PeerPresence[]>();
      for (const peer of remotePeers) {
        for (const nodeId of peer.selection) {
          const owners = byNode.get(nodeId) ?? [];
          owners.push(peer);
          byNode.set(nodeId, owners);
        }
      }
      if (byNode.size === 0) return;
      el.querySelectorAll<HTMLElement>('me-tpc').forEach((node) => {
        // 正在输入的节点不要插入标签，避免影响 contenteditable 光标
        if (node.querySelector('#input-box')) return;
        const nodeId = node.dataset.nodeid?.slice(2) ?? '';
        const owners = byNode.get(nodeId);
        const primary = owners?.[0];
        if (!owners || !primary) return;
        node.classList.add('remote-selected');
        node.style.setProperty('--presence-color', primary.color);
        const tag = document.createElement('span');
        tag.className = 'mindmap-presence-tag';
        tag.textContent = owners.map((owner) => owner.name).join('、');
        node.appendChild(tag);
      });
    };

    const onAwarenessChange = (): void => {
      if (disposed) return;
      remotePeers = collectPeers();
      setPeers(remotePeers);
      paintPresence();
    };

    const pushLocal = (): void => {
      if (!mind || !editable) return;
      window.clearTimeout(pushTimer);
      pushTimer = window.setTimeout(() => {
        if (!mind || disposed) return;
        writeTree(nodes, treeFromMindData(mind.getData()));
        window.requestAnimationFrame(paintPresence);
      }, 150);
    };

    /** 选中态按 120ms 合并后广播，避免点击时 unselect + select 让远端闪烁。 */
    const broadcastSelection = (ids: string[]): void => {
      if (!awareness || !editable) return;
      pendingSelection = ids;
      window.clearTimeout(selectionTimer);
      selectionTimer = window.setTimeout(() => {
        awareness.setLocalStateField('selection', pendingSelection);
      }, 120);
    };

    const onSelectNodes = (selection: { id: string }[]): void => {
      broadcastSelection(selection.map((item) => item.id));
    };
    const onUnselectNodes = (): void => broadcastSelection([]);

    const captureSelection = (): string[] =>
      mind
        ? mind.currentNodes.map((node) => node.nodeObj?.id).filter((id): id is string => !!id)
        : [];

    const restoreSelection = (ids: string[]): void => {
      if (!mind || ids.length === 0) return;
      const targets: SelectNodesArg = [];
      el.querySelectorAll<HTMLElement>('me-tpc').forEach((node) => {
        const nodeId = node.dataset.nodeid?.slice(2) ?? '';
        if (ids.includes(nodeId)) targets.push(node as SelectNodesArg[number]);
      });
      if (targets.length > 0) mind.selectNodes(targets);
    };

    const renderRemote = (data: MindElixirData): void => {
      if (!mind) return;
      // refresh 会重建节点并清空选择，先记住再恢复
      const selected = captureSelection();
      mind.refresh(data);
      // 远端刷新后旧的撤销栈会指向别人分支的历史，必须重置
      mind.clearHistory?.();
      restoreSelection(selected);
      window.requestAnimationFrame(paintPresence);
    };

    const applyRemote = (): void => {
      if (!mind || disposed) return;
      const remoteTree = readTree(nodes);
      const data = mindDataFromTree(remoteTree);
      if (!data) return;
      // 本地刚写回的数据也会触发 observe，签名一致时跳过重建
      if (treeSignature(treeFromMindData(mind.getData())) === treeSignature(remoteTree)) return;
      if (isEditingNode(el)) {
        pendingRemote = data;
        return;
      }
      renderRemote(data);
    };

    const flushPending = (): void => {
      if (!mind || !pendingRemote) return;
      renderRemote(pendingRemote);
      pendingRemote = null;
    };

    const switchDirection = (next: number): void => {
      if (!mind) return;
      const selected = captureSelection();
      mind.clearSelection();
      switch (next) {
        case MindElixir.LEFT:
          mind.initLeft();
          break;
        case MindElixir.RIGHT:
          mind.initRight();
          break;
        case MindElixir.DOWN:
          mind.initDown();
          break;
        default:
          mind.initSide();
          break;
      }
      setDirection(mind.direction);
      restoreSelection(selected);
      window.requestAnimationFrame(paintPresence);
    };

    /** 本地切布局：init* 会触发 changeDirection，监听器把方向写进 Y.Doc。 */
    const onDirectionChange = (next: number): void => {
      if (applyingDirection) return;
      if (config.get('direction') !== next) config.set('direction', next);
    };

    /** 远端切布局：直接重建画布，不反向写回。 */
    const applyStoredDirection = (): void => {
      const next = config.get('direction');
      if (!mind || typeof next !== 'number' || next < 0 || next > 3) return;
      if (next === mind.direction) return;
      applyingDirection = true;
      try {
        switchDirection(next);
      } finally {
        applyingDirection = false;
      }
    };

    const waitSynced = async (): Promise<boolean> => {
      if (session.provider.synced) return true;
      const deadline = Date.now() + 15_000;
      while (!disposed && Date.now() < deadline) {
        if (session.provider.synced) return true;
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
      return session.provider.synced;
    };

    if (awareness) {
      awareness.setLocalStateField('user', {
        id: meId,
        name: me?.displayName ?? '匿名',
        color: presenceColor(meId),
      });
      awareness.setLocalStateField('selection', []);
      awareness.on('change', onAwarenessChange);
    }

    void (async () => {
      const synced = await waitSynced();
      if (disposed) return;
      if (!synced) {
        setHint('协同连接超时，导图暂时不可编辑');
        return;
      }

      initializeMind(nodes, detail.title);
      const initial = mindDataFromTree(readTree(nodes));
      if (!initial) return;

      const storedDirection = config.get('direction');
      const initialDirection: 0 | 1 | 2 | 3 =
        typeof storedDirection === 'number' && storedDirection >= 0 && storedDirection <= 3
          ? (storedDirection as 0 | 1 | 2 | 3)
          : MindElixir.SIDE;

      mind = new MindElixir({
        el,
        direction: initialDirection,
        editable,
        keypress: editable,
        contextMenu: editable,
        toolBar: false,
        allowUndo: editable,
        newTopicName: '新主题',
        // 飞书式交互：Enter 同级、Tab 子级、F2 编辑、Delete 删除、Ctrl+Z 撤销
        theme: {
          ...MindElixir.THEME,
          cssVar: {
            ...MindElixir.THEME.cssVar,
            '--main-color': '#2f6fed',
            '--main-bgcolor': '#eef4ff',
            '--main-bgcolor-transparent': 'rgba(47, 111, 237, 0.12)',
            '--selected': '#2f6fed',
            '--accent-color': '#2f6fed',
          },
        },
      });
      mind.init(initial);
      mindRef.current = mind;
      setDirection(initialDirection);

      // 撤销/重做不会触发 operation 事件，必须手动把结果写回 Y.Doc
      const rawUndo = mind.undo;
      const rawRedo = mind.redo;
      mind.undo = () => {
        if (!mind) return;
        rawUndo.call(mind);
        pushLocal();
      };
      mind.redo = () => {
        if (!mind) return;
        rawRedo.call(mind);
        pushLocal();
      };

      layoutRef.current = (next: number) => {
        if (!mind || !editable || next === mind.direction) return;
        switchDirection(next);
      };

      // mind-elixir 的快捷键挂在容器上，点击节点后必须让容器持有焦点，Tab/Enter 才生效
      onPointerDown = () => {
        if (!el.contains(document.activeElement)) el.focus();
      };
      el.addEventListener('pointerdown', onPointerDown, true);

      nodes.observe(applyRemote);
      config.observe(applyStoredDirection);
      mind.bus.addListener('operation', pushLocal);
      mind.bus.addListener('expandNode', pushLocal);
      mind.bus.addListener('changeDirection', onDirectionChange);
      mind.bus.addListener('selectNodes', onSelectNodes);
      mind.bus.addListener('unselectNodes', onUnselectNodes);

      onFocusOut = () => window.setTimeout(flushPending, 0);
      el.addEventListener('focusout', onFocusOut);

      // 初始就把在线成员画出来；若此前已有远端状态，这里补一次
      onAwarenessChange();

      registerRestore(async (snapshot: DocVersionSnapshot) => {
        if (!editable) throw new Error('只读成员不能恢复版本');
        if (snapshot.documentName !== session.documentName) {
          throw new Error('版本与当前导图不匹配');
        }
        const restored = new Y.Doc();
        try {
          Y.applyUpdate(restored, decodeSnapshot(snapshot.base64));
          const tree = readTree(restored.getMap<MindNodeRecord>('nodes'));
          if (tree.size === 0) throw new Error('该版本没有导图内容');
          writeTree(nodes, tree);
        } finally {
          restored.destroy();
        }
      });
    })();

    return () => {
      disposed = true;
      window.clearTimeout(pushTimer);
      window.clearTimeout(selectionTimer);
      nodes.unobserve(applyRemote);
      config.unobserve(applyStoredDirection);
      if (awareness) {
        awareness.off('change', onAwarenessChange);
        awareness.setLocalStateField('selection', []);
      }
      if (mind) {
        mind.bus.removeListener('operation', pushLocal);
        mind.bus.removeListener('expandNode', pushLocal);
        mind.bus.removeListener('changeDirection', onDirectionChange);
        mind.bus.removeListener('selectNodes', onSelectNodes);
        mind.bus.removeListener('unselectNodes', onUnselectNodes);
      }
      if (onFocusOut) el.removeEventListener('focusout', onFocusOut);
      if (onPointerDown) el.removeEventListener('pointerdown', onPointerDown, true);
      layoutRef.current = null;
      registerRestore(null);
      mind?.destroy();
      mind = null;
      mindRef.current = null;
    };
  }, [detail.id, detail.title, detail.role, session, registerRestore]);

  function currentTopic(): NonNullable<MindElixirInstance['currentNode']> | null {
    return mindRef.current?.currentNode ?? null;
  }

  function addChild(): void {
    const mind = mindRef.current;
    if (!mind) return;
    void mind.addChild(currentTopic() ?? undefined);
  }

  function addSibling(): void {
    const mind = mindRef.current;
    if (!mind) return;
    void mind.insertSibling('after', currentTopic() ?? undefined);
  }

  function removeSelected(): void {
    const mind = mindRef.current;
    const topic = currentTopic();
    if (!mind || !topic) {
      setHint('请先选中一个主题');
      return;
    }
    void mind.removeNodes([topic]);
  }

  function undo(): void {
    mindRef.current?.undo();
  }

  function redo(): void {
    mindRef.current?.redo();
  }

  async function exportPng(): Promise<void> {
    const mind = mindRef.current;
    if (!mind) return;
    const blob = await mind.exportPng();
    if (!blob) {
      setHint('导出失败');
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${detail.title}.png`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const editable = detail.role !== 'spectator';

  return (
    <section className="mindmap-shell">
      <div className="mindmap-toolbar">
        <button onClick={() => addChild()} disabled={!editable} title="Tab">
          子主题
        </button>
        <button onClick={() => addSibling()} disabled={!editable} title="Enter">
          同级主题
        </button>
        <button onClick={() => removeSelected()} disabled={!editable} title="Delete">
          删除
        </button>
        <button onClick={() => undo()} disabled={!editable} title="Ctrl+Z">
          撤销
        </button>
        <button onClick={() => redo()} disabled={!editable} title="Ctrl+Shift+Z / Ctrl+Y">
          重做
        </button>
        <span className="mindmap-divider" />
        <select
          className="mindmap-layout"
          value={direction}
          disabled={!editable}
          title="结构布局"
          onChange={(event) => layoutRef.current?.(Number(event.target.value))}
        >
          <option value={MindElixir.SIDE}>两侧</option>
          <option value={MindElixir.RIGHT}>向右</option>
          <option value={MindElixir.LEFT}>向左</option>
          <option value={MindElixir.DOWN}>向下</option>
        </select>
        <span className="mindmap-divider" />
        <button onClick={() => mindRef.current?.scale(mindRef.current.scaleVal * 1.2)}>放大</button>
        <button onClick={() => mindRef.current?.scale(mindRef.current.scaleVal / 1.2)}>缩小</button>
        <button onClick={() => mindRef.current?.scaleFit()}>适应画布</button>
        <span className="mindmap-divider" />
        <button onClick={() => void exportPng()}>导出 PNG</button>
        <span className="mindmap-hint muted">
          {hint ||
            (editable
              ? 'Tab 子主题 · Enter 同级 · Shift+Enter 上方 · Ctrl+Enter 父级 · F2 编辑 · Delete 删除 · Ctrl+Z 撤销'
              : '只读模式')}
        </span>
        <div className="mindmap-presence-bar">
          {peers.map((peer) => (
            <span
              key={peer.clientId}
              className="mindmap-presence-avatar"
              style={{ background: peer.color }}
              title={`${peer.name}${peer.selection.length > 0 ? '（正在选中主题）' : ''}`}
            >
              {peer.name.slice(0, 1)}
            </span>
          ))}
        </div>
      </div>
      <div className="mindmap-canvas" ref={canvasRef} tabIndex={0} />
      <footer className="editor-status">
        <span className="muted">{statusText}</span>
        <span className="muted">{saveText}</span>
      </footer>
    </section>
  );
}

export function MindMapPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<DocDetail | null>(null);
  // 文档内嵌导图时用 iframe 打开 ?embed=1：隐藏顶栏，只保留画布
  const [searchParams] = useSearchParams();
  const embed = searchParams.get('embed') === '1';
  const [session, setSession] = useState<CollabSession | null>(null);
  const [status, setStatus] = useState('连接中');
  const [error, setError] = useState('');
  const save = useSaveStatus(id ?? '', session);

  const handleDocIcon = useCallback(
    async (next: string | null) => {
      if (!detail) return;
      try {
        const updated = await updateDocIcon(detail.id, next);
        setDetail(updated);
        setError('');
      } catch (err) {
        setError(err instanceof Error ? err.message : '设置图标失败');
        throw err;
      }
    },
    [detail],
  );

  const restoreRef = useRef<RestoreHandler | null>(null);
  const registerRestore = useCallback((handler: RestoreHandler | null) => {
    restoreRef.current = handler;
  }, []);

  const restore = useCallback(async (snapshot: DocVersionSnapshot) => {
    const handler = restoreRef.current;
    if (!handler) throw new Error('编辑器尚未就绪，请稍后重试');
    await handler(snapshot);
  }, []);

  useEffect(() => {
    if (!id) return;
    const docId = id;
    let cancelled = false;
    let created: CollabSession | null = null;

    void (async () => {
      try {
        const doc = await getDoc(docId);
        if (cancelled) return;
        if (doc.kind !== 'mindmap') throw new Error('该文档不是思维导图');
        setDetail(doc);

        const documentName = doc.collab.documentNames[0];
        if (!documentName) throw new Error('文档缺少协同目标');

        created = connectDocument(doc, documentName);
        created.provider.on('status', (event: { status: string }) => {
          setStatus(collabStatusLabel(event.status));
        });
        created.provider.on('close', ({ event }: { event?: { code?: number } }) => {
          if (event?.code !== 1000) return;
          setStatus('已被移出本文档');
          setError('你已不在该文档的协作成员中，本地编辑不会再同步');
        });
        created.provider.on('synced', () => setStatus('已同步'));
        if (!cancelled) setSession(created);
      } catch (err) {
        if (cancelled) return;
        if (!getToken()) {
          navigate('/login', { replace: true });
          return;
        }
        setError(err instanceof Error ? err.message : '打开导图失败');
      }
    })();

    return () => {
      cancelled = true;
      if (created) destroySession(created);
    };
  }, [id, navigate]);

  return (
    <div className={embed ? 'page page-wide mindmap-embed-page' : 'page page-wide'}>
      {embed ? null : (
      <header className="topbar">
        <div>
          <div className="doc-title-row">
            {detail ? (
              <DocIconPicker
                icon={detail.icon}
                kind={detail.kind}
                editable={detail.role !== 'spectator'}
                onChange={handleDocIcon}
              />
            ) : null}
            <h1>{detail?.title ?? '思维导图'}</h1>
          </div>
          <p className="muted">{detail ? ROLE_LABEL[detail.role] : '加载中…'}</p>
        </div>
        <div className="actions">
          <NotificationBell />
          {detail ? <VersionPanel docId={detail.id} role={detail.role} onRestore={restore} /> : null}
          {detail ? <MemberPanel docId={detail.id} role={detail.role} /> : null}
          <button onClick={() => navigate('/')}>返回列表</button>
        </div>
      </header>
      )}

      {error ? <p className="error">{error}</p> : null}

      <main className="mindmap-main">
        {detail && session ? (
          <MindMapBoard
            detail={detail}
            session={session}
            registerRestore={registerRestore}
            statusText={status}
            saveText={save.text}
          />
        ) : null}
      </main>
    </div>
  );
}
