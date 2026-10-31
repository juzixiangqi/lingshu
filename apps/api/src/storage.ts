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

export const storageBucket = env.s3.bucket;
