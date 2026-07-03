<!--
  kgCallout 自定义节点的 Vue NodeView（生产版）。
  attrs: { lines: string（\n 分隔），color: string }
  渲染：带色边框记忆框，蓝字多行展示。
-->
<script setup lang="ts">
import { NodeViewWrapper } from '@tiptap/vue-3'
import { computed } from 'vue'

const props = defineProps<{
  node: { attrs: { lines: string; color: string } }
  selected: boolean
}>()

const lineList = computed(() =>
  (props.node.attrs.lines ?? '')
    .split('\n')
    .map((l: string) => l.trim())
    .filter(Boolean),
)

// 背景用 color + 10% 透明度（hex + '1a' = ~10%）
const bgColor = computed(() => {
  const c = props.node.attrs.color || '#2563eb'
  return c + '18'
})
</script>

<template>
  <NodeViewWrapper
    class="kg-callout-node"
    :class="{ selected: props.selected }"
    :style="{
      borderLeftColor: props.node.attrs.color || '#2563eb',
      background: bgColor,
    }"
    data-drag-handle
  >
    <div class="kg-callout-header" :style="{ color: props.node.attrs.color || '#2563eb' }">
      <span class="kg-callout-icon">★</span>
      <span class="kg-callout-label">记忆要点</span>
    </div>
    <ul class="kg-callout-lines" :style="{ color: props.node.attrs.color || '#2563eb' }">
      <li v-for="(line, i) in lineList" :key="i">{{ line }}</li>
      <li v-if="lineList.length === 0" class="empty-hint">（无内容）</li>
    </ul>
  </NodeViewWrapper>
</template>

<style scoped>
.kg-callout-node {
  display: block;
  margin: 10px 0;
  border-left: 4px solid #2563eb;
  border-radius: 0 6px 6px 0;
  padding: 10px 14px;
  cursor: default;
  user-select: none;
}

.kg-callout-node.selected {
  outline: 2px solid #1d4ed8;
}

.kg-callout-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  margin-bottom: 6px;
}

.kg-callout-icon {
  font-size: 13px;
}

.kg-callout-label {
  letter-spacing: 0.5px;
}

.kg-callout-lines {
  margin: 0;
  padding-left: 18px;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.8;
}

.kg-callout-lines li {
  margin: 1px 0;
}

.empty-hint {
  color: #94a3b8 !important;
  font-size: 12px;
  font-weight: 400;
  font-style: italic;
}
</style>
