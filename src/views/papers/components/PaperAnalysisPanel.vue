<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowDown, MagicStick } from '@element-plus/icons-vue'
import { lazyTree, type PaperSourceQuestion, type SubjectNode } from '@/api/question/index'
import type { WorkbenchPaper } from '@/composables/useBasketWorkbench'
import { useDictStore, DICT_QUESTION_TYPE } from '@/store/dict'
import MarkdownMath from '@/components/MarkdownMath.vue'

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

// ---- AI 命题分析（仅单卷时展示该卷的 remark；多卷混合无单一定性，不展示）----
const reviewOpen = ref(true)
const singleReview = computed<string>(() => {
  if (props.papers.length !== 1) return ''
  return (props.papers[0].remark || '').trim()
})

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

// ---- 章节分布（知识点归章）----
// 题的知识点 id 是层级码（如 100002002001002），前 6 位 = 章节节点 id（100002=第2章）。
// 章节中文名走知识点 lazyTree（按题中出现的学科根逐个拉，扁平成 id→title）。零 BE 新接口。
const chapterTitle = ref<Map<string, string>>(new Map())

function flattenTree(nodes: SubjectNode[], map: Map<string, string>) {
  for (const n of nodes) {
    if (n.id != null) map.set(String(n.id), n.title)
    if (Array.isArray(n.children) && n.children.length) flattenTree(n.children, map)
  }
}

// 题中出现的学科根（知识点 id 前 3 位，如 100/200），逐根拉树建名表
const subjectRoots = computed<string[]>(() => {
  const set = new Set<string>()
  for (const q of props.questions) {
    for (const k of q.questionKnowledges ?? []) {
      const id = String(k.knowledgeId ?? '')
      if (id.length >= 3) set.add(id.slice(0, 3))
    }
  }
  return [...set]
})

watch(subjectRoots, async (roots) => {
  if (!roots.length) return
  const map = new Map<string, string>()
  for (const root of roots) {
    try {
      const tree = await lazyTree(root)
      if (Array.isArray(tree)) flattenTree(tree, map)
    } catch (e) {
      console.warn('[analysis] 章节树拉取失败', root, e)
    }
  }
  chapterTitle.value = map
}, { immediate: true })

// 每题取首个知识点归章，按**分值**合计（pqScore 优先），分值 desc 排序。
// 章节考频看的是「这章占多少分」而非「几道题」——分值才是命题人配比的真权重。
const chapterDist = computed<DistItem[]>(() => {
  const agg = new Map<string, number>()
  for (const q of props.questions) {
    const k = (q.questionKnowledges ?? [])[0]
    const kid = String(k?.knowledgeId ?? '')
    if (kid.length < 6) continue
    const cid = kid.slice(0, 6)
    const sc = Number(q.pqScore ?? q.score ?? 0) || 0
    agg.set(cid, (agg.get(cid) ?? 0) + sc)
  }
  return [...agg.entries()]
    .map(([cid, score]) => ({ label: chapterTitle.value.get(cid) || `章节 ${cid}`, count: Math.round(score * 10) / 10 }))
    .sort((a, b) => b.count - a.count)
})

// ---- 主观/客观题占比（客观=选择1/判断2/填空4；其余=主观）----
const OBJECTIVE_TYPES = new Set([1, 2, 4])
const objectiveSplit = computed<DistItem[]>(() => {
  let obj = 0
  let subj = 0
  for (const q of props.questions) {
    if (OBJECTIVE_TYPES.has(q.questionType)) obj++
    else subj++
  }
  return [
    { label: '客观题', count: obj },
    { label: '主观题', count: subj },
  ]
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
      <!-- AI 命题分析（单卷时置顶；老师先看定性，再看下方统计图表）-->
      <div v-if="singleReview" class="ai-review-card">
        <div class="ai-review-head" @click="reviewOpen = !reviewOpen">
          <div class="ai-review-head-left">
            <el-icon class="ai-review-icon"><MagicStick /></el-icon>
            <span class="ai-review-title">AI 命题分析</span>
            <span class="ai-review-badge">智能</span>
          </div>
          <el-icon class="ai-review-toggle" :class="{ 'is-open': reviewOpen }"><ArrowDown /></el-icon>
        </div>
        <div v-show="reviewOpen" class="ai-review-body">
          <MarkdownMath :content="singleReview" />
        </div>
      </div>

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

      <!-- 章节分布（知识点归章，按分值）-->
      <div v-if="chapterDist.length > 0" class="analysis-section">
        <div class="section-title">章节分布（按分值）</div>
        <div class="bar-list">
          <div v-for="item in chapterDist" :key="item.label" class="bar-row">
            <div class="bar-label" :title="item.label">{{ item.label }}</div>
            <div class="bar-track">
              <div
                class="bar-fill bar-fill--chapter"
                :style="{ width: `${barPercent(item.count, chapterDist)}%` }"
              />
            </div>
            <div class="bar-value">{{ item.count }}分</div>
          </div>
        </div>
      </div>

      <!-- 主观 / 客观题占比 -->
      <div class="analysis-section">
        <div class="section-title">主观 / 客观题</div>
        <div class="bar-list">
          <div v-for="item in objectiveSplit" :key="item.label" class="bar-row">
            <div class="bar-label">{{ item.label }}</div>
            <div class="bar-track">
              <div
                class="bar-fill bar-fill--objective"
                :style="{ width: `${barPercent(item.count, objectiveSplit)}%` }"
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

      <!-- 各套卷对比（单卷时无意义，多卷才显）-->
      <div v-if="paperCompare.length > 1" class="analysis-section">
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

/* AI 命题分析卡 */
.ai-review-card {
  background: linear-gradient(180deg, #f6fbfb 0%, #fff 40%);
  border: 1px solid #d6ecec;
  border-radius: 10px;
  margin-bottom: 16px;
  overflow: hidden;
}

.ai-review-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  cursor: pointer;
  user-select: none;
}

.ai-review-head-left {
  display: flex;
  align-items: center;
  gap: 7px;
}

.ai-review-icon {
  color: #1E8A8A;
  font-size: 16px;
}

.ai-review-title {
  font-size: 14px;
  font-weight: 700;
  color: #1d2129;
}

.ai-review-badge {
  font-size: 11px;
  font-weight: 600;
  color: #1E8A8A;
  background: #e3f4f4;
  border-radius: 10px;
  padding: 1px 7px;
}

.ai-review-toggle {
  color: #86909c;
  transition: transform 0.25s ease;
}

.ai-review-toggle.is-open {
  transform: rotate(180deg);
}

.ai-review-body {
  padding: 2px 14px 14px;
  border-top: 1px solid #ebf3f3;
  max-height: 360px;
  overflow-y: auto;
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

.bar-fill--chapter {
  background: #1E8A8A;
}

.bar-fill--objective {
  background: #ff7d00;
}

.bar-value {
  flex: 0 0 36px;
  font-size: 13px;
  font-weight: 600;
  color: #1d2129;
  text-align: right;
}
</style>
