<script setup lang="ts">
/**
 * PrepContextBanner — 备课语境常驻横幅（PRD-B-101 AC2/V2）
 *
 * 挂全局布局层（AppLayout，header 与 main 之间），语境激活时所有页面顶部可见：
 *   「正在备课：{学生}·{日期}·{课次}·{卷位名}」+ 配方摘要 + ［退出备课］
 * 退出 → 语境清、试题栏切回日常仓、留在当前页（store.exit 承载副作用，此处仅调用）。
 *
 * 🔴 横幅是老师侧 UI，不受"家长/学生可见文案"限制（配方摘要可含 层/★/素材 等内部元数据）。
 */
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { usePrepContextStore } from '@/store/prepContext'

const ctx = usePrepContextStore()

// 「正在备课：学生·日期·课次·卷位」——缺项自动跳过（如课次行入口无具体上课日期）
const headline = computed(() =>
  [ctx.studentName, ctx.lessonDate, ctx.lessonTitle, ctx.slotName].filter((x) => x && String(x).trim()).join(' · '),
)

function onExit() {
  ctx.exit()
  ElMessage.success('已退出备课')
}
</script>

<template>
  <transition name="prep-banner-fade">
    <div v-if="ctx.active" class="prep-banner">
      <span class="pb-flag">正在备课</span>
      <span class="pb-headline" :title="headline">{{ headline }}</span>
      <span v-if="ctx.configSummary" class="pb-config" :title="ctx.configSummary">
        配方：{{ ctx.configSummary }}
      </span>
      <span class="pb-spacer"></span>
      <el-button class="pb-exit" size="small" round @click="onExit">退出备课</el-button>
    </div>
  </transition>
</template>

<style scoped>
.prep-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 24px;
  background: linear-gradient(90deg, #0f766e, #14958a);
  color: #fff;
  font-size: 13px;
  box-shadow: 0 2px 6px rgba(15, 118, 110, 0.22);
  position: sticky;
  top: 60px; /* 全局 header 高度 */
  z-index: 999;
}
.pb-flag {
  display: inline-flex;
  align-items: center;
  font-weight: 700;
  background: rgba(255, 255, 255, 0.18);
  border-radius: 6px;
  padding: 2px 10px;
  white-space: nowrap;
  flex-shrink: 0;
}
.pb-flag::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #ffd66b;
  margin-right: 7px;
  box-shadow: 0 0 0 3px rgba(255, 214, 107, 0.3);
  animation: pb-pulse 1.6s ease-in-out infinite;
}
@keyframes pb-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
.pb-headline {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 46%;
  flex-shrink: 0;
}
.pb-config {
  color: rgba(255, 255, 255, 0.85);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.pb-spacer {
  flex: 1;
}
.pb-exit {
  flex-shrink: 0;
  background: rgba(255, 255, 255, 0.95);
  border-color: transparent;
  color: #0f766e;
  font-weight: 600;
}
.pb-exit:hover {
  background: #fff;
  color: #0b5a54;
}

.prep-banner-fade-enter-active,
.prep-banner-fade-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.prep-banner-fade-enter-from,
.prep-banner-fade-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
