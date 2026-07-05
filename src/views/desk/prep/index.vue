<script setup lang="ts">
/**
 * PRD-C-213 备课包（脚手架占位页；选课次 → 段构建器 → 渲染出卷由后续页面 agent 接手）。
 * 支持 ?lessonId= 直开构建器（批0 §六-1）。
 * import 一次 api 模块确保类型编译路径通，后续替换为真实调用。
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import * as scheduleApi from '@/api/teacher/schedule'

const route = useRoute()
/** 直开构建器的课次 id（?lessonId=） */
const lessonId = computed(() => (route.query.lessonId as string | undefined) ?? '')
const apiReady = typeof scheduleApi.createPrepPack === 'function'
</script>

<template>
  <div class="c213-ph">
    <h2 class="c213-ph-title">备课包</h2>
    <p class="c213-ph-hint">
      开发中<span v-show="!apiReady">（api 未就绪）</span>
      <span v-if="lessonId"> · lessonId={{ lessonId }}</span>
    </p>
  </div>
</template>

<style scoped>
.c213-ph { min-height: 320px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; background: #fff; border: 1px solid var(--bk-line); border-radius: 12px; }
.c213-ph-title { font-size: 18px; font-weight: 700; color: var(--bk-ink); margin: 0; }
.c213-ph-hint { font-size: 13px; color: #86909c; margin: 0; }
</style>
