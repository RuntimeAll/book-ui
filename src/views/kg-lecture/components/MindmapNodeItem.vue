<script setup lang="ts">
/**
 * MindmapNodeItem — 思维导图单节点（递归）
 * depth 0 = 根节点，depth 1 = 一级分支（带 color），depth 2+ = 叶节点
 */
import type { TreeNode } from './Mindmap.vue'

const props = defineProps<{
  node: TreeNode
  depth: number
}>()
</script>

<template>
  <div
    class="mm-node"
    :class="`depth-${Math.min(props.depth, 3)}`"
    :style="props.depth === 1 && props.node.color ? { '--branch-color': props.node.color } : {}"
  >
    <!-- 节点标签行 -->
    <div class="mm-label" :class="{ 'mm-mark': props.node.hasMark === 1 }">
      <span v-if="props.depth >= 2" class="mm-dot" />
      <span class="mm-text">{{ props.node.text }}</span>
      <span v-if="props.node.detail" class="mm-detail"> — {{ props.node.detail }}</span>
    </div>

    <!-- 子节点（递归） -->
    <div v-if="props.node.children.length > 0" class="mm-children">
      <MindmapNodeItem
        v-for="child in props.node.children"
        :key="child.nodeKey"
        :node="child"
        :depth="props.depth + 1"
      />
    </div>
  </div>
</template>

<style scoped>
/* depth-0 = 根节点 */
.mm-node.depth-0 > .mm-label {
  font-size: 16px;
  font-weight: 700;
  color: #1e293b;
  margin-bottom: 6px;
}

/* depth-1 = 一级分支 */
.mm-node.depth-1 {
  margin-left: 16px;
  border-left: 3px solid var(--branch-color, #94a3b8);
  padding-left: 10px;
  margin-top: 10px;
  margin-bottom: 4px;
}
.mm-node.depth-1 > .mm-label {
  font-size: 15px;
  font-weight: 600;
  color: var(--branch-color, #334155);
}

/* depth-2 */
.mm-node.depth-2 {
  margin-left: 20px;
  margin-top: 4px;
}

/* depth-3+ */
.mm-node.depth-3 {
  margin-left: 20px;
  margin-top: 2px;
}

/* dot */
.mm-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #94a3b8;
  margin-right: 6px;
  vertical-align: middle;
  flex-shrink: 0;
}
.mm-node.depth-3 > .mm-label .mm-dot {
  width: 4px;
  height: 4px;
  background: #cbd5e1;
}

/* 标红节点（hasMark=1） */
.mm-label.mm-mark .mm-text {
  color: #dc2626;
  font-weight: 600;
}

.mm-label {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0;
}

.mm-text {
  color: #1e293b;
  font-size: 14px;
}

.mm-detail {
  color: #64748b;
  font-size: 12px;
  font-style: italic;
}

.mm-children {
  margin-top: 2px;
}
</style>
