<script setup lang="ts">
/**
 * papers/basket.vue — misikt 三栏组卷工作台 (PRD-001 主页面)
 *
 * 三栏：左 KnowledgeAside(考点) / 中 QuestionDomain(题域) / 右 RightPanel(快速组卷 + 试卷分析双 tab)。
 *
 * 数据流：usePaperBasket(已选卷) → useBasketWorkbench(逐卷 detail → 合并去重 → 派生考点/全量题)
 *   → 本页集中持有筛选态(考点多选 + 题型 + 难度) → 派生 filteredQuestions
 *   → 同一份 filteredQuestions 同时喂给中栏 / 快速组卷 / 试卷分析
 *   → 这样「中栏共N题」与「分析总题数」天然恒等(G6)。
 *
 * 加入试题篮 = 复用蓝色 QuestionBasket 的 useQuestionBasket(跨模块共享态，禁重造)。
 * 详情 = 复用题库题目详情页 /question/detail/:id(共享组件，禁重造)。
 */
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { usePaperBasket } from '@/composables/usePaperBasket'
import { useBasketWorkbench } from '@/composables/useBasketWorkbench'
import { useQuestionBasket } from '@/composables/useQuestionBasket'
import type { PaperSourceQuestion } from '@/api/question/index'
import KnowledgeAside from '@/views/papers/components/KnowledgeAside.vue'
import QuestionDomain from '@/views/papers/components/QuestionDomain.vue'
import QuickComposePanel from '@/views/papers/components/QuickComposePanel.vue'
import PaperAnalysisPanel from '@/views/papers/components/PaperAnalysisPanel.vue'

const router = useRouter()
const basket = usePaperBasket()
const workbench = useBasketWorkbench()
const questionBasket = useQuestionBasket()

// ── 集中持有的筛选态 ─────────────────────────────────────────
const selectedKnowledge = ref<string[]>([])
const filterType = ref<number | ''>('')
const filterDifficulty = ref<number | ''>('')

// ── 中栏/快速组卷/分析 共用的派生题集（考点 + 题型 + 难度 本地筛）──
const filteredQuestions = computed<PaperSourceQuestion[]>(() => {
  const selSet = new Set(selectedKnowledge.value)
  return workbench.questions.value.filter((q) => {
    if (selSet.size > 0) {
      const ks = Array.isArray(q.questionKnowledges) ? q.questionKnowledges : []
      const hit = ks.some((k) => selSet.has(String(k.knowledgeId ?? k.knowledgeName ?? '')))
      if (!hit) return false
    }
    if (filterType.value !== '' && q.questionType !== filterType.value) return false
    if (filterDifficulty.value !== '' && (q.difficult ?? -1) !== filterDifficulty.value) return false
    return true
  })
})

// ── 试题篮联动 ───────────────────────────────────────────────
const basketIds = computed(() => questionBasket.basketIds.value)

async function handleBasketToggle(q: PaperSourceQuestion): Promise<void> {
  if (questionBasket.isLoading(q.id)) return
  if (questionBasket.basketIds.value.has(q.id)) {
    await questionBasket.remove(q.id)
  } else {
    await questionBasket.add(q)
  }
}

async function handleAddAll(): Promise<void> {
  // addMany 内部已过滤已在篮 + 单条汇总 toast（含"均已在篮"提示）
  await questionBasket.addMany(filteredQuestions.value)
}

function handleDetail(q: PaperSourceQuestion): void {
  // 复用题库题目详情页(共享，禁重造)。写一份 cache 供详情页接口失败时兜底。
  try {
    const cacheKey = 'book-ui:question-cache-by-id'
    const existing: Record<string, unknown> = JSON.parse(localStorage.getItem(cacheKey) || '{}')
    existing[String(q.id)] = q
    localStorage.setItem(cacheKey, JSON.stringify(existing))
  } catch (e) {
    console.warn('[basket] detail cache write failed', e)
  }
  router.push(`/question/detail/${q.id}`)
}

// ── 数据加载：进页 + 篮内卷变化时重新逐卷 detail ──────────────
onMounted(() => {
  workbench.load()
})
watch(
  () => basket.basketIds.value,
  () => {
    // 篮变 → 重拉；同时清掉已不再适用的考点选择
    selectedKnowledge.value = []
    workbench.load()
  },
)

const failedHint = computed(() =>
  workbench.failedPaperIds.value.length > 0
    ? `${workbench.failedPaperIds.value.length} 张卷加载失败，已跳过`
    : '',
)

const rightTab = ref<'compose' | 'analysis'>('compose')
</script>

<template>
  <div class="basket-workbench">
    <!-- ── 顶部条：已选试卷 (N) ── -->
    <div class="wb-topbar">
      <div class="wb-topbar-left">
        <span class="wb-title">组卷工作台</span>
        <el-tag type="primary" round>已选试卷 {{ basket.count.value }}</el-tag>
        <span v-if="workbench.loading.value" class="wb-loading-hint">
          <el-icon class="is-loading"><Loading /></el-icon> 正在拉取试卷题目…
        </span>
        <el-tag v-if="failedHint" type="warning" size="small" effect="plain">{{ failedHint }}</el-tag>
      </div>
      <div class="wb-topbar-right">
        <el-button size="small" @click="router.push('/papers/index')">返回卷库</el-button>
      </div>
    </div>

    <!-- ── 三栏 ── -->
    <div class="wb-columns">
      <!-- 左：考点 -->
      <aside class="wb-col wb-col-left">
        <KnowledgeAside
          v-model:selected="selectedKnowledge"
          :groups="workbench.knowledgeGroups.value"
          :loading="workbench.loading.value"
        />
      </aside>

      <!-- 中：题域 -->
      <main class="wb-col wb-col-center">
        <QuestionDomain
          v-model:filter-type="filterType"
          v-model:filter-difficulty="filterDifficulty"
          :questions="filteredQuestions"
          :loading="workbench.loading.value"
          :basket-ids="basketIds"
          :basket-loading-ids="questionBasket.togglingIds"
          @basket-toggle="handleBasketToggle"
          @add-all="handleAddAll"
          @detail="handleDetail"
        />
      </main>

      <!-- 右：组卷面板（快速组卷 + 试卷分析 双 tab）-->
      <aside class="wb-col wb-col-right">
        <div class="wb-right-card">
          <el-tabs v-model="rightTab" class="wb-right-tabs">
            <el-tab-pane label="快速组卷" name="compose">
              <QuickComposePanel :questions="filteredQuestions" />
            </el-tab-pane>
            <el-tab-pane label="试卷分析" name="analysis">
              <PaperAnalysisPanel :questions="filteredQuestions" :papers="workbench.papers.value" />
            </el-tab-pane>
          </el-tabs>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.basket-workbench {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 60px);
  background: #f0f2f5;
}

.wb-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: #fff;
  border-bottom: 1px solid #f2f3f5;
  flex-shrink: 0;
}

.wb-topbar-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.wb-title {
  font-size: 15px;
  font-weight: 700;
  color: #1d2129;
}

.wb-loading-hint {
  font-size: 12px;
  color: #86909c;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.wb-columns {
  flex: 1;
  display: flex;
  gap: 12px;
  padding: 12px;
  min-height: 0;
  overflow: hidden;
}

.wb-col {
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.wb-col-left {
  width: 260px;
  flex-shrink: 0;
}

.wb-col-center {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}

.wb-col-right {
  width: 380px;
  flex-shrink: 0;
}

.wb-right-card {
  background: #fff;
  border-radius: 10px;
  border: 1px solid #f2f3f5;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.wb-right-tabs {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 0 12px;
}

.wb-right-tabs :deep(.el-tabs__content) {
  flex: 1;
  overflow-y: auto;
}
</style>
