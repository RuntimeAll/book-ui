<script setup lang="ts">
/**
 * 备课台·我的卷库分区（PRD-C-212 增量「我的卷库转移进备课台」）。
 * 轻壳：scope 固定 mode="mine-only"，真列表/筛选逻辑在共享组件 PaperLibrary 内。
 * 卷库顶导航页（views/papers/index.vue）从此只留「公共试卷」，不再有类型切换段。
 */
import PaperLibrary from '@/components/business/PaperLibrary/index.vue'
</script>

<template>
  <PaperLibrary mode="mine-only" />
</template>
