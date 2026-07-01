<script setup lang="ts">
/**
 * Mindmap — CSS 缩进树（数据驱动，不引额外依赖）
 * 扁平节点列表 → 按 parentKey 建树 → 递归渲染 MindmapNodeItem
 */
import { computed } from 'vue'
import type { KgMindmapNode } from '@/api/kg/index'
import MindmapNodeItem from './MindmapNodeItem.vue'

const props = defineProps<{
  nodes: KgMindmapNode[]
}>()

export interface TreeNode extends KgMindmapNode {
  children: TreeNode[]
}

function buildTree(nodes: KgMindmapNode[]): TreeNode[] {
  const map = new Map<string, TreeNode>()

  for (const n of nodes) {
    map.set(n.nodeKey, { ...n, children: [] })
  }

  const roots: TreeNode[] = []
  for (const n of nodes) {
    const node = map.get(n.nodeKey)!
    if (n.parentKey == null) {
      roots.push(node)
    } else {
      const parent = map.get(n.parentKey)
      if (parent) {
        parent.children.push(node)
      } else {
        roots.push(node)
      }
    }
  }

  function sortTree(arr: TreeNode[]) {
    arr.sort((a, b) => a.sort - b.sort)
    arr.forEach((n) => sortTree(n.children))
  }
  sortTree(roots)

  return roots
}

const tree = computed(() => buildTree(props.nodes))
</script>

<template>
  <div class="mindmap-tree" role="tree" aria-label="思维导图">
    <MindmapNodeItem
      v-for="root in tree"
      :key="root.nodeKey"
      :node="root"
      :depth="0"
    />
  </div>
</template>

<style scoped>
.mindmap-tree {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 16px 20px;
  margin: 12px 0 20px;
  font-size: 14px;
  line-height: 1.7;
}
</style>
