<script setup lang="ts">
// ---------------------------------------------------------------------------
// PRD-C-014 T3 — 知识点树选择弹层（主考点 / 副考点 / 头部主考点·年级共用入口）。
//
// 数据源 = A 线既有 lazyTree（POST /teacher/question/lazyTree，misikt envelope，整树返回）。
// 单选模式（主考点）：选叶子即回 {id, name} 并关闭。
// 多选模式（副考点）：勾选叶子（上限 max），确认回 [{id, name}, …]。
// 可搜索过滤（按 title 含关键字，el-tree filter）。叶子判定 = !hasChildren && 无 children。
// ---------------------------------------------------------------------------
import { nextTick, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { TreeNodeData } from 'element-plus'
import { lazyTree, type SubjectNode } from '@/api/question'

const props = defineProps<{
  modelValue: boolean
  /** 'single' 主考点单选 / 'multi' 副考点多选 */
  mode: 'single' | 'multi'
  title?: string
  /** 多选上限（副考点 ≤3） */
  max?: number
  /** 多选预选中的知识点 id（回填勾选态） */
  preselected?: string[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  /** 单选：选叶子即发；value = {id, name} */
  (e: 'pick', value: { id: string; name: string }): void
  /** 多选：确认发；value = [{id, name}, …] */
  (e: 'pick-multi', value: Array<{ id: string; name: string }>): void
}>()

const treeData = ref<SubjectNode[]>([])
const loading = ref(false)
const keyword = ref('')
const treeRef = ref()
const checkedNodes = ref<Array<{ id: string; name: string }>>([])

const treeProps = { label: 'title', children: 'children' } as const

function isLeaf(node: SubjectNode): boolean {
  return !node.hasChildren && (!node.children || node.children.length === 0)
}

function filterNode(value: string, data: TreeNodeData) {
  if (!value) return true
  return ((data as SubjectNode).title ?? '').includes(value)
}

watch(keyword, (v) => treeRef.value?.filter(v))

async function loadTree() {
  if (treeData.value.length) return
  loading.value = true
  try {
    const result = await lazyTree(0)
    if (Array.isArray(result)) treeData.value = result
    else if (result && typeof result === 'object') treeData.value = [result as unknown as SubjectNode]
  } catch (e) {
    ElMessage.error(`知识点树加载失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    loading.value = false
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) void loadTree()
  }
)

function close() {
  emit('update:modelValue', false)
}

// 单选：点叶子即发回 + 关闭（点非叶子只展开，不回写）
function onNodeClick(data: SubjectNode) {
  if (props.mode !== 'single') return
  if (!isLeaf(data)) return
  emit('pick', { id: String(data.id), name: data.title })
  close()
}

// 多选：勾选变更时收集叶子（最多 max）
function onCheckChange() {
  if (props.mode !== 'multi') return
  const nodes = (treeRef.value?.getCheckedNodes(true) ?? []) as SubjectNode[] // true = 仅叶子
  const leaves = nodes.filter(isLeaf)
  checkedNodes.value = leaves.map((n) => ({ id: String(n.id), name: n.title }))
}

function confirmMulti() {
  const max = props.max ?? 3
  if (checkedNodes.value.length > max) {
    ElMessage.warning(`副考点最多选 ${max} 个`)
    return
  }
  emit('pick-multi', checkedNodes.value)
  close()
}

// 弹层打开后回填多选预选（树渲染完再 setChecked）
watch(
  () => props.modelValue,
  async (open) => {
    if (open && props.mode === 'multi' && props.preselected?.length) {
      await nextTick()
      // 等树数据就绪
      const tryset = () => {
        if (treeData.value.length && treeRef.value) {
          treeRef.value.setCheckedKeys(props.preselected ?? [], true)
          onCheckChange()
        } else {
          window.setTimeout(tryset, 120)
        }
      }
      tryset()
    } else if (open && props.mode === 'multi') {
      checkedNodes.value = []
    }
  }
)
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="title || (mode === 'single' ? '选择主考点' : '选择副考点')"
    width="460px"
    append-to-body
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-input
      v-model="keyword"
      placeholder="搜索知识点…"
      clearable
      size="default"
      class="kp-search"
    />
    <div v-loading="loading" class="kp-tree-box">
      <el-tree
        ref="treeRef"
        :data="treeData"
        :props="treeProps"
        node-key="id"
        :show-checkbox="mode === 'multi'"
        :check-strictly="true"
        :filter-node-method="filterNode"
        :expand-on-click-node="mode === 'single'"
        highlight-current
        @node-click="onNodeClick"
        @check="onCheckChange"
      >
        <template #default="{ data }">
          <span class="kp-node" :class="{ 'is-leaf': isLeaf(data) }">{{ data.title }}</span>
        </template>
      </el-tree>
      <p v-if="!loading && treeData.length === 0" class="kp-empty">
        暂时取不到知识点列表，请稍后重试，或联系管理员。
      </p>
    </div>
    <p class="kp-hint">
      {{ mode === 'single' ? '点击叶子知识点即选定' : `勾选叶子知识点（最多 ${max ?? 3} 个），确认后回写` }}
    </p>
    <template v-if="mode === 'multi'" #footer>
      <el-button @click="close">取消</el-button>
      <el-button type="primary" @click="confirmMulti">确认（{{ checkedNodes.length }}）</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.kp-search {
  margin-bottom: 10px;
}
.kp-tree-box {
  max-height: 360px;
  overflow-y: auto;
  border: 1px solid #e7e3da;
  border-radius: 10px;
  padding: 6px;
  min-height: 120px;
}
.kp-node {
  font-size: 13px;
  color: #385350;
}
.kp-node.is-leaf {
  color: #0f6e6e;
  font-weight: 600;
}
.kp-empty {
  margin: 16px 0;
  text-align: center;
  font-size: 12px;
  color: #9fb0ad;
}
.kp-hint {
  margin: 8px 2px 0;
  font-size: 12px;
  color: #6b817e;
}
</style>
