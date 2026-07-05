<script setup lang="ts">
/**
 * PRD-C-213 排课总览（脚手架占位页；月历 + 冲突 + 顺延业务由后续页面 agent 接手）。
 * import 一次 api 模块确保类型编译路径通，后续替换为真实调用。
 */
import * as scheduleApi from '@/api/teacher/schedule'

const apiReady = typeof scheduleApi.getCalendar === 'function'
</script>

<template>
  <div class="c213-ph">
    <h2 class="c213-ph-title">排课总览</h2>
    <p class="c213-ph-hint">开发中<span v-show="!apiReady">（api 未就绪）</span></p>
  </div>
</template>

<style scoped>
.c213-ph { min-height: 320px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; background: #fff; border: 1px solid var(--bk-line); border-radius: 12px; }
.c213-ph-title { font-size: 18px; font-weight: 700; color: var(--bk-ink); margin: 0; }
.c213-ph-hint { font-size: 13px; color: #86909c; margin: 0; }
</style>
