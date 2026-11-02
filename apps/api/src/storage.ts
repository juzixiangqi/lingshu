import { Client } from 'minio';
import { env } from './env.js';

/** 对象存储：附件、导入导出文件。一期只提供预签名上传地址。 */
export const storage = new Client({
  endPoint: env.s3.endPoint,
  port: env.s3.port,
  useSSL: env.s3.useSSL,
  accessKey: env.s3.accessKey,
  secretKey: env.s3.secretKey,
});

export async function presignUpload(objectName: string, expirySeconds = 600): Promise<string> {
  return storage.presignedPutObject(env.s3.bucket, objectName, expirySeconds);
}

let bucketReady: Promise<void> | null = null;

/** 首次上传时按需建桶；失败后清空缓存，下次请求可重试。 */
export function ensureBucket(): Promise<void> {
  if (!bucketReady) {
    bucketReady = (async () => {
      if (!(await storage.bucketExists(env.s3.bucket))) {
        await storage.makeBucket(env.s3.bucket, 'us-east-1');
      }
    })().catch((error: unknown) => {
      bucketReady = null;
      throw error;
    });
  }
  return bucketReady;
}

/** 读取对象字节流，供 API 代理图片（<img> 无法携带 Authorization）。 */
export function openObject(objectName: string) {
  return storage.getObject(env.s3.bucket, objectName);
}

export function statObject(objectName: string) {
  return storage.statObject(env.s3.bucket, objectName);
}

export const storageBucket = env.s3.bucket;
