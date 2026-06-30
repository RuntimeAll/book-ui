<script setup lang="ts">
import { computed } from 'vue'
import type { PaperSourceQuestion } from '@/api/question/index'
import type { WorkbenchPaper } from '@/composables/useBasketWorkbench'
import { useDictStore, DICT_QUESTION_TYPE } from '@/store/dict'

// 🔴 本组件统计指标 100% 从 props 现算、不拉分析数据（铁律仍生效）。
//    例外：题型名走 useDictStore —— 字典是全 App 缓存的小查表（题库/卷库早已加载），
//    label() 命中缓存即纯查表，不属于「拉分析数据」，故题型名统一回字典 SSOT、不再硬编码。
const props = defineProps<{
  questions: PaperSourceQuestion[]
  papers: WorkbenchPaper[]
}>()

// ---- 题型 ---- 走字典 SSOT（biz_question_type，超管可维护）。题型集合 = 字典全量（增删题型自动跟）。
const dict = useDictStore()
dict.load(DICT_QUESTION_TYPE)
const QUESTION_TYPES = computed<number[]>(() =>
  dict.list(DICT_QUESTION_TYPE).map((d) => Number(d.dictValue)),
)
function typeLabel(t: number): string {
  return dict.label(DICT_QUESTION_TYPE, t) || `题型${t}`
}
const DIFFICULTY_LEVELS: number[] = [1, 2, 3, 4]

// ---- 顶部统计指标 ----
const totalCount = computed<number>(() => props.questions.length)
const paperCount = computed<number>(() => props.papers.length)

const avgDifficulty = computed<string>(() => {
  const vals = props.questions
    .map(q => q.difficult)
    .filter((d): d is number => d !== null && d !== undefined)
  if (vals.length === 0) return '-'
  const sum = vals.reduce((acc, cur) => acc + cur, 0)
  return (sum / vals.length).toFixed(1)
})

const knowledgeCount = computed<number>(() => {
  const ids = new Set<string>()
  for (const q of props.questions) {
    for (const k of q.questionKnowledges ?? []) {
      ids.add(k.knowledgeId)
    }
  }
  return ids.size
})

// ---- 难度分布（1~4 + 未标注）----
interface DistItem {
  label: string
  count: number
}
const difficultyDist = computed<DistItem[]>(() => {
  const buckets: Record<string, number> = { 1: 0, 2: 0, 3: 0, 4: 0, none: 0 }
  for (const q of props.questions) {
    const d = q.difficult
    if (d === 1 || d === 2 || d === 3 || d === 4) buckets[String(d)]++
    else buckets.none++
  }
  return [
    { label: '1 星', count: buckets['1'] },
    { label: '2 星', count: buckets['2'] },
    { label: '3 星', count: buckets['3'] },
    { label: '4 星', count: buckets['4'] },
    { label: '未标注', count: buckets.none },
  ]
})

// ---- 题型分布 ----
const typeDist = computed<DistItem[]>(() => {
  const types = QUESTION_TYPES.value
  const buckets: Record<number, number> = {}
  for (const t of types) buckets[t] = 0
  let other = 0
  for (const q of props.questions) {
    if (q.questionType in buckets) buckets[q.questionType]++
    else other++
  }
  const list: DistItem[] = types.map(t => ({
    label: typeLabel(t),
    count: buckets[t],
  }))
  if (other > 0) list.push({ label: '其他', count: other })
  return list
})

// ---- 题型 × 难度 矩阵 ----
interface MatrixRow {
  type: number
  typeLabel: string
  cells: number[] // 长度 4，对应难度 1~4
  total: number
}
const typeDifficultyMatrix = computed<MatrixRow[]>(() => {
  return QUESTION_TYPES.value.map((t) => {
    const cells = DIFFICULTY_LEVELS.map(
      d => props.questions.filter(q => q.questionType === t && q.difficult === d).length,
    )
    const total = props.questions.filter(q => q.questionType === t).length
    return {
      type: t,
      typeLabel: typeLabel(t),
      cells,
      total,
    }
  })
})

// ---- 各套卷对比 ----
const paperCompare = computed<DistItem[]>(() => {
  return props.papers.map(p => ({
    label: p.paperName,
    count: p.questions.length,
  }))
})

// ---- 高频考点 TOP8 ----
const topKnowledges = computed<DistItem[]>(() => {
  const agg = new Map<string, { name: string; count: number }>()
  for (const q of props.questions) {
    for (const k of q.questionKnowledges ?? []) {
      const existing = agg.get(k.knowledgeId)
      if (existing) existing.count++
      else agg.set(k.knowledgeId, { name: k.knowledgeName, count: 1 })
    }
  }
  return Array.from(agg.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map(item => ({ label: item.name, count: item.count }))
})

// ---- bar 宽度百分比 helper ----
function barPercent(count: number, list: DistItem[]): number {
  const max = Math.max(...list.map(i => i.count), 0)
  if (max <= 0) return 0
  return Math.round((count / max) * 100)
}
</script>

<template>
  <div class="paper-analysis-panel">
    <el-empty v-if="totalCount === 0" description="暂无可分析数据" />

    <template v-else>
      <!-- 顶部 4 个统计卡 -->
      <div class="stat-cards">
        <div class="stat-card analysis-total">
          <div class="stat-num">{{ totalCount }}</div>
          <div class="stat-label">总题数</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">{{ paperCount }}</div>
          <div class="stat-label">试卷数</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">{{ avgDifficulty }}</div>
          <div class="stat-label">平均难度</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">{{ knowledgeCount }}</div>
          <div class="stat-label">考点数</div>
        </div>
      </div>

      <!-- 难度分布 -->
      <div class="analysis-section">
        <div class="section-title">难度分布</div>
        <div class="bar-list">
          <div v-for="item in difficultyDist" :key="item.label" class="bar-row">
            <div class="bar-label">{{ item.label }}</div>
            <div class="bar-track">
              <div
                class="bar-fill bar-fill--difficulty"
                :style="{ width: `${barPercent(item.count, difficultyDist)}%` }"
              />
            </div>
            <div class="bar-value">{{ item.count }}</div>
          </div>
        </div>
      </div>

      <!-- 题型分布 -->
      <div class="analysis-section">
        <div class="section-title">题型分布</div>
        <div class="bar-list">
          <div v-for="item in typeDist" :key="item.label" class="bar-row">
            <div class="bar-label">{{ item.label }}</div>
            <div class="bar-track">
              <div
                class="bar-fill bar-fill--type"
                :style="{ width: `${barPercent(item.count, typeDist)}%` }"
              />
            </div>
            <div class="bar-value">{{ item.count }}</div>
          </div>
        </div>
      </div>

      <!-- 题型 × 难度 矩阵 -->
      <div class="analysis-section">
        <div class="section-title">题型 × 难度</div>
        <el-table :data="typeDifficultyMatrix" size="small" border>
          <el-table-column prop="typeLabel" label="题型" min-width="80" />
          <el-table-column
            v-for="(d, idx) in DIFFICULTY_LEVELS"
            :key="d"
            :label="`${d} 星`"
            align="center"
            min-width="60"
          >
            <template #default="{ row }">
              {{ (row as MatrixRow).cells[idx] }}
            </template>
          </el-table-column>
          <el-table-column prop="total" label="小计" align="center" min-width="60" />
        </el-table>
      </div>

      <!-- 各套卷对比 -->
      <div v-if="paperCompare.length > 0" class="analysis-section">
        <div class="section-title">各套卷对比</div>
        <div class="bar-list">
          <div v-for="(item, idx) in paperCompare" :key="idx" class="bar-row">
            <div class="bar-label" :title="item.label">{{ item.label }}</div>
            <div class="bar-track">
              <div
                class="bar-fill bar-fill--paper"
                :style="{ width: `${barPercent(item.count, paperCompare)}%` }"
              />
            </div>
            <div class="bar-value">{{ item.count }}</div>
          </div>
        </div>
      </div>

      <!-- 高频考点 TOP8 -->
      <div v-if="topKnowledges.length > 0" class="analysis-section">
        <div class="section-title">高频考点 TOP8</div>
        <div class="bar-list">
          <div v-for="(item, idx) in topKnowledges" :key="idx" class="bar-row">
            <div class="bar-label" :title="item.label">{{ item.label }}</div>
            <div class="bar-track">
              <div
                class="bar-fill bar-fill--knowledge"
                :style="{ width: `${barPercent(item.count, topKnowledges)}%` }"
              />
            </div>
            <div class="bar-value">{{ item.count }}</div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.paper-analysis-panel {
  padding: 12px;
}

.stat-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 20px;
}

.stat-card {
  background: #fff;
  border: 1px solid #f2f3f5;
  border-radius: 10px;
  padding: 16px 12px;
  text-align: center;
}

.stat-num {
  font-size: 28px;
  font-weight: 600;
  line-height: 1.2;
  color: #1d2129;
}

.stat-label {
  margin-top: 6px;
  font-size: 12px;
  color: #86909c;
}

.analysis-section {
  margin-bottom: 20px;
}

.section-title {
  margin-bottom: 12px;
  font-size: 14px;
  font-weight: 600;
  color: #1d2129;
}

.bar-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.bar-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.bar-label {
  flex: 0 0 96px;
  overflow: hidden;
  font-size: 13px;
  color: #4e5969;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bar-track {
  flex: 1 1 auto;
  height: 14px;
  overflow: hidden;
  background: #f2f3f5;
  border-radius: 7px;
}

.bar-fill {
  height: 100%;
  min-width: 2px;
  background: #1E8A8A;
  border-radius: 7px;
  transition: width 0.3s ease;
}

.bar-fill--difficulty {
  background: #f7ba1e;
}

.bar-fill--type {
  background: #1E8A8A;
}

.bar-fill--paper {
  background: #00b42a;
}

.bar-fill--knowledge {
  background: #722ed1;
}

.bar-value {
  flex: 0 0 36px;
  font-size: 13px;
  font-weight: 600;
  color: #1d2129;
  text-align: right;
}
</style>
