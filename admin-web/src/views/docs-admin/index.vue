<script setup lang="ts">
import { onActivated, onMounted, ref } from "vue";
import { getStats, type AdminStats } from "@/api/docsAdmin";
import DocTable from "./components/DocTable.vue";

const stats = ref<AdminStats | null>(null);

async function loadStats(): Promise<void> {
  try {
    stats.value = await getStats();
  } catch {
    // 统计失败不阻断列表展示
  }
}

onMounted(() => {
  void loadStats();
});

// 从回收站切回本页时（keep-alive 不重新挂载），也刷新一次统计
onActivated(() => {
  void loadStats();
});
</script>

<template>
  <div>
    <el-row :gutter="12" class="stat-row">
      <el-col :xs="12" :sm="6">
        <el-card shadow="never">
          <div class="stat-label">文档总数</div>
          <div class="stat-value">{{ stats?.documents.total ?? "-" }}</div>
        </el-card>
      </el-col>
      <el-col :xs="12" :sm="6">
        <el-card shadow="never">
          <div class="stat-label">文档 / 表格 / 导图</div>
          <div class="stat-value">
            {{ stats ? `${stats.documents.doc} / ${stats.documents.sheet} / ${stats.documents.mindmap}` : "-" }}
          </div>
        </el-card>
      </el-col>
      <el-col :xs="12" :sm="6">
        <el-card shadow="never">
          <div class="stat-label">回收站</div>
          <div class="stat-value">{{ stats?.documents.deleted ?? "-" }}</div>
        </el-card>
      </el-col>
      <el-col :xs="12" :sm="6">
        <el-card shadow="never">
          <div class="stat-label">24 小时活跃</div>
          <div class="stat-value">{{ stats?.activeDocuments24h ?? "-" }}</div>
        </el-card>
      </el-col>
    </el-row>

    <DocTable mode="active" @changed="loadStats" />
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
</style>
