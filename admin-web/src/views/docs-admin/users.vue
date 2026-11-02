<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { listUsers, type AdminUser } from "@/api/docsAdmin";

const loading = ref(false);
const rows = ref<AdminUser[]>([]);
const total = ref(0);
const query = reactive({ keyword: "", page: 1, pageSize: 10 });

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await listUsers({
      keyword: query.keyword.trim(),
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
      <el-form-item label="关键词">
        <el-input
          v-model="query.keyword"
          placeholder="邮箱 / 昵称 / IM userId"
          clearable
          style="width: 260px"
          @keyup.enter="search"
        />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="search">查询</el-button>
      </el-form-item>
    </el-form>

    <el-table v-loading="loading" :data="rows" stripe>
      <el-table-column prop="displayName" label="姓名" width="150" />
      <el-table-column prop="email" label="邮箱" min-width="220" />
      <el-table-column prop="imUserId" label="IM userId" width="140">
        <template #default="{ row }">{{ row.imUserId ?? "-" }}</template>
      </el-table-column>
      <el-table-column prop="docCount" label="参与文档" width="110" />
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
</style>
