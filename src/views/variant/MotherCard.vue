<script setup lang="ts">
// ---------------------------------------------------------------------------
// PRD-C-017 B3 ②③④⑥ — 母题紧凑卡（AC4 / AC7 / G7 / G12 / M8）。
//
// 取代 C-015 的全宽大横条 MotherBar：收成【紧凑卡】，位置移到「变式题组」标题/chip 区
// （宿主 ArtifactPanel canvas-head 下方），可折叠（AC7 / G7 收窄移位）。
//
// 内容（②母题卡先出 + 全 10 维）：
//   - 解法骨架（solution_skeleton，【】标最难步 → 高亮可视）
//   - opus 解出的答案（solved_answer）
//   - 全 10 维 DNA：主考点 / 副考点 / 题型 / 考察类型 / 难度 / 场景 / 难点 / 突破点(骨架最难步)
//     / 模型 / 标签 + anchor 章 + need_anchor_review 标记
//   - ④难点空 → 显式「此题无显著难点」（M8，不是空白；送分题难点空是诚实正确）
//   - need_anchor_review=1 → 显式标「锚定待人审」（闸B 留空的诚实提示）
//   - ⑥「入库」按钮（G12）：母题确认入库 → 宿主映射 CreateQuestionBo → POST /teacher/question/create
//
// 🔴 母题卡先于变式出：宿主在 needConfirm 确认后、变式 assemble 前若 toolkit 透传母题专帧，
//    本卡先单独亮（hasVariants=false 也渲染）；当前 toolkit 兜底从 items[0].dna 拼母题维。
// ---------------------------------------------------------------------------
import { computed, ref } from 'vue'
import type { VariantMotherCard } from '@/api/variant'
import MarkdownMath from '@/components/MarkdownMath.vue'

const props = defineProps<{
  motherCard: VariantMotherCard | null
  /** 母题原图（守恒锚缩略图，点开看大图） */
  motherImg?: string
  /** 母题已入库 → 入库按钮置「已入库」 */
  persisted: boolean
  /** 入库进行中 → 按钮 loading */
  persisting: boolean
  /** 发送中：禁交互 */
  sending: boolean
}>()

const emit = defineEmits<{
  /** 母题入库（G12）→ 宿主映射 CreateQuestionBo 调 create */
  (e: 'persist-mother'): void
  /** 点开看大图 */
  (e: 'preview', url: string): void
}>()

// 折叠态（默认展开让老师过目母题基准；过目后可收起腾地方·AC7）
const collapsed = ref(false)

const dna = computed(() => props.motherCard?.dna ?? null)
const hasCard = computed(() => !!props.motherCard)

// 难点（M8）：hard_points 空 → 显式「此题无显著难点」
const hardPoints = computed(() => dna.value?.hardPoints ?? [])

// 解法骨架：把【...】最难步包成高亮 span（骨架文本里【】标记最难步基因）
// 用 MarkdownMath 渲染骨架本体（含 LaTeX），最难步高亮靠 CSS 对 :deep 处理较难 →
// 这里在展示层把【】替换成醒目标记文本，保证「最难步可视」。
const skeletonHtml = computed(() => props.motherCard?.solutionSkeleton ?? '')
const hasHardestMark = computed(() => /【[^】]+】/.test(skeletonHtml.value))
</script>

<template>
  <section v-if="hasCard" class="mother-card" data-testid="variant-mother-card">
    <!-- 卡头：折叠开关 + 标题 + 锚定 chip + 待人审标 + 入库按钮 -->
    <header class="mc-head">
      <button type="button" class="mc-toggle" @click="collapsed = !collapsed">
        {{ collapsed ? '▶' : '▼' }} 母题卡
      </button>
      <span class="mc-anchor-chip" :title="'锚定主考点 · 年级'">
        {{ motherCard?.anchorKp || '未锚定' }}<span class="mc-dot">·</span>{{ motherCard?.anchorGrade || '未定' }}
      </span>
      <!-- ④ need_anchor_review 显式标（闸B 留空的诚实提示） -->
      <span v-if="motherCard?.needAnchorReview" class="mc-review-flag" title="主考点未锚到章内叶子，留待人工核对">
        锚定待人审
      </span>
      <span class="mc-spacer" />
      <!-- ⑥ 入库（G12） -->
      <el-button
        size="small"
        class="mc-persist"
        :type="persisted ? 'success' : 'primary'"
        :loading="persisting"
        :disabled="sending || persisted"
        @click="emit('persist-mother')"
      >
        {{ persisted ? '✓ 已入库' : '母题入库' }}
      </el-button>
    </header>

    <div v-show="!collapsed" class="mc-body">
      <!-- 左：母题图缩略（守恒锚） -->
      <div v-if="motherImg" class="mc-thumb" title="母题原图 · 点开看大图" @click="emit('preview', motherImg)">
        <img :src="motherImg" alt="母题" referrerpolicy="no-referrer" />
      </div>

      <div class="mc-main">
        <!-- 解法骨架（【】标最难步，高亮可视） + opus 解答 -->
        <div class="mc-block">
          <span class="mc-block-k">
            解法骨架
            <span v-if="hasHardestMark" class="mc-hardest-hint">（【】= 最难步）</span>
          </span>
          <div v-if="motherCard?.solutionSkeleton" class="mc-skeleton" :class="{ 'has-mark': hasHardestMark }">
            <MarkdownMath :content="skeletonHtml" />
          </div>
          <span v-else class="mc-muted">（解法骨架未产出）</span>
        </div>
        <div v-if="motherCard?.solvedAnswer" class="mc-block">
          <span class="mc-block-k">解答</span>
          <div class="mc-answer"><MarkdownMath :content="motherCard.solvedAnswer" /></div>
        </div>

        <!-- 全 10 维 DNA -->
        <div class="mc-dna-grid">
          <span class="mc-k">主考点</span>
          <span class="mc-v"><b>{{ dna?.mainKp || motherCard?.anchorKp || '未锚定' }}</b></span>

          <span class="mc-k">副考点</span>
          <span class="mc-v">
            <template v-if="dna?.secondaryKps.length">
              <span v-for="kp in dna.secondaryKps" :key="kp" class="mc-pill sec">{{ kp }}</span>
            </template>
            <span v-else class="mc-muted">未标</span>
          </span>

          <span class="mc-k">题型 / 考察类型</span>
          <span class="mc-v">
            <span class="mc-pill">{{ dna?.examType || '未标' }}</span>
          </span>

          <span class="mc-k">场景</span>
          <span class="mc-v">{{ dna?.scene || '纯代数' }}</span>

          <span class="mc-k">难点</span>
          <span class="mc-v">
            <template v-if="hardPoints.length">
              <span v-for="hp in hardPoints" :key="hp" class="mc-hard">{{ hp }}</span>
            </template>
            <!-- ④ M8：难点空 → 显式文案，不留白（送分题难点空是诚实正确） -->
            <span v-else class="mc-muted">此题无显著难点</span>
          </span>

          <span class="mc-k">解题模型</span>
          <span class="mc-v">
            <template v-if="dna?.models.length">
              <span v-for="m in dna.models" :key="m.id" class="mc-model">{{ m.name || m.id }}</span>
            </template>
            <span v-else class="mc-muted">未标</span>
          </span>

          <span class="mc-k">标签</span>
          <span class="mc-v">
            <template v-if="dna?.tags.length">
              <span v-for="t in dna.tags" :key="t" class="mc-tag">{{ t }}</span>
            </template>
            <span v-else class="mc-muted">未标</span>
          </span>

          <span class="mc-k">锚定章</span>
          <span class="mc-v">
            <span class="mc-anchor-id">
              {{ motherCard?.anchorChapterId || '（确认章 id 未透传）' }}
            </span>
          </span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* v3 设计语言：深青 #0F6E6E + 暖纸白 #FBFAF6 + 暖琥珀 #B8741A。
   AC7 收窄：相比 MotherBar 全宽横条，本卡紧凑（无大缩略图、网格紧排），嵌变式题组标题区下。 */
.mother-card {
  background: #f7faf9;
  border: 1px solid #cfe6e3;
  border-radius: 12px;
  margin: 0 16px 12px;
  overflow: hidden;
}
.mc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  background: #eef6f5;
  border-bottom: 1px solid #dcece9;
}
.mc-toggle {
  font-size: 12.5px;
  font-weight: 700;
  color: #0f6e6e;
  background: #e0f0ee;
  border: 1px solid #c2e0db;
  border-radius: 7px;
  padding: 2px 10px;
  cursor: pointer;
}
.mc-toggle:hover {
  background: #d3eae6;
}
.mc-anchor-chip {
  font-size: 12px;
  color: #0f6e6e;
  background: #fff;
  border: 1px solid #b9d8d8;
  border-radius: 999px;
  padding: 1px 10px;
  font-weight: 600;
}
.mc-dot {
  margin: 0 4px;
  color: #9fb0ad;
}
.mc-review-flag {
  font-size: 11px;
  color: #b8741a;
  background: #fbeed6;
  border: 1px solid #ecc98f;
  border-radius: 6px;
  padding: 1px 8px;
  font-weight: 700;
}
.mc-spacer {
  flex: 1;
}
.mc-persist {
  font-size: 12px;
}

.mc-body {
  display: flex;
  gap: 12px;
  padding: 12px;
}
.mc-thumb {
  flex: 0 0 96px;
  width: 96px;
  height: 72px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid #7fc0bd;
  cursor: zoom-in;
  background: #f5f8f8;
}
.mc-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.mc-main {
  flex: 1;
  min-width: 0;
}

.mc-block {
  margin-bottom: 8px;
}
.mc-block-k {
  display: block;
  font-size: 11.5px;
  font-weight: 700;
  color: #6b817e;
  margin-bottom: 2px;
}
.mc-hardest-hint {
  color: #b8741a;
  font-weight: 600;
}
.mc-skeleton,
.mc-answer {
  font-size: 13px;
  color: #16302f;
  line-height: 1.6;
}
.mc-skeleton :deep(p),
.mc-answer :deep(p) {
  margin: 0;
}
/* 最难步【】高亮：骨架里若有【】标记，整块加暖底提示「含最难步基因」 */
.mc-skeleton.has-mark {
  background: #fdf6ea;
  border-left: 3px solid #e0a44a;
  border-radius: 0 6px 6px 0;
  padding: 6px 10px;
}

.mc-dna-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 12px;
  font-size: 12.5px;
  align-items: baseline;
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px dashed #dcece9;
}
.mc-k {
  color: #6b817e;
  white-space: nowrap;
}
.mc-v {
  color: #16302f;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}
.mc-muted {
  color: #9fb0ad;
}
.mc-pill {
  font-size: 11.5px;
  border-radius: 999px;
  padding: 1px 9px;
  background: #fff;
  color: #0f6e6e;
  border: 1px solid #b9d8d8;
}
.mc-pill.sec {
  border-color: #7fc0bd;
}
.mc-hard {
  font-size: 11.5px;
  background: #fbeed6;
  color: #b8741a;
  border-radius: 5px;
  padding: 1px 8px;
  font-weight: 600;
}
.mc-model {
  font-size: 11.5px;
  background: #f2f0fe;
  color: #5b4fd6;
  border: 1px solid #cfc7f3;
  border-radius: 999px;
  padding: 1px 9px;
}
.mc-tag {
  font-size: 11.5px;
  background: #eef6f5;
  color: #176e6e;
  border-radius: 5px;
  padding: 1px 8px;
}
.mc-anchor-id {
  font-size: 11px;
  color: #9fb0ad;
  font-family: ui-monospace, monospace;
}
</style>
