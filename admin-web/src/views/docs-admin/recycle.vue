<script setup lang="ts">
import DocTable from "./components/DocTable.vue";
</script>

<template>
  <!-- 页面必须是单根元素，否则拿不到路由切换的过渡类名与 main-content 外边距 -->
  <div>
    <DocTable mode="recycle" />
  </div>
</template>
