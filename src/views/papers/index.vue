<script setup lang="ts">
/**
 * 卷库主页 — 「我的卷库」是左侧目录树底部合成节点，scope 由 PaperLibrary 内部驱动。
 * ?mine=1 query 由 PaperLibrary 在 onMounted 后识别并自动选中「我的卷库」节点。
 */
import PaperLibrary from '@/components/business/PaperLibrary/index.vue'
</script>

<template>
  <PaperLibrary />
</template>
