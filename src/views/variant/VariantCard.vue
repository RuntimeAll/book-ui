<script setup lang="ts">
// ---------------------------------------------------------------------------
// PRD-C-011 Bucket3 — 变式题组单卡（DESIGN.md §14.4）。
//
// 数据源 = artifact 快照帧（props.item），FE 不 parse markdown 拼卡片（铁律 2）。
// 卡片快捷键 = utterance：换数字 / 换场景 / 答疑全部 emit('utterance', 预设句)，
// 由宿主走【现有 chat SSE 通道】发给 agent（铁律 1，零新增结构化编辑端点）。
//
// 验证徽章语义（PRD-C-012 4d「只说好、不说坏，除非双闸都不高」，2026-06-11 用户拍板）：
// 唯一依据 = item.tier（BE _apply_visibility 矩阵产出）：
//   verified → ✓ 程序验算通过（green）；self_ok → ✓ 已独立复算一致（green）；
//   proof → ℹ 转人工复核（violet，中性）；silent → 无徽章；both_low → ⚠ 需重点核对（amber）。
// 旧线程恢复无 tier → 按「只说好」兜底：仅 sympy_pass/proof 外显，其余沉默。
// gene 徽章只保留正面（pass → 平行度 ✓）；warn 沉默（双闸低已由 ⚠ 承担）。
// persisted=true → 已收录（入库后 BE 重发快照帧驱动）。
// ---------------------------------------------------------------------------
import { computed, ref } from 'vue'
import type { VariantArtifactItem } from '@/api/variant'
import MarkdownMath from '@/components/MarkdownMath.vue'

const props = defineProps<{
  item: VariantArtifactItem
  /** 发送中禁用所有快捷键 */
  sending: boolean
  /**
   * PRD-C-013 P2b：本组仍在增量上屏（artifact.partial===true）。仅在此期间，
   * item.tier 为 null 才解读为「验算中」过渡态；恢复/定稿帧无此标记 → 走只说好兜底。
   */
  checking?: boolean
}>()

const emit = defineEmits<{ (e: 'utterance', text: string): void }>()

const showSolution = ref(false)

// PRD-C-013 P2b 逐题上屏：增量帧首发该题时无 tier（闸链 A+B 未跑完）→ 显示「验算中…」
// 过渡徽章（呼吸态，不出 ✓/⚠）；闸链完成后 BE 原位重发同 seq 带 tier，徽章原位更新、不闪烁。
// 🔴 与一期「旧线程恢复无 tier 按只说好兜底」的区分：恢复帧（partial 不为 true）里无 tier =
// 历史定稿、走兜底沉默；只有增量帧（partial===true）里无 tier 才是「验算中」过渡态。
const isChecking = computed(() => {
  if (props.item.tier === 'checking') return true // 向前兼容：BE 显式标过渡
  return props.item.tier === null && props.checking === true
})

const verifyBadge = computed(() => {
  if (isChecking.value) return null // 过渡态由独立呼吸徽章承担，不走此 computed
  const t = props.item.tier
  if (t === 'verified') return { cls: 'vb-green', text: '✓ 程序验算通过' }
  if (t === 'self_ok') return { cls: 'vb-green', text: '✓ 已独立复算一致' }
  if (t === 'proof') return { cls: 'vb-violet', text: 'ℹ 转人工复核' }
  if (t === 'both_low') return { cls: 'vb-amber', text: '⚠ 需重点核对' }
  if (t === 'silent') return null
  // 旧数据无 tier（且非增量过渡）：按「只说好」兜底——只外显正面/中性，其余沉默
  const v = props.item.verify
  if (v === 'sympy_pass') return { cls: 'vb-green', text: '✓ 程序验算通过' }
  if (v === 'proof_needs_human') return { cls: 'vb-violet', text: 'ℹ 转人工复核' }
  return null
})

const geneBadge = computed(() => {
  // 4d：只说好——warn 等负面值一律沉默（双闸低由 verifyBadge 的 ⚠ 承担）
  return props.item.gene === 'pass' ? { cls: 'gb-teal', text: '平行度 ✓' } : null
})

// PRD-C-013 P8：难度按数值渲染星级。上限动态（存量库题可能 5，新生成题 1-4）——
// 满格 = max(difficulty, 5)，实心 = difficulty，空星补足；title 仍给「难度 N」文本可读。
const difficultyStars = computed(() => {
  const d = props.item.difficulty
  if (!(d > 0)) return null
  const filled = Math.round(d)
  const total = Math.max(filled, 5)
  return {
    full: filled,
    empty: total - filled,
    title: `难度 ${d}`,
  }
})

const levelText = computed(() => {
  const lv = props.item.level
  if (lv === 'hard') return '提高'
  if (lv === 'normal') return '常规'
  return lv
})

function knob(text: string) {
  if (props.sending) return
  emit('utterance', text)
}
</script>

<template>
  <article class="variant-card" :class="{ 'is-persisted': item.persisted }">
    <!-- 卡头：题号圆 + 题型/难度/层级徽章 + 验证角标（右上） -->
    <header class="card-head">
      <span class="seq">{{ item.index }}</span>
      <span v-if="item.qtype" class="meta-tag">{{ item.qtype }}</span>
      <span v-if="difficultyStars" class="diff-stars" :title="difficultyStars.title">
        <span v-for="n in difficultyStars.full" :key="`f${n}`" class="star is-full">★</span>
        <span v-for="n in difficultyStars.empty" :key="`e${n}`" class="star is-empty">☆</span>
      </span>
      <span class="meta-tag" :class="item.level === 'hard' ? 'is-hard' : ''">{{ levelText }}</span>
      <span class="head-spacer" />
      <span v-if="item.persisted" class="persisted-tag">已收录</span>
      <span v-if="geneBadge" class="gene-badge" :class="geneBadge.cls">{{ geneBadge.text }}</span>
      <!-- P2b 过渡态：闸链未完成（增量帧无 tier）→ 呼吸「验算中…」，不出 ✓/⚠ -->
      <span v-if="isChecking" class="verify-badge vb-checking">
        <span class="check-dot" />验算中…
      </span>
      <span v-else-if="verifyBadge" class="verify-badge" :class="verifyBadge.cls">
        {{ verifyBadge.text }}
      </span>
    </header>

    <!-- 题干（KaTeX 富文本） -->
    <div class="card-stem">
      <MarkdownMath :content="item.stem" />
    </div>

    <!-- 解析折叠（默认收起，内含答案 + 解析） -->
    <div class="solution-block">
      <button type="button" class="solution-toggle" @click="showSolution = !showSolution">
        解析 {{ showSolution ? '▴' : '▾' }}
      </button>
      <div v-if="showSolution" class="solution-body">
        <p v-if="item.answer" class="solution-label">答案</p>
        <MarkdownMath v-if="item.answer" :content="item.answer" />
        <p v-if="item.solution" class="solution-label">解析</p>
        <MarkdownMath v-if="item.solution" :content="item.solution" />
        <p v-if="!item.answer && !item.solution" class="solution-empty">本题暂无解析内容</p>
      </div>
    </div>

    <!-- 旋钮行：卡片快捷键 = utterance（点击即把预设句发回左栏 chat 通道） -->
    <footer class="knob-row">
      <button
        type="button"
        class="knob-btn"
        :disabled="sending"
        @click="knob(`第${item.index}题换个数字重出`)"
      >
        换数字
      </button>
      <button
        type="button"
        class="knob-btn"
        :disabled="sending"
        @click="knob(`第${item.index}题换个场景重出`)"
      >
        换场景
      </button>
      <button
        type="button"
        class="knob-btn"
        :disabled="sending"
        @click="knob(`第${item.index}题为什么这么解？`)"
      >
        答疑
      </button>
    </footer>
  </article>
</template>

<style scoped>
/* DESIGN token：card #FFF / border #E3E9E9 / ink-900 #1D2A2E / teal-600 #1E8A8A
   green-600 #0E9F6E / amber-500 #E0A23C / violet-600 #7B6CF0 / violet-50 #F2F0FE */
.variant-card {
  background: #fff;
  border: 1px solid #e3e9e9;
  border-radius: 14px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.variant-card.is-persisted {
  background: #f2f0fe; /* violet-50：已收录态弱高亮 */
  border-color: #7b6cf0;
}

.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.seq {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #1e8a8a; /* teal-600 */
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.meta-tag {
  font-size: 12px;
  color: #33464c; /* ink-700 */
  background: #edf2f2; /* bg-100 */
  border-radius: 6px;
  padding: 1px 8px;
}
.meta-tag.is-hard {
  color: #b8741a;
  background: #fbf1e0;
}
.head-spacer {
  flex: 1;
}

/* P8 难度星：实心 amber、空心淡灰，紧凑无间隙 */
.diff-stars {
  display: inline-flex;
  align-items: center;
  line-height: 1;
  font-size: 13px;
  letter-spacing: -1px;
  cursor: default;
}
.star.is-full {
  color: #e0a23c; /* amber-500 */
}
.star.is-empty {
  color: #d4dede;
}

/* 验证角标：⚠ 比 ✓ 醒目（实底白字 + ⚠ 加粗） */
.verify-badge {
  font-size: 12px;
  color: #fff;
  border-radius: 6px;
  padding: 2px 8px;
}
.vb-green {
  background: #0e9f6e; /* green-600 */
}
.vb-amber {
  background: #e0a23c; /* amber-500 */
  font-weight: 700;
}
.vb-red {
  background: #d9444b;
  font-weight: 700;
}
.vb-violet {
  background: #7b6cf0; /* violet-600 */
}
/* P2b 验算中过渡态：中性灰底 + 呼吸点，不抢 ✓/⚠ 的视觉权重 */
.vb-checking {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #5b6770;
  background: #edf2f2; /* bg-100 */
  animation: vb-breathe 1.4s infinite ease-in-out;
}
.check-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #7b6cf0; /* violet-600：AI 在场 */
}
@keyframes vb-breathe {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}

.gene-badge {
  font-size: 12px;
  border-radius: 6px;
  padding: 1px 8px;
}
.gb-teal {
  color: #176e6e; /* teal-700 */
  background: #e6f2f2; /* teal-50 */
}
.gb-amber {
  color: #b8741a;
  background: #fbf1e0;
  font-weight: 600;
}

.persisted-tag {
  font-size: 12px;
  color: #5b4fd6; /* violet-700 */
  background: #fff;
  border: 1px solid #7b6cf0;
  border-radius: 6px;
  padding: 1px 8px;
  font-weight: 600;
}

.card-stem {
  font-size: 14px;
  color: #1d2a2e; /* ink-900 */
}

.solution-block {
  border-top: 1px dashed #e3e9e9;
  padding-top: 6px;
}
.solution-toggle {
  border: none;
  background: none;
  padding: 2px 0;
  font-size: 13px;
  color: #1e8a8a; /* teal-600 */
  cursor: pointer;
}
.solution-toggle:hover {
  color: #176e6e;
}
.solution-body {
  margin-top: 6px;
  background: #f5f8f8; /* bg-50 内嵌 */
  border-radius: 8px;
  padding: 10px 12px;
}
.solution-label {
  margin: 4px 0 2px;
  font-size: 12px;
  font-weight: 700;
  color: #33464c;
}
.solution-empty {
  margin: 0;
  font-size: 12px;
  color: #86909c;
}

.knob-row {
  display: flex;
  gap: 8px;
}
.knob-btn {
  font-size: 13px;
  color: #33464c;
  background: none;
  border: 1px solid #e3e9e9;
  border-radius: 8px;
  padding: 3px 12px;
  cursor: pointer;
}
.knob-btn:hover:not(:disabled) {
  color: #1e8a8a;
  border-color: #1e8a8a;
}
.knob-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
