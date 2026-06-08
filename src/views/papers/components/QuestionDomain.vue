<script setup lang="ts">
/**
 * QuestionDomain — 三栏组卷工作台「题域」中栏 (PRD-001 T4)
 *
 * 职责：
 *   - 渲染父层已按 (考点 + 题型 + 难度) 筛好的题列表（本组件不再二次筛）。
 *   - 顶部筛选条（题型 / 难度）只通过 v-model 把选中值抛给父层，由父层执行真正的筛选。
 *   - 题卡复用共享组件 QuestionCard（禁自绘）；中栏只用 ['basket','detail'] 两个操作。
 *   - 「全部加入试题篮」一键把当前列表全部加入蓝色 QuestionBasket。
 */
import { computed } from 'vue'
import QuestionCard from '@/components/business/QuestionCard/index.vue'
import type { PaperSourceQuestion } from '@/api/question/index'

const props = withDefaults(
  defineProps<{
    /** 父层已筛好的题（本组件只渲染） */
    questions: PaperSourceQuestion[]
    /** 列表加载中 */
    loading?: boolean
    // PRD-A-013 T2 — 雪花 ID Set<string>
    /** 已在蓝色试题篮里的题 id 集合 */
    basketIds: Set<string>
    /** 正在 toggle 的题 id 集合 */
    basketLoadingIds?: Set<string>
  }>(),
  {
    loading: false,
    basketLoadingIds: () => new Set<string>(),
  },
)

/** 题型筛选（抛给父层筛） */
const filterType = defineModel<number | ''>('filterType', { default: '' })
/** 难度筛选（抛给父层筛） */
const filterDifficulty = defineModel<number | ''>('filterDifficulty', { default: '' })

const emit = defineEmits<{
  (e: 'basket-toggle', q: PaperSourceQuestion): void
  (e: 'add-all'): void
  (e: 'detail', q: PaperSourceQuestion): void
}>()

const typeOptions: { label: string; value: number | '' }[] = [
  { label: '全部题型', value: '' },
  { label: '选择题', value: 1 },
  { label: '填空题', value: 4 },
  { label: '简答题', value: 5 },
]

const difficultyOptions: { label: string; value: number | '' }[] = [
  { label: '全部难度', value: '' },
  { label: '1星', value: 1 },
  { label: '2星', value: 2 },
  { label: '3星', value: 3 },
  { label: '4星', value: 4 },
]

function onBasketToggle(q: PaperSourceQuestion): void {
  emit('basket-toggle', q)
}

function onDetail(q: PaperSourceQuestion): void {
  emit('detail', q)
}

// 当前列表是否全部已在试题栏 → 决定「全部加入」按钮翻转成「全部移除」
const allInBasket = computed(
  () =>
    props.questions.length > 0
    && props.questions.every((q) => props.basketIds.has(q.id)),
)

function onAddAll(): void {
  emit('add-all')
}
</script>

<template>
  <div v-loading="loading" class="question-domain">
    <!-- ══ 顶部筛选条 ══ -->
    <div class="domain-toolbar">
      <div class="domain-toolbar-left">
        <el-select v-model="filterType" placeholder="全部题型" size="default" class="domain-select">
          <el-option
            v-for="opt in typeOptions"
            :key="String(opt.value)"
            :label="opt.label"
            :value="opt.value"
          />
        </el-select>
        <el-select
          v-model="filterDifficulty"
          placeholder="全部难度"
          size="default"
          class="domain-select"
        >
          <el-option
            v-for="opt in difficultyOptions"
            :key="String(opt.value)"
            :label="opt.label"
            :value="opt.value"
          />
        </el-select>
        <span class="domain-total">共 {{ props.questions.length }} 题</span>
      </div>
      <div class="domain-toolbar-right">
        <el-button
          :type="allInBasket ? 'danger' : 'primary'"
          size="default"
          class="add-all-btn"
          :disabled="props.questions.length === 0"
          @click="onAddAll"
        >
          {{ allInBasket ? '全部移除' : '全部加入试题篮' }}
        </el-button>
      </div>
    </div>

    <!-- ══ 题卡列表 ══ -->
    <div class="domain-list">
      <template v-if="props.questions.length > 0">
        <QuestionCard
          v-for="q in props.questions"
          :key="q.id"
          :question="q"
          :in-basket="props.basketIds.has(q.id)"
          :basket-loading="props.basketLoadingIds?.has(q.id)"
          :actions="['basket', 'detail']"
          add-label="试题篮"
          @basket-toggle="onBasketToggle"
          @detail="onDetail"
        />
      </template>
      <el-empty v-else description="暂无题目（调整筛选或先加入试卷篮）" />
    </div>
  </div>
</template>

<style scoped>
.question-domain {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: #ffffff;
  border-radius: 10px;
  overflow: hidden;
}

.domain-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid #f2f3f5;
  flex-wrap: wrap;
  flex-shrink: 0;
}

.domain-toolbar-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  flex: 1;
  min-width: 0;
}

.domain-toolbar-right {
  flex-shrink: 0;
}

.domain-select {
  width: 130px;
}

.domain-total {
  font-size: 13px;
  color: #86909c;
  white-space: nowrap;
}

.add-all-btn {
  border-radius: 6px;
}

.domain-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 16px;
}
</style>
