<script setup lang="ts">
/**
 * QuickComposePanel — 三栏组卷工作台「快速组卷」面板 (PRD-001 T5 + 验收期返工)
 *
 * 验收反馈返工（2026-05-30）：
 *   - 底部动作不是"生成试卷"，而是把所选题「加入试题篮」(蓝色 useQuestionBasket)。
 *     真正的组卷由试题篮自身的"组卷"流程承接，本面板只负责快速多选 → 入篮。
 *   - 题号按「题型」分类展示（选择题 / 填空题 / 简答题…），组内连续全局编号。
 *
 * 设计：题号格按题型分组，全局连续编号(seq)。点格 toggle 选中(按 question id)。
 *   已在试题篮内的题置灰禁选 + 打 ✓，避免重复加。底部"加入试题篮 (N题)" = 待加入数。
 */
import { computed, ref } from 'vue'
import type { PaperSourceQuestion } from '@/api/question/index'
import { useQuestionBasket } from '@/composables/useQuestionBasket'

const props = defineProps<{
  questions: PaperSourceQuestion[]
}>()

const basket = useQuestionBasket()

// ── 题型 label / 圆点颜色（沿用项目既有映射 {1选择 4填空 5简答}）──
const TYPE_LABEL: Record<number, string> = { 1: '选择题', 4: '填空题', 5: '简答题' }
const TYPE_DOT: Record<number, string> = { 1: '#1E8A8A', 4: '#2bb673', 5: '#f5a623' }
function typeLabel(t: number): string {
  return TYPE_LABEL[t] ?? `题型${t}`
}
function typeDot(t: number): string {
  return TYPE_DOT[t] ?? '#909399'
}

interface SeqQuestion {
  q: PaperSourceQuestion
  seq: number // 全局连续编号
}
interface TypeGroup {
  type: number
  label: string
  dot: string
  items: SeqQuestion[]
}

// ── 按题型分组 + 全局连续编号 ────────────────────────────────
const groups = computed<TypeGroup[]>(() => {
  // 先按题型聚合（题型升序：选择题1 → 填空题4 → 简答题5 → 其他）
  const byType = new Map<number, PaperSourceQuestion[]>()
  for (const q of props.questions) {
    const t = q.questionType ?? -1
    if (!byType.has(t)) byType.set(t, [])
    byType.get(t)!.push(q)
  }
  const types = [...byType.keys()].sort((a, b) => a - b)
  // 全局连续编号：按分组展示顺序依次累加
  let seq = 0
  return types.map((type) => ({
    type,
    label: typeLabel(type),
    dot: typeDot(type),
    items: byType.get(type)!.map((q) => ({ q, seq: ++seq })),
  }))
})

const isEmpty = computed<boolean>(() => props.questions.length === 0)

// ── 选中态（按 question id；已在篮内的不可选）──────────────────
const selectedIds = ref<Set<number>>(new Set())

function inBasket(id: number): boolean {
  return basket.basketIds.value.has(id)
}
function isSelected(id: number): boolean {
  return selectedIds.value.has(id)
}
function toggle(id: number): void {
  if (inBasket(id)) return // 已在篮内不可选
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

// 待加入的题（选中 ∩ 当前题列表 ∩ 未在篮）
const selectedQuestions = computed<PaperSourceQuestion[]>(() =>
  props.questions.filter((q) => selectedIds.value.has(q.id) && !inBasket(q.id)),
)

// "已选：2、3 题" —— 展示选中题的全局编号（升序）
const selectedSeqLabel = computed<string>(() => {
  const seqMap = new Map<number, number>()
  for (const g of groups.value) for (const it of g.items) seqMap.set(it.q.id, it.seq)
  const seqs = [...selectedIds.value]
    .map((id) => seqMap.get(id))
    .filter((s): s is number => s != null)
    .sort((a, b) => a - b)
  return seqs.length > 0 ? seqs.join('、') : ''
})

function clearSelection(): void {
  selectedIds.value = new Set()
}

async function handleAddToBasket(): Promise<void> {
  const toAdd = selectedQuestions.value
  if (toAdd.length === 0) return
  await basket.addMany(toAdd)
  clearSelection() // 入篮后清空选择（已入篮的格子会自动变 ✓ 禁选）
}
</script>

<template>
  <div class="quick-compose-panel">
    <el-empty v-if="isEmpty" description="先在左/中栏准备题目" :image-size="100" />

    <template v-else>
      <!-- ── 按题型分组的题号网格 ── -->
      <div class="qc-scroll">
        <div v-for="g in groups" :key="g.type" class="qc-group">
          <div class="qc-group-title">
            <span class="qc-dot" :style="{ background: g.dot }" />
            <span class="qc-group-label">{{ g.label }}</span>
            <span class="qc-group-count">{{ g.items.length }}</span>
          </div>
          <div class="qc-grid">
            <button
              v-for="it in g.items"
              :key="it.q.id"
              type="button"
              class="qc-cell"
              :class="{
                'qc-cell--active': isSelected(it.q.id),
                'qc-cell--in-basket': inBasket(it.q.id),
              }"
              :disabled="inBasket(it.q.id)"
              :title="inBasket(it.q.id) ? '已在试题篮中' : ''"
              @click="toggle(it.q.id)"
            >
              {{ it.seq }}
              <span v-if="inBasket(it.q.id)" class="qc-cell-check">✓</span>
            </button>
          </div>
        </div>
      </div>

      <!-- ── 底部：已选 + 加入试题篮 + 清除 ── -->
      <div class="qc-footer">
        <div class="qc-selected-line">
          已选：<template v-if="selectedSeqLabel">{{ selectedSeqLabel }} 题</template>
          <span v-else class="qc-selected-none">未选择题目</span>
        </div>
        <el-button
          class="add-to-basket-btn"
          type="success"
          :disabled="selectedQuestions.length === 0"
          @click="handleAddToBasket"
        >
          + 加入试题篮（{{ selectedQuestions.length }}题）
        </el-button>
        <el-button class="clear-btn" plain @click="clearSelection">
          清除选择
        </el-button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.quick-compose-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 16px;
  background: #fff;
  border-radius: 10px;
  box-sizing: border-box;
}

.qc-scroll {
  flex: 1 1 auto;
  overflow-y: auto;
  padding-right: 2px;
}

/* ── 题型分组 ── */
.qc-group {
  margin-bottom: 18px;
}

.qc-group-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.qc-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
}

.qc-group-label {
  font-size: 15px;
  font-weight: 700;
  color: #1d2129;
}

.qc-group-count {
  font-size: 12px;
  color: #86909c;
}

/* ── 题号格 ── */
.qc-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 10px;
}

.qc-cell {
  position: relative;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  color: #4e5969;
  background: #fff;
  border: 1px solid #e5e6eb;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
  user-select: none;
}

.qc-cell:hover:not(:disabled) {
  border-color: #1E8A8A;
  color: #1E8A8A;
}

.qc-cell--active {
  background: #1E8A8A;
  border-color: #1E8A8A;
  color: #fff;
}

.qc-cell--active:hover {
  color: #fff;
}

/* 已在试题篮 — 置灰禁选 + ✓ */
.qc-cell--in-basket {
  background: #f2f3f5;
  border-color: #e5e6eb;
  color: #c0c4cc;
  cursor: not-allowed;
}

.qc-cell-check {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 16px;
  height: 16px;
  font-size: 11px;
  line-height: 16px;
  text-align: center;
  color: #fff;
  background: #2bb673;
  border-radius: 50%;
}

/* ── 底部 ── */
.qc-footer {
  flex-shrink: 0;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #f2f3f5;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.qc-selected-line {
  background: #f7f8fa;
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 14px;
  color: #1d2129;
}

.qc-selected-none {
  color: #86909c;
}

.add-to-basket-btn {
  width: 100%;
  height: 44px;
  font-size: 15px;
  font-weight: 600;
}

.clear-btn {
  width: 100%;
  height: 40px;
}
</style>
