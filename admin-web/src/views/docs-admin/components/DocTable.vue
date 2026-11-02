<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  getDoc,
  listDocs,
  removeDoc,
  removeMember,
  restoreDoc,
  type AdminDoc,
  type AdminDocDetail,
  type AdminMember,
  type DocKind
} from "@/api/docsAdmin";

const props = defineProps<{ mode: "active" | "recycle" }>();
// 删除/恢复会改变全局统计，通知父页面刷新卡片
const emit = defineEmits<{ changed: [] }>();

const KIND_LABEL: Record<DocKind, string> = { doc: "文档", sheet: "表格", mindmap: "导图" };
const ROLE_LABEL: Record<AdminMember["role"], string> = {
  owner: "所有者",
  editor: "可编辑",
  spectator: "只读"
};

const loading = ref(false);
const rows = ref<AdminDoc[]>([]);
const total = ref(0);
const query = reactive({
  keyword: "",
  kind: "" as DocKind | "",
  page: 1,
  pageSize: 10
});

const detailVisible = ref(false);
const detailLoading = ref(false);
const detail = ref<AdminDocDetail | null>(null);

function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN") : "-";
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await listDocs({
      keyword: query.keyword.trim(),
      kind: query.kind,
      page: query.page,
      pageSize: query.pageSize,
      deletedOnly: props.mode === "recycle"
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

function reset(): void {
  query.keyword = "";
  query.kind = "";
  query.page = 1;
  void load();
}

async function openDetail(row: AdminDoc): Promise<void> {
  detailVisible.value = true;
  detailLoading.value = true;
  detail.value = null;
  try {
    detail.value = await getDoc(row.id);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "加载详情失败");
  } finally {
    detailLoading.value = false;
  }
}

async function handleDelete(row: AdminDoc): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除《${row.title}》？删除后可在回收站恢复。`, "删除文档", {
      type: "warning"
    });
  } catch {
    return;
  }
  try {
    await removeDoc(row.id);
    ElMessage.success("已移入回收站");
    await load();
    emit("changed");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "删除失败");
  }
}

async function handleRestore(row: AdminDoc): Promise<void> {
  try {
    await restoreDoc(row.id);
    ElMessage.success("已恢复");
    await load();
    emit("changed");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "恢复失败");
  }
}

async function handleRemoveMember(member: AdminMember): Promise<void> {
  if (!detail.value) return;
  try {
    await ElMessageBox.confirm(`确定移除成员「${member.displayName || member.email}」？`, "移除成员", {
      type: "warning"
    });
  } catch {
    return;
  }
  try {
    const result = await removeMember(detail.value.doc.id, member.userId);
    detail.value.members = result.members;
    ElMessage.success("已移除");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "移除失败");
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <el-card shadow="never">
    <el-form :inline="true" @submit.prevent>
      <el-form-item label="标题">
        <el-input
          v-model="query.keyword"
          placeholder="按标题搜索"
          clearable
          style="width: 220px"
          @keyup.enter="search"
        />
      </el-form-item>
      <el-form-item label="类型">
        <el-select v-model="query.kind" placeholder="全部" clearable style="width: 140px">
          <el-option label="文档" value="doc" />
          <el-option label="表格" value="sheet" />
          <el-option label="导图" value="mindmap" />
        </el-select>
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="search">查询</el-button>
        <el-button @click="reset">重置</el-button>
      </el-form-item>
    </el-form>

    <el-table v-loading="loading" :data="rows" stripe>
      <el-table-column prop="title" label="标题" min-width="200" show-overflow-tooltip />
      <el-table-column label="类型" width="90">
        <template #default="{ row }">{{ KIND_LABEL[row.kind] }}</template>
      </el-table-column>
      <el-table-column label="创建人" min-width="180">
        <template #default="{ row }">
          {{ row.owner.displayName }}
          <span class="muted">（{{ row.owner.email }}）</span>
        </template>
      </el-table-column>
      <el-table-column prop="memberCount" label="成员" width="80" />
      <el-table-column label="更新时间" width="180">
        <template #default="{ row }">{{ formatTime(row.updatedAt) }}</template>
      </el-table-column>
      <el-table-column v-if="mode === 'recycle'" label="删除时间" width="180">
        <template #default="{ row }">{{ formatTime(row.deletedAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="180" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDetail(row)">详情</el-button>
          <el-button v-if="mode === 'active'" link type="danger" @click="handleDelete(row)">
            删除
          </el-button>
          <el-button v-else link type="success" @click="handleRestore(row)">恢复</el-button>
        </template>
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

  <el-dialog v-model="detailVisible" title="文档详情" width="760px">
    <div v-loading="detailLoading">
      <template v-if="detail">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="标题">{{ detail.doc.title }}</el-descriptions-item>
          <el-descriptions-item label="类型">{{ KIND_LABEL[detail.doc.kind] }}</el-descriptions-item>
          <el-descriptions-item label="创建人">
            {{ detail.doc.owner.displayName }}（{{ detail.doc.owner.email }}）
          </el-descriptions-item>
          <el-descriptions-item label="成员数">{{ detail.doc.memberCount }}</el-descriptions-item>
          <el-descriptions-item label="最近保存">
            {{ formatTime(detail.lastSavedAt) }}
          </el-descriptions-item>
          <el-descriptions-item label="版本数">{{ detail.versionCount }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">
            {{ formatTime(detail.doc.createdAt) }}
          </el-descriptions-item>
          <el-descriptions-item label="更新时间">
            {{ formatTime(detail.doc.updatedAt) }}
          </el-descriptions-item>
        </el-descriptions>

        <h4 class="section-title">成员</h4>
        <el-table :data="detail.members" size="small" border>
          <el-table-column prop="displayName" label="姓名" width="120" />
          <el-table-column prop="email" label="邮箱" min-width="200" />
          <el-table-column label="角色" width="110">
            <template #default="{ row }">
              <el-tag :type="row.role === 'owner' ? 'warning' : row.role === 'editor' ? 'success' : 'info'">
                {{ ROLE_LABEL[row.role] }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="加入时间" width="180">
            <template #default="{ row }">{{ formatTime(row.joinedAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="100">
            <template #default="{ row }">
              <el-button
                link
                type="danger"
                :disabled="row.role === 'owner'"
                @click="handleRemoveMember(row)"
              >
                移除
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </template>
    </div>
  </el-dialog>
</template>

<style scoped>
.pager {
  margin-top: 16px;
  justify-content: flex-end;
}

.section-title {
  margin: 20px 0 10px;
  font-size: 14px;
  font-weight: 600;
}

.muted {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
</style>
