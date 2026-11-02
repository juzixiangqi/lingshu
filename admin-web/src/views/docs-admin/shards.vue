<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { listShards, type AdminShardStatus } from "@/api/docsAdmin";

const REFRESH_MS = 10_000;

const loading = ref(false);
const rows = ref<AdminShardStatus[]>([]);
const summary = ref({ healthy: 0, total: 0 });
let timer: number | undefined;

function formatUptime(seconds: number | null): string {
  if (seconds === null) return "-";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分 ${seconds % 60} 秒`;
}

function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN") : "-";
}

async function load(): Promise<void> {
  // 自动刷新时上一轮可能还没返回，避免并发重复请求
  if (loading.value) return;
  loading.value = true;
  try {
    const result = await listShards();
    rows.value = result.items;
    summary.value = { healthy: result.healthy, total: result.total };
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "加载失败");
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
  timer = window.setInterval(() => void load(), REFRESH_MS);
});

onUnmounted(() => {
  if (timer !== undefined) window.clearInterval(timer);
});
</script>

<template>
  <div>
    <el-row :gutter="12" class="stat-row">
      <el-col :xs="12" :sm="8">
        <el-card shadow="never">
          <div class="stat-label">分片总数</div>
          <div class="stat-value">{{ summary.total }}</div>
        </el-card>
      </el-col>
      <el-col :xs="12" :sm="8">
        <el-card shadow="never">
          <div class="stat-label">在线分片</div>
          <div class="stat-value">{{ summary.healthy }}</div>
        </el-card>
      </el-col>
      <el-col :xs="12" :sm="8">
        <el-card shadow="never">
          <div class="stat-label">不可达</div>
          <div class="stat-value" :class="{ danger: summary.total - summary.healthy > 0 }">
            {{ summary.total - summary.healthy }}
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never">
      <div class="toolbar">
        <span class="muted">每 10 秒自动刷新</span>
        <el-button type="primary" :loading="loading" @click="load">刷新</el-button>
      </div>

      <el-table v-loading="loading" :data="rows" stripe>
        <el-table-column prop="url" label="分片地址" min-width="220" show-overflow-tooltip />
        <el-table-column prop="shardId" label="分片 ID" width="120">
          <template #default="{ row }">{{ row.shardId ?? "-" }}</template>
        </el-table-column>
        <el-table-column label="文档数" width="100">
          <template #default="{ row }">{{ row.documents ?? "-" }}</template>
        </el-table-column>
        <el-table-column label="在线连接" width="100">
          <template #default="{ row }">{{ row.connections ?? "-" }}</template>
        </el-table-column>
        <el-table-column label="运行时长" width="150">
          <template #default="{ row }">{{ formatUptime(row.uptimeSeconds) }}</template>
        </el-table-column>
        <el-table-column label="最近心跳" width="180">
          <template #default="{ row }">{{ formatTime(row.lastHeartbeatAt) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="120">
          <template #default="{ row }">
            <el-tooltip
              :content="row.error ?? '心跳正常'"
              :disabled="!row.error"
              placement="top"
            >
              <el-tag :type="row.reachable ? 'success' : 'danger'">
                {{ row.reachable ? "在线" : "不可达" }}
              </el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
.stat-row {
  margin-bottom: 12px;
}

.stat-label {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.stat-value {
  margin-top: 6px;
  font-size: 24px;
  font-weight: 600;
}

.stat-value.danger {
  color: var(--el-color-danger);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.muted {
  margin-left: auto;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
</style>
