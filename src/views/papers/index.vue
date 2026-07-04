<script setup lang="ts">
/**
 * 卷库主页 — PRD-C-212 增量「我的卷库转移进备课台」：顶导航卷库页只留「公共试卷」，
 * 「我的卷库」分区已迁至备课台 /desk/my-papers（见 views/desk/my-papers.vue）。
 * scope 固定 mode="public-only"：类型切换段不渲染，?mine=1 不再生效。
 *
 * PRD-A-013 T5 M-10：列表请求竞态防护（AbortController）实际接入点在
 * components/business/PaperLibrary/index.vue（本页是壳，真列表/筛选逻辑在共享组件内）。
 */
import PaperLibrary from '@/components/business/PaperLibrary/index.vue'
</script>

<template>
  <PaperLibrary mode="public-only" />
</template>
