import { Hono } from 'hono';
import { Readable } from 'node:stream';
import { openObject, statObject } from '../storage.js';

const DOC_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|jpeg|gif|webp|pdf|docx|xlsx|pptx|zip|txt|csv)$/i;

const FALLBACK_TYPE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
};

export const fileRoutes = new Hono();

/**
 * 文件读取代理：`<img>` / 下载链接无法携带 Authorization，因此这里不做成员鉴权，
 * 依靠文档内嵌的不可枚举对象名（UUID）限制访问；MinIO 始终只在内网可达。
 */
fileRoutes.get('/docs/:docId/:file', async (c) => {
  const docId = c.req.param('docId');
  const file = c.req.param('file');
  if (!DOC_ID_RE.test(docId) || !FILE_RE.test(file)) {
    return c.json({ error: 'not found' }, 404);
  }

  const ext = file.split('.').pop()?.toLowerCase() ?? '';
  const objectName = `docs/${docId}/${file}`;

  try {
    const [stream, stat] = await Promise.all([openObject(objectName), statObject(objectName)]);
    const contentType =
      stat.metaData?.['content-type'] ?? stat.metaData?.['Content-Type'] ?? FALLBACK_TYPE[ext] ?? 'application/octet-stream';
    const body = Readable.toWeb(stream as Readable) as unknown as ReadableStream;
    return c.body(body, 200, {
      'content-type': contentType,
      // 对象名带 UUID，内容不可变，可长期缓存
      'cache-control': 'public, max-age=31536000, immutable',
      // 禁止浏览器把未知类型嗅探成可执行内容（附件里可能有 HTML）
      'x-content-type-options': 'nosniff',
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'NoSuchKey' || code === 'NotFound') return c.json({ error: 'not found' }, 404);
    throw error;
  }
});
