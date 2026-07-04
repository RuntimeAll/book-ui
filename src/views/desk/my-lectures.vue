<script setup lang="ts">
/**
 * 备课台·我的讲义分区（PRD-C-212 增量）
 * 轻壳：复用讲义浏览器（views/lecture-hub/index.vue），mineOnly=true 只看登录者自己创建的讲义版本。
 * 讲义 tab 的现行为（mineOnly 默认 false）零改动，本页仅新增一个消费入口。
 */
import LectureHub from '@/views/lecture-hub/index.vue'
</script>

<template>
  <LectureHub :mine-only="true" />
</template>
