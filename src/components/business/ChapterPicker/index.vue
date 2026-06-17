<script setup lang="ts">
/**
 * PRD-A-015 批1 — 可复用「章节/知识点树选择器」。
 *
 * v-model:string 绑节点 id（= subjectId）。树 = 教材→年级→章→节→知识点，深层即知识点。
 * 🔴 lazyTree 实际一次返整棵嵌套树（后端忽略 parentId，见 api/question/index.ts 注释），
 *    故这里挂载时拉一次全树喂 el-tree-select :data（非懒加载），选中后 label 也能正确解析。
 */
import { ref, watch, onMounted } from 'vue'
import { lazyTree, type SubjectNode } from '@/api/question/index'

const props = withDefaults(
  defineProps<{
    modelValue?: string | null
    disabled?: boolean
  }>(),
  {
    modelValue: '',
    disabled: false,
  },
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

// el-tree-select 字段映射（⚠️ 节点名字段是 title 不是 name）
const treeProps = {
  label: 'title',
  children: 'children',
}

const treeData = ref<SubjectNode[]>([])
const loading = ref(false)

const selected = ref<string>(props.modelValue ? String(props.modelValue) : '')
watch(
  () => props.modelValue,
  (v) => {
    selected.value = v ? String(v) : ''
  },
)

function handleChange(val: string) {
  selected.value = val
  emit('update:modelValue', val == null ? '' : String(val))
}

async function loadTree() {
  loading.value = true
  try {
    const res = await lazyTree(0)
    treeData.value = Array.isArray(res) ? res : res ? [res as unknown as SubjectNode] : []
  } catch (e) {
    console.warn('[ChapterPicker] lazyTree failed', e)
    treeData.value = []
  } finally {
    loading.value = false
  }
}

onMounted(loadTree)
</script>

<template>
  <el-tree-select
    :model-value="selected"
    :data="treeData"
    :props="treeProps"
    :loading="loading"
    :disabled="disabled"
    node-key="id"
    check-strictly
    clearable
    filterable
    :render-after-expand="false"
    placeholder="选择章节 / 知识点"
    class="chapter-picker"
    @update:model-value="(v: string) => handleChange(v)"
  >
    <!-- 树未加载完但已有选中 id 时兜底显 id（加载好后 el-tree-select 自动按 node-key 解析 title） -->
    <template #label="{ label }">
      <span>{{ label || selected || '—' }}</span>
    </template>
  </el-tree-select>
</template>

<style scoped>
.chapter-picker {
  width: 100%;
}
</style>
