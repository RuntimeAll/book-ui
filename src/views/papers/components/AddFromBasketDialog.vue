<script setup lang="ts">
/**
 * PRD-A-010 T3 — 编辑态「从试题栏增题」弹窗（纯结构性抽取，行为不变）
 *
 * 抽离自 source.vue 编辑态增题 el-dialog。逻辑（试题栏数据源、过滤已在卷中的题、
 * 复用共享 QuestionCard）全在父组件，本组件仅做模板承载：
 *   - basketEmpty / addableItems 由父组件传入（父持 useQuestionBasket 单例，不重造）
 *   - 增题动作 emit('add', q) 由父级 addQuestionFromBasket 接住
 *   - 共享组件 QuestionCard 复用（memory project_shared_components 铁则，禁重造）
 */
import QuestionCard from '@/components/business/QuestionCard/index.vue'
import { Plus } from '@element-plus/icons-vue'
import type { QuestionItem } from '@/api/question/index'

defineProps<{
  visible: boolean
  /** 试题栏是否为空（父 basket.items.value.length === 0）*/
  basketEmpty: boolean
  /** 可增题（试题栏内 - 已在本卷的题）*/
  addableItems: QuestionItem[]
}>()

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'add', q: QuestionItem): void
}>()
</script>

<template>
  <el-dialog
    :model-value="visible"
    title="从试题栏增题"
    width="70%"
    :close-on-click-modal="false"
    @update:model-value="emit('update:visible', $event)"
  >
    <el-empty
      v-if="basketEmpty"
      description="试题栏为空，请先在题库中加题到试题栏"
    />
    <el-alert
      v-else-if="addableItems.length === 0"
      type="info"
      :closable="false"
      title="试题栏内题目均已在本试卷中"
      show-icon
    />
    <el-scrollbar v-else max-height="500px">
      <div v-for="q in addableItems" :key="q.id" class="add-item">
        <div class="add-item-card">
          <QuestionCard :question="q" :actions="[]" />
        </div>
        <el-button type="primary" size="small" @click="emit('add', q)">
          <el-icon><Plus /></el-icon>添加
        </el-button>
      </div>
    </el-scrollbar>
    <template #footer>
      <el-button @click="emit('update:visible', false)">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
/* 增题弹窗候选项（逐字搬自 source.vue）*/
.add-item {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.add-item-card {
  flex: 1;
  min-width: 0;
}
</style>
