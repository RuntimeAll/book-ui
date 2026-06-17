<script setup lang="ts">
/**
 * PRD-A-015 批1 — 可复用「章节/知识点树选择器」。
 *
 * v-model:string 绑节点 id（= subjectId）。树 = 教材→年级→章→节→知识点，深层即知识点。
 * 🔴 lazyTree 实际一次返整棵嵌套树（后端忽略 parentId，见 api/question/index.ts 注释），
 *    故这里挂载时拉一次全树喂 el-tree-select :data（非懒加载），选中后 label 也能正确解析。
 */
import { ref, computed, watch, onMounted } from 'vue'
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

// 递归在整树里找节点 → 拿其 title。找不到返 null（= 该 id 不在新章节树里，多为旧 misikt 路径码）。
function findTitle(nodes: SubjectNode[], id: string): string | null {
  for (const n of nodes) {
    if (String(n.id) === id) return n.title ?? null
    if (n.children && n.children.length) {
      const t = findTitle(n.children, id)
      if (t != null) return t
    }
  }
  return null
}
// 已选 id 在树里解析到的名字；树未加载完或 id 不在树里 → null。
const resolvedTitle = computed<string | null>(() => {
  if (!selected.value || treeData.value.length === 0) return null
  return findTitle(treeData.value, selected.value)
})
// 树已加载但 id 解析不出 = 未匹配（旧分类码）。
const isUnmatched = computed<boolean>(
  () => !loading.value && treeData.value.length > 0 && !!selected.value && resolvedTitle.value == null,
)

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
    <!-- label 解析逻辑：
         · node-key 在树里命中 → label 有值，正常显节点名。
         · 树已加载但 id 不在树里（78% 历史题用 misikt 旧路径码，未映射进新章节树）→ 降级标注，
           让用户明白这不是渲染 bug，是旧归类，重新选一个真实章节保存即修正。
         · 树还没加载完 → 先显原始 id 兜底。 -->
    <template #label="{ label }">
      <span v-if="isUnmatched" class="unmatched">原始码 {{ selected }}（未匹配章节，可重选）</span>
      <span v-else-if="resolvedTitle">{{ resolvedTitle }}</span>
      <span v-else>{{ label || selected || '—' }}</span>
    </template>
  </el-tree-select>
</template>

<style scoped>
.chapter-picker {
  width: 100%;
}
.unmatched {
  color: #e6a23c;
  font-size: 12px;
}
</style>
