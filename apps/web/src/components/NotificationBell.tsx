import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AppNotification } from '@lingshu/shared';
import { getToken, listNotifications, markNotificationsRead } from '../lib/api';

/** 未读数轮询间隔：通知是低频事件，30s 足够且不压 API。 */
const POLL_INTERVAL_MS = 30_000;

/**
 * 站内通知铃铛：@提及 的兜底通道。
 * webhook 推送失败或未配置时，被提及的人仍能在这里看到未读提醒，
 * 点击条目会标记已读并跳到对应文档。
 */
export function NotificationBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState('');

  const refresh = useCallback(async (): Promise<void> => {
    if (!getToken()) return;
    try {
      const data = await listNotifications();
      setNotifications(data.notifications);
      setUnread(data.unread);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载通知失败');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    const onFocus = (): void => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  async function handleOpen(item: AppNotification): Promise<void> {
    try {
      setUnread(await markNotificationsRead([item.id]));
    } catch {
      // 标记失败不影响跳转
    }
    navigate(item.documentKind === 'sheet' ? `/sheet/${item.documentId}` : `/doc/${item.documentId}`);
  }

  async function handleReadAll(): Promise<void> {
    try {
      setUnread(await markNotificationsRead());
      setNotifications((current) =>
        current.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '标记已读失败');
    }
  }

  return (
    <>
      <button
        onClick={() => {
          setOpen((value) => !value);
          void refresh();
        }}
      >
        {unread > 0 ? `通知（${unread}）` : '通知'}
      </button>
      {open ? (
        <div className="member-overlay" onClick={() => setOpen(false)}>
          <aside className="member-panel" onClick={(event) => event.stopPropagation()}>
            <header className="member-header">
              <strong>站内通知</strong>
              <div className="member-actions">
                {unread > 0 ? (
                  <button onClick={() => void handleReadAll()}>全部已读</button>
                ) : null}
                <button className="link-button" onClick={() => setOpen(false)}>
                  关闭
                </button>
              </div>
            </header>

            {error ? <p className="error">{error}</p> : null}

            {notifications.length === 0 ? (
              <p className="muted">还没有通知。被 @提及 时会出现在这里。</p>
            ) : (
              <ul className="member-list">
                {notifications.map((item) => (
                  <li
                    key={item.id}
                    className={item.readAt ? 'notification-item' : 'notification-item unread'}
                  >
                    <button className="notification-link" onClick={() => void handleOpen(item)}>
                      <span className="member-name">
                        {item.actorName}
                        {' 在 '}
                        {item.documentTitle}
                        {' 中提及了你'}
                      </span>
                      {item.excerpt ? <span className="notification-excerpt">{item.excerpt}</span> : null}
                      <span className="muted">{new Date(item.createdAt).toLocaleString('zh-CN')}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>
      ) : null}
    </>
  );
}
