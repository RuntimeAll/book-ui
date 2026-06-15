<script setup lang="ts">
// ---------------------------------------------------------------------------
// AI 思路条（PRD-C-010 思维外放）—— 纯展示组件，props 驱动，无内部状态。
//
// 视觉按 DESIGN.md §6.1：violet-50 底(#F2F0FE) + 左 2px violet-600(#7B6CF0)；
// 每个 stage 一行：◉ 状态点 + 标题 + status，副文 detail 为 mono 12px violet-700。
// 状态语义：running = 紫呼吸(1.6s)；done = 转青(teal，结果回到老师手里)；warn = 橙。
// 🔴 PRD-C-017 B5：await = 中性蓝灰（正常暂停：等老师确认 / 等点开始举一反三），非告警。
//
// stage 列表的「同 key 原地更新 / 新 key 追加」由调用方维护（见 views/variant），
// 本组件只渲染。色值与 uno.config.ts violet/teal token 一致（本组件用 scoped css
// 硬编码同值，与 variant 页现有手写 scoped 风格保持一致）。
// ---------------------------------------------------------------------------
import type { VariantStage } from '@/api/variant'

defineProps<{ stages: VariantStage[] }>()

// 🔴 PRD-C-017 B5：status 角标人话（await = 中性「待确认/待开始」，detail 里有更具体文案时它兜底）
const STATUS_LABEL: Record<VariantStage['status'], string> = {
  running: 'running',
  done: 'done',
  warn: 'warn',
  await: '待确认',
}
function statusLabel(s: VariantStage['status']): string {
  return STATUS_LABEL[s] ?? String(s)
}
</script>

<template>
  <div class="stage-rail">
    <div v-for="s in stages" :key="s.key" class="stage-row" :class="`st-${s.status}`">
      <span class="stage-dot" />
      <span class="stage-title">{{ s.title }}</span>
      <span class="stage-flag">· {{ statusLabel(s.status) }}</span>
      <span v-if="s.detail" class="stage-detail">{{ s.detail }}</span>
    </div>
  </div>
</template>

<style scoped>
.stage-rail {
  background: #f2f0fe; /* violet-50 */
  border-left: 2px solid #7b6cf0; /* violet-600 */
  border-radius: 10px;
  border-bottom-left-radius: 4px;
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.stage-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 13px;
  line-height: 1.6;
  color: #1d2129;
}

.stage-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #7b6cf0; /* violet-600 */
  flex-shrink: 0;
  align-self: center;
}
.st-running .stage-dot {
  animation: stage-pulse 1.6s infinite ease-in-out;
}
.st-done .stage-dot {
  background: #1e8a8a; /* teal-600：done 转青 */
}
.st-warn .stage-dot {
  background: #e6a23c; /* 橙：回炉 / 验算告警 */
}
/* 🔴 PRD-C-017 B5：await 中性态——蓝灰点（无呼吸动画，表「静等老师」非进行中） */
.st-await .stage-dot {
  background: #5a7a9a; /* 中性蓝灰 */
}

.stage-title {
  font-weight: 600;
}
.st-done .stage-title {
  color: #176e6e; /* teal-700 */
}
.st-warn .stage-title {
  color: #b8741a;
}
.st-await .stage-title {
  color: #3f5c78; /* 中性蓝灰，非告警 */
}

/* status 角标 + 副文：mono 12px violet-700，随状态换色 */
.stage-flag,
.stage-detail {
  font-family: ui-monospace, SFMono-Regular, Consolas, 'Courier New', monospace;
  font-size: 12px;
  color: #5b4fd6; /* violet-700 */
}
.st-done .stage-flag,
.st-done .stage-detail {
  color: #1e8a8a;
}
.st-warn .stage-flag,
.st-warn .stage-detail {
  color: #b8741a;
}
.st-await .stage-flag,
.st-await .stage-detail {
  color: #5a7a9a; /* 中性蓝灰 */
}

@keyframes stage-pulse {
  0%,
  100% {
    transform: scale(0.7);
    opacity: 0.45;
  }
  50% {
    transform: scale(1);
    opacity: 1;
  }
}
</style>
