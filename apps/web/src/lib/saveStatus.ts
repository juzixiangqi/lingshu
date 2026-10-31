import { useEffect, useRef, useState } from 'react';
import { getStorageState } from './api';
import type { CollabSession } from './collab';

export interface SaveStatus {
  text: string;
  tone: 'muted' | 'error';
}

/**
 * 自动保存状态。
 * 数值来自快照落库时间（collab 的 debounce 最长 30s），dirty 由本地 Y.Doc 更新驱动；
 * 轮询到快照时间前进后才把状态切回“已保存”，避免把“本地已改”误报成“已落盘”。
 */
export function useSaveStatus(docId: string, session: CollabSession | null): SaveStatus {
  const latestSavedAt = useRef<string | null>(null);
  const baseline = useRef<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!session) return;

    const onUpdate = (_update: Uint8Array, origin: unknown): void => {
      if (origin === session.provider) return;
      baseline.current = latestSavedAt.current;
      setDirty(true);
    };
    session.doc.on('update', onUpdate);

    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const state = await getStorageState(docId);
        if (cancelled) return;
        latestSavedAt.current = state.savedAt;
        setSavedAt(state.savedAt);
        setFailed(false);
        setDirty((wasDirty) => wasDirty && state.savedAt !== baseline.current);
      } catch {
        if (!cancelled) setFailed(true);
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 5_000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      session.doc.off('update', onUpdate);
    };
  }, [docId, session]);

  if (failed) return { text: '保存状态获取失败', tone: 'error' };
  if (dirty) return { text: '保存中…', tone: 'muted' };
  if (savedAt) {
    const time = new Date(savedAt).toLocaleTimeString('zh-CN', { hour12: false });
    return { text: `已保存 ${time}`, tone: 'muted' };
  }
  return { text: '尚未落盘', tone: 'muted' };
}
