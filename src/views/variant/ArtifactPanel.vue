<script setup lang="ts">
// ---------------------------------------------------------------------------
// PRD-C-011 Bucket3 — 右栏「变式题组」画布（DESIGN.md §14.4）。
//
// 数据源 = artifact 快照帧（snapshot 全量，宿主整量替换后传入）；本组件纯展示 +
// 把所有动作冒泡成事件，由宿主处理。
//   - 全部入库 → emit('persist')（2026-06-11 用户拍板：确定性动作直连 BE
//     /variant/persist，不再绕 LLM 分类器；宿主直调接口 + 回执进对话）
//   - 换一批   → emit('regenerate')（宿主重发初始出题 utterance，PRD 开放问题方案 b）
//   - 卡片快捷键（换数字/换场景/答疑，需要 LLM 生成）仍走 utterance → chat SSE（铁律 1）
// 旧后端（无 artifact 帧）→ 空态引导，左栏完全可用（向后兼容兜底）。
// ---------------------------------------------------------------------------
import { computed } from 'vue'
import type { VariantArtifact } from '@/api/variant'
import VariantCard from './VariantCard.vue'

const props = defineProps<{
  artifact: VariantArtifact | null
  /** 发送中：禁用画布级按钮 + 无快照时显示骨架卡 */
  sending: boolean
  /** 是否已有初始出题 utterance（决定「换一批」可用性） */
  canRegenerate: boolean
}>()

const emit = defineEmits<{
  (e: 'utterance', text: string): void
  (e: 'regenerate'): void
  (e: 'persist'): void
}>()

const items = computed(() => props.artifact?.items ?? [])
const allPersisted = computed(() => items.value.length > 0 && items.value.every((i) => i.persisted))

function persistAll() {
  if (props.sending || items.value.length === 0 || allPersisted.value) return
  emit('persist')
}

function regenerate() {
  if (props.sending || !props.canRegenerate) return
  emit('regenerate')
}
</script>

<template>
  <section class="artifact-panel" data-testid="variant-artifact-panel">
    <!-- 画布头：标题 + 守恒/配方徽章 + 画布级动作（右上） -->
    <header class="canvas-head">
      <div class="head-line">
        <h2 class="canvas-title">变式题组<template v-if="items.length"> · {{ items.length }} 道</template></h2>
        <span class="head-spacer" />
        <el-button
          size="small"
          :disabled="sending || !canRegenerate"
          @click="regenerate"
        >
          换一批
        </el-button>
        <el-button
          size="small"
          class="persist-btn"
          :disabled="sending || items.length === 0 || allPersisted"
          @click="persistAll"
        >
          {{ allPersisted ? '已全部收录' : '全部入库' }}
        </el-button>
      </div>
      <div v-if="artifact" class="head-badges">
        <span v-if="artifact.header.kp" class="keep-badge">主考点 ✓ {{ artifact.header.kp }}</span>
        <span v-if="artifact.header.grade" class="keep-badge">年级 ✓ {{ artifact.header.grade }}</span>
        <span v-if="artifact.header.recipe" class="recipe-badge">{{ artifact.header.recipe }}</span>
      </div>
    </header>

    <!-- 卡片列 -->
    <div class="canvas-body">
      <template v-if="items.length > 0">
        <VariantCard
          v-for="it in items"
          :key="it.index"
          :item="it"
          :sending="sending"
          @utterance="(t: string) => emit('utterance', t)"
        />
      </template>

      <!-- 生成中骨架卡（尚无快照时） -->
      <template v-else-if="sending">
        <div v-for="n in 3" :key="n" class="skeleton-card" :style="{ animationDelay: `${(n - 1) * 120}ms` }">
          <div class="sk-line sk-w40" />
          <div class="sk-line" />
          <div class="sk-line sk-w70" />
        </div>
      </template>

      <!-- 空态引导（旧后端无 artifact 帧时也落这里，左栏不受影响） -->
      <div v-else class="canvas-empty">
        <div class="empty-emoji">🗂</div>
        <p class="empty-title">题组卡片会出现在这里</p>
        <p class="empty-tip">
          在左侧贴一张母题图开始出题；每道变式以卡片呈现——题干、解析折叠、
          验算徽章、换数字 / 换场景快捷键，最后一键「全部入库」。
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* DESIGN token：bg-50 #F5F8F8 / card #FFF / border #E3E9E9 / ink-900 #1D2A2E
   teal-50 #E6F2F2 / teal-600 #1E8A8A / teal-700 #176E6E / bg-100 #EDF2F2 / ink-700 #33464C */
.artifact-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #f5f8f8; /* bg-50 */
  border-radius: 12px;
  overflow: hidden;
}

.canvas-head {
  flex-shrink: 0;
  padding: 14px 20px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-bottom: 1px solid #e3e9e9;
  background: #f5f8f8;
}
.head-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.canvas-title {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: #1d2a2e; /* ink-900 */
}
.head-spacer {
  flex: 1;
}
/* 老师拍板动作 = teal（不是紫）：右栏不出现紫色实心按钮 */
.persist-btn {
  background: #1e8a8a;
  border-color: #1e8a8a;
  color: #fff;
}
.persist-btn:hover:not(:disabled) {
  background: #176e6e;
  border-color: #176e6e;
  color: #fff;
}
.persist-btn:disabled {
  background: #b9d8d8;
  border-color: #b9d8d8;
  color: #fff;
}

.head-badges {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.keep-badge {
  font-size: 12px;
  color: #176e6e; /* teal-700 */
  background: #e6f2f2; /* teal-50 */
  border-radius: 6px;
  padding: 2px 10px;
  font-weight: 600;
}
.recipe-badge {
  font-size: 12px;
  color: #33464c; /* ink-700 */
  background: #edf2f2; /* bg-100 */
  border-radius: 6px;
  padding: 2px 10px;
}

.canvas-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 32px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* 生成中骨架卡：bg-100 脉动 + 120ms stagger */
.skeleton-card {
  background: #fff;
  border: 1px solid #e3e9e9;
  border-radius: 14px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  animation: sk-pulse 1.4s infinite ease-in-out;
}
.sk-line {
  height: 14px;
  border-radius: 6px;
  background: #edf2f2; /* bg-100 */
}
.sk-w40 {
  width: 40%;
}
.sk-w70 {
  width: 70%;
}
@keyframes sk-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}

.canvas-empty {
  margin: auto;
  text-align: center;
  color: #86909c;
  max-width: 360px;
}
.empty-emoji {
  font-size: 36px;
}
.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: #4e5969;
  margin: 8px 0 4px;
}
.empty-tip {
  font-size: 12px;
  color: #a0a8b3;
  line-height: 1.7;
}
</style>
