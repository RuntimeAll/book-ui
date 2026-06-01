<script setup lang="ts">
/**
 * 我的卷库页 — scope='mine'（后端按当前登录用户 userId 过滤）
 * 独立路由 /papers/mine，导航菜单「我的卷库」指向此页。
 *
 * 复用 PaperLibrary 共享组件，传 scope="mine"。
 * 无需在页面层处理 userInfo 兜底，PaperLibrary 组件内 fetchPapers 已处理。
 */
import PaperLibrary from '@/components/business/PaperLibrary/index.vue'
</script>

<template>
  <PaperLibrary scope="mine" />
</template>
