import { timingSafeEqual } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { env } from './env.js';
import { query } from './db.js';

export interface AdminOperator {
  id: string;
  name: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    adminOperator: AdminOperator;
  }
}

/** HTTP 头只允许 ASCII，管理端传中文昵称时需要 URL 编码，这里做一次容错解码。 */
function decodeHeaderValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 取调用方 IP：优先 socket 远端地址，避免伪造 X-Forwarded-For 绕过白名单。
 * 只有拿不到远端地址时（例如测试环境用 app.request）才退回代理头。
 */
function callerIp(c: Context): string {
  try {
    const address = getConnInfo(c).remote.address ?? '';
    if (address) return address.startsWith('::ffff:') ? address.slice(7) : address;
  } catch {
    // 非 Node 适配器，退回代理头
  }
  return (c.req.header('x-forwarded-for') ?? '').split(',')[0]?.trim() ?? '';
}

/**
 * 管理 API 鉴权：与用户 token 完全隔离。
 * 令牌未配置时返回 404，表现成“路由不存在”，避免误把管理接口暴露出去。
 */
export const requireAdminService = createMiddleware(async (c, next) => {
  if (!env.internalAdmin.token) {
    return c.json({ error: 'not found' }, 404);
  }

  const token = c.req.header('x-service-token') ?? '';
  if (!safeEqual(token, env.internalAdmin.token)) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  if (env.internalAdmin.ips.length > 0) {
    const ip = callerIp(c);
    if (!env.internalAdmin.ips.includes(ip)) {
      return c.json({ error: 'forbidden' }, 403);
    }
  }

  const operatorId = (c.req.header('x-operator-id') ?? '').trim();
  if (!operatorId) {
    return c.json({ error: '缺少操作人标识（X-Operator-Id）' }, 400);
  }
  c.set('adminOperator', {
    id: operatorId,
    name: decodeHeaderValue((c.req.header('x-operator-name') ?? '').trim()),
  });

  await next();
});

/**
 * 写管理操作审计。审计失败只记录日志，不回滚已完成的业务操作；
 * 需要强一致的场景应由管理端自行以事务编排。
 */
export async function writeAudit(input: {
  operator: AdminOperator;
  action: string;
  targetType: string;
  targetId: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    await query(
      `insert into admin_audit_logs (operator_id, operator_name, action, target_type, target_id, detail)
       values ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        input.operator.id,
        input.operator.name,
        input.action,
        input.targetType,
        input.targetId,
        JSON.stringify(input.detail ?? {}),
      ],
    );
  } catch (error) {
    console.error('[admin] 审计日志写入失败', error instanceof Error ? error.message : error);
  }
}
