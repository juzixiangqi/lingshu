<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { listAuditLogs, type AuditLog } from "@/api/docsAdmin";

const ACTION_LABEL: Record<string, string> = {
  "doc.delete": "删除文档",
  "doc.restore": "恢复文档",
  "doc.member.remove": "移除成员",
  "doc.owner.transfer": "转让所有者"
};

const loading = ref(false);
const rows = ref<AuditLog[]>([]);
const total = ref(0);
const query = reactive({
  action: "",
  operatorId: "",
  targetId: "",
  page: 1,
  pageSize: 10
});

function formatTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN");
}

function formatDetail(detail: Record<string, unknown>): string {
  const keys = Object.keys(detail);
  return keys.length ? JSON.stringify(detail) : "-";
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await listAuditLogs({
      action: query.action,
      operatorId: query.operatorId.trim(),
      targetId: query.targetId.trim(),
      page: query.page,
      pageSize: query.pageSize
    });
    rows.value = result.items;
    total.value = result.total;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "加载失败");
  } finally {
    loading.value = false;
  }
}

function search(): void {
  query.page = 1;
  void load();
}

onMounted(() => {
  void load();
});
</script>

<template>
  <el-card shadow="never">
    <el-form :inline="true" @submit.prevent>
      <el-form-item label="操作类型">
        <el-select v-model="query.action" placeholder="全部" clearable style="width: 160px">
          <el-option
            v-for="(label, action) in ACTION_LABEL"
            :key="action"
            :label="label"
            :value="action"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="操作人">
        <el-input v-model="query.operatorId" placeholder="操作人 ID" clearable style="width: 160px" />
      </el-form-item>
      <el-form-item label="目标 ID">
        <el-input v-model="query.targetId" placeholder="文档 / 成员 ID" clearable style="width: 260px" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="search">查询</el-button>
      </el-form-item>
    </el-form>

    <el-table v-loading="loading" :data="rows" stripe>
      <el-table-column label="时间" width="180">
        <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="130">
        <template #default="{ row }">{{ ACTION_LABEL[row.action] ?? row.action }}</template>
      </el-table-column>
      <el-table-column label="操作人" width="160">
        <template #default="{ row }">
          {{ row.operatorName || row.operatorId }}
          <span class="muted">（{{ row.operatorId }}）</span>
        </template>
      </el-table-column>
      <el-table-column prop="targetType" label="目标类型" width="160" />
      <el-table-column prop="targetId" label="目标 ID" min-width="260" show-overflow-tooltip>
        <template #default="{ row }">{{ row.targetId ?? "-" }}</template>
      </el-table-column>
      <el-table-column label="详情" min-width="160" show-overflow-tooltip>
        <template #default="{ row }">{{ formatDetail(row.detail) }}</template>
      </el-table-column>
    </el-table>

    <el-pagination
      v-model:current-page="query.page"
      v-model:page-size="query.pageSize"
      class="pager"
      layout="total, sizes, prev, pager, next"
      :page-sizes="[10, 20, 50]"
      :total="total"
      @current-change="load"
      @size-change="search"
    />
  </el-card>
</template>

<style scoped>
.pager {
  margin-top: 16px;
  justify-content: flex-end;
}

.muted {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
</style>
