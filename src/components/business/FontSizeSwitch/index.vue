<script setup lang="ts">
// ---------------------------------------------------------------------------
// 题目展示字号切换（小 / 中 / 大）。轻量分段按钮，状态走 useFontScale 单例 + localStorage，
// 变式编辑器与个人题库共用 —— 任一处切换，两边题面同步缩放，老师偏好跨页/刷新记住。
// ---------------------------------------------------------------------------
import { useFontScale, FONT_SCALE_OPTIONS } from '@/composables/useFontScale'

const { scale, setScale } = useFontScale()
</script>

<template>
  <div class="font-size-switch" role="group" aria-label="字号">
    <span class="fs-label">字号</span>
    <button
      v-for="opt in FONT_SCALE_OPTIONS"
      :key="opt.key"
      type="button"
      class="fs-btn"
      :class="{ 'is-active': scale === opt.key }"
      :title="`字号：${opt.label}`"
      @click="setScale(opt.key)"
    >
      {{ opt.label }}
    </button>
  </div>
</template>

<style scoped>
.font-size-switch {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.fs-label {
  font-size: 12px;
  color: #86909c;
  margin-right: 4px;
}
.fs-btn {
  min-width: 26px;
  height: 24px;
  padding: 0 6px;
  font-size: 12px;
  line-height: 1;
  color: #5b6770;
  background: #fff;
  border: 1px solid #e3e9e9;
  cursor: pointer;
  transition: all 0.15s;
}
.fs-btn:first-of-type {
  border-radius: 6px 0 0 6px;
}
.fs-btn:last-of-type {
  border-radius: 0 6px 6px 0;
}
.fs-btn:not(:first-of-type) {
  border-left: none;
}
.fs-btn:hover {
  color: #1e8a8a;
}
/* 字号档分别用对应字号渲染按钮文字，所见即所得 */
.fs-btn:nth-of-type(1) {
  font-size: 12px;
}
.fs-btn:nth-of-type(2) {
  font-size: 14px;
}
.fs-btn:nth-of-type(3) {
  font-size: 16px;
}
.fs-btn.is-active {
  color: #fff;
  background: #1e8a8a; /* teal-600：老师拍板色 */
  border-color: #1e8a8a;
}
</style>
