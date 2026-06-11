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
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { VariantArtifactItem } from '@/api/variant'
import MarkdownMath from '@/components/MarkdownMath.vue'
import { normalizeStem } from './normalize'

const props = defineProps<{
  item: VariantArtifactItem
  /** 发送中禁用所有快捷键 */
  sending: boolean
  /**
   * PRD-C-013 P2b：本组仍在增量上屏（artifact.partial===true）。仅在此期间，
   * item.tier 为 null 才解读为「验算中」过渡态；恢复/定稿帧无此标记 → 走只说好兜底。
   */
  checking?: boolean
  /** 本卡正在重新验算（单题 LLM+sympy，几秒）→ 验算按钮 loading + 卡片轻禁用 */
  reverifying?: boolean
}>()

const emit = defineEmits<{
  (e: 'utterance', text: string): void
  /** 保存内容编辑（只传改过的字段，宿主调 editVariantItem） */
  (e: 'edit', payload: { index: number; stem?: string; answer?: string; solution?: string }): void
  /** 重新验算（宿主调 reverifyVariantItem） */
  (e: 'reverify', index: number): void
}>()

const showSolution = ref(false)

// ---------------------------------------------------------------------------
// 内容编辑（傻瓜式）：编辑态把 stem/answer/solution 各显示为 textarea + 实时 MarkdownMath
// 预览（KaTeX 立等可见）；保存只把「改过的字段」传给宿主（走 edit-item，BE 净化 + 标
// manual_edited + 置 tier='manual'）；取消还原。「规范排版」= 纯 FE 文本 normalize（解析
// 不出原样返回，降级不报错）。tier='manual' 的卡显示「重新验算」按钮。
// ---------------------------------------------------------------------------
const editing = ref(false)
const draft = reactive({ stem: '', answer: '', solution: '' })

// 题组刷新（保存/重排/验算后宿主整量替换 item）→ 若仍在编辑态且不是本卡触发，退出编辑避免脏改
watch(
  () => props.item.seq,
  () => {
    if (editing.value) editing.value = false
  }
)

function startEdit() {
  if (props.sending || props.reverifying) return
  draft.stem = props.item.stem || ''
  draft.answer = props.item.answer || ''
  draft.solution = props.item.solution || ''
  showSolution.value = true // 展开解析，编辑答案/解析时可见
  editing.value = true
}

function cancelEdit() {
  editing.value = false
}

function saveEdit() {
  // 只传改过的字段（其余 BE 不动）
  const payload: { index: number; stem?: string; answer?: string; solution?: string } = {
    index: props.item.index,
  }
  let changed = false
  if (draft.stem !== (props.item.stem || '')) {
    payload.stem = draft.stem
    changed = true
  }
  if (draft.answer !== (props.item.answer || '')) {
    payload.answer = draft.answer
    changed = true
  }
  if (draft.solution !== (props.item.solution || '')) {
    payload.solution = draft.solution
    changed = true
  }
  if (!changed) {
    editing.value = false
    return
  }
  emit('edit', payload)
  editing.value = false
}

/** 规范排版：纯 FE 行级 normalize 题干（选项独立成行 / 填空下划线 / 判断题补括号），失败原样 */
function normalize() {
  try {
    const before = draft.stem
    const after = normalizeStem(before, props.item.qtype)
    if (after === before) {
      ElMessage.info('题干已是规范格式，无需调整')
    } else {
      draft.stem = after
      ElMessage.success('已规范排版，可继续编辑后保存')
    }
  } catch {
    // 降级：解析不出不报错，保持原样
  }
}

const isManual = computed(() => props.item.tier === 'manual')

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
  // 题组编辑器：手动编辑后 BE 置 tier='manual'（验算待重跑）→ 中性徽章，不出 ✓/⚠ 误导
  if (t === 'manual') return { cls: 'vb-manual', text: '✎ 手动编辑（验算待重跑）' }
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
  <article
    class="variant-card"
    :class="{ 'is-persisted': item.persisted, 'is-editing': editing, 'is-reverifying': reverifying }"
  >
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
      <!-- 重新验算中：徽章位展示 loading 态 -->
      <span v-if="reverifying" class="verify-badge vb-checking">
        <span class="check-dot" />重新验算中…
      </span>
      <!-- P2b 过渡态：闸链未完成（增量帧无 tier）→ 呼吸「验算中…」，不出 ✓/⚠ -->
      <span v-else-if="isChecking" class="verify-badge vb-checking">
        <span class="check-dot" />验算中…
      </span>
      <span v-else-if="verifyBadge" class="verify-badge" :class="verifyBadge.cls">
        {{ verifyBadge.text }}
      </span>
    </header>

    <!-- ============ 编辑态：三段 textarea + 右侧/下方 MarkdownMath 实时预览 ============ -->
    <template v-if="editing">
      <div class="edit-field">
        <div class="edit-label-row">
          <span class="edit-label">题干</span>
          <button type="button" class="norm-btn" @click="normalize">规范排版</button>
        </div>
        <div class="edit-pair">
          <el-input
            v-model="draft.stem"
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 12 }"
            resize="none"
            placeholder="题干（支持 markdown + LaTeX，如 \\( x^2 \\)）"
          />
          <div class="edit-preview">
            <span class="preview-tag">预览</span>
            <MarkdownMath :content="draft.stem" />
          </div>
        </div>
      </div>

      <div class="edit-field">
        <span class="edit-label">答案</span>
        <div class="edit-pair">
          <el-input
            v-model="draft.answer"
            type="textarea"
            :autosize="{ minRows: 1, maxRows: 6 }"
            resize="none"
            placeholder="答案"
          />
          <div class="edit-preview">
            <span class="preview-tag">预览</span>
            <MarkdownMath :content="draft.answer" />
          </div>
        </div>
      </div>

      <div class="edit-field">
        <span class="edit-label">解析</span>
        <div class="edit-pair">
          <el-input
            v-model="draft.solution"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 12 }"
            resize="none"
            placeholder="解析"
          />
          <div class="edit-preview">
            <span class="preview-tag">预览</span>
            <MarkdownMath :content="draft.solution" />
          </div>
        </div>
      </div>

      <footer class="edit-actions">
        <button type="button" class="edit-cancel" @click="cancelEdit">取消</button>
        <button type="button" class="edit-save" @click="saveEdit">保存</button>
      </footer>
    </template>

    <!-- ============ 展示态 ============ -->
    <template v-else>
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

      <!-- 旋钮行：编辑 + （手动编辑后）重新验算 + 卡片快捷键 utterance -->
      <footer class="knob-row">
        <button
          type="button"
          class="knob-btn is-edit"
          :disabled="sending || reverifying"
          @click="startEdit"
        >
          编辑
        </button>
        <button
          v-if="isManual"
          type="button"
          class="knob-btn is-reverify"
          :disabled="sending || reverifying"
          @click="emit('reverify', item.index)"
        >
          {{ reverifying ? '验算中…' : '重新验算' }}
        </button>
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
    </template>
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
  container-type: inline-size; /* 编辑态双栏的 @container 查询锚点 */
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
/* 手动编辑（验算待重跑）：中性灰底深字，不抢 ✓/⚠ 权重，暗示需重新验算 */
.vb-manual {
  background: #eef1f3;
  color: #5b6770;
  border: 1px solid #d4dede;
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
/* 「编辑」突出：teal 描边（老师拍板色系） */
.knob-btn.is-edit {
  color: #176e6e;
  border-color: #b9d8d8;
}
.knob-btn.is-edit:hover:not(:disabled) {
  background: #e6f2f2;
}
/* 「重新验算」：violet 描边（AI 在场） */
.knob-btn.is-reverify {
  color: #5b4fd6;
  border-color: #c8c0f7;
}
.knob-btn.is-reverify:hover:not(:disabled) {
  background: #f2f0fe;
  border-color: #7b6cf0;
}

/* ============ 编辑态：textarea + 实时预览双栏 ============ */
.variant-card.is-editing {
  border-color: #7b6cf0; /* violet-600：编辑中 = AI 在场 */
  box-shadow: 0 0 0 2px rgba(123, 108, 240, 0.12);
}
.variant-card.is-reverifying {
  opacity: 0.85;
}
.edit-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.edit-label-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.edit-label {
  font-size: 12px;
  font-weight: 700;
  color: #33464c;
}
.norm-btn {
  font-size: 12px;
  color: #176e6e;
  background: #e6f2f2;
  border: 1px solid #b9d8d8;
  border-radius: 6px;
  padding: 1px 10px;
  cursor: pointer;
}
.norm-btn:hover {
  background: #d3eaea;
}
/* 双栏：左 textarea / 右预览；窄屏（卡片 <520px）上下堆叠 */
.edit-pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  align-items: start;
}
@container (max-width: 520px) {
  .edit-pair {
    grid-template-columns: 1fr;
  }
}
.edit-pair :deep(.el-textarea__inner) {
  font-size: 13px;
  line-height: 1.6;
  font-family:
    ui-monospace, 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace;
}
.edit-preview {
  position: relative;
  background: #f5f8f8; /* bg-50 */
  border: 1px solid #e3e9e9;
  border-radius: 8px;
  padding: 18px 12px 10px;
  font-size: 14px;
  color: #1d2a2e;
  min-height: 40px;
  overflow-x: auto;
}
.preview-tag {
  position: absolute;
  top: 2px;
  left: 8px;
  font-size: 10px;
  color: #a0a8b3;
}
.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  border-top: 1px dashed #e3e9e9;
  padding-top: 8px;
}
.edit-cancel,
.edit-save {
  font-size: 13px;
  border-radius: 8px;
  padding: 4px 16px;
  cursor: pointer;
}
.edit-cancel {
  color: #5b6770;
  background: #fff;
  border: 1px solid #e3e9e9;
}
.edit-cancel:hover {
  background: #f5f8f8;
}
.edit-save {
  color: #fff;
  background: #1e8a8a; /* teal-600：老师拍板 */
  border: 1px solid #1e8a8a;
}
.edit-save:hover {
  background: #176e6e;
  border-color: #176e6e;
}
</style>
