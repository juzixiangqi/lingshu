import type { DocKind } from '@lingshu/shared';
import { env } from './env.js';

/** webhook 推送体：字段稳定，接收方（灵犀或自建网关）可直接按 type 分发。 */
export interface MentionWebhookPayload {
  type: 'mention';
  documentId: string;
  documentTitle: string;
  documentKind: DocKind;
  url: string;
  actor: { id: string; displayName: string };
  recipients: Array<{ id: string; displayName: string; email: string }>;
  excerpt: string;
  occurredAt: string;
}

/**
 * 推送到外部 IM（灵犀）。站内通知已经落库，这里失败不影响提及本身成功，
 * 只在响应里带状态，便于排查配置问题。
 */
export async function sendMentionWebhook(
  payload: MentionWebhookPayload,
): Promise<'sent' | 'skipped' | 'failed'> {
  if (!env.lingxiWebhookUrl) return 'skipped';
  try {
    const response = await fetch(env.lingxiWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}
