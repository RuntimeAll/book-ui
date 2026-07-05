<script setup lang="ts">
/**
 * PRD-C-213 FP18 — 课次 KG 锚点多选（kg_node_ids = biz_subject id 数组）。
 * 复用题库现成章节树接口 lazyTree（@/api/question），el-tree-select 多选版。
 * 树数据由父页统一加载后经 :data 注入（避免每个课次弹窗重复拉全树）。
 * 🔴 id 全 string；node-key=id，label=title。
 */
import { computed } from 'vue'
import type { SubjectNode } from '@/api/question/index'

const props = withDefaults(
  defineProps<{
    modelValue?: string[]
    data?: SubjectNode[]
    loading?: boolean
    disabled?: boolean
  }>(),
  {
    modelValue: () => [],
    data: () => [],
    loading: false,
    disabled: false,
  },
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: string[]): void
}>()

const treeProps = { label: 'title', children: 'children' }

const selected = computed<string[]>(() => (props.modelValue ?? []).map(String))

function handleChange(val: string[]) {
  emit('update:modelValue', (val ?? []).map(String))
}
</script>

<template>
  <el-tree-select
    :model-value="selected"
    :data="data"
    :props="treeProps"
    :loading="loading"
    :disabled="disabled"
    node-key="id"
    multiple
    check-strictly
    show-checkbox
    collapse-tags
    collapse-tags-tooltip
    clearable
    filterable
    :render-after-expand="false"
    placeholder="选择课内锚点（章节 / 知识点，可多选）"
    class="kg-anchor-select"
    @update:model-value="(v: string[]) => handleChange(v)"
  />
</template>

<style scoped>
.kg-anchor-select {
  width: 100%;
}
</style>
