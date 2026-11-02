/**
 * 分片运行状态上报。
 * 分片把自己当前打开文档数、连接数写入 Redis 并定期续期；
 * API 聚合时既能判断进程是否可达，也能拿到实时负载。
 * 设计约束：心跳只写 Redis，不进入 update/awareness 广播热路径。
 */
export const SHARD_HEALTH_KEY_PREFIX = 'lingshu:shard:';

/** 心跳周期与有效期：进程被杀后最多一个周期就会从聚合结果里消失。 */
export const SHARD_HEARTBEAT_INTERVAL_MS = 5_000;
export const SHARD_HEARTBEAT_TTL_SECONDS = 15;

export interface ShardHeartbeat {
  shardId: string;
  port: number;
  documents: number;
  connections: number;
  startedAt: string;
  at: string;
}
