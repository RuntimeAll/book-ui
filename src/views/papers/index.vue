<script setup lang="ts">
/**
 * 公共试卷页 — scope='public'（取 is_share=1 的共享卷）
 * 导航菜单「卷库」指向此页（/papers/index）
 *
 * 复用 PaperLibrary 共享组件，传 scope="public"。
 * 原 el-tabs（公共/我的）及 handleTabChange / query.my=1 逻辑已移除：
 *   - "我的卷库"已独立为 /papers/mine 页
 *   - workspace 跳转入口改为直接 router.push('/papers/mine')
 */
import PaperLibrary from '@/components/business/PaperLibrary/index.vue'
</script>

<template>
  <PaperLibrary scope="public" />
</template>
