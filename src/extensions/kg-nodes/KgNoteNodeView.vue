<!--
  kgNote 自定义节点的 Vue NodeView。
  attrs: { title: string, text: string }
  渲染：左红边框 名师解读框（标签 + 短标题 + 正文）
-->
<script setup lang="ts">
import { NodeViewWrapper } from '@tiptap/vue-3'

const props = defineProps<{
  node: { attrs: { title: string; text: string } }
  selected: boolean
}>()
</script>

<template>
  <NodeViewWrapper
    class="kg-note-node"
    :class="{ selected: props.selected }"
    data-drag-handle
  >
    <div class="kg-note-header">
      <span class="kg-note-tag">名师解读</span>
      <span v-if="props.node.attrs.title" class="kg-note-title">
        {{ props.node.attrs.title }}
      </span>
    </div>
    <div v-if="props.node.attrs.text" class="kg-note-text">
      {{ props.node.attrs.text }}
    </div>
  </NodeViewWrapper>
</template>

<style scoped>
.kg-note-node {
  display: block;
  margin: 10px 0;
  border-left: 4px solid #dc2626;
  border-radius: 0 6px 6px 0;
  padding: 10px 14px;
  background: #fff5f5;
  cursor: default;
  user-select: none;
}

.kg-note-node.selected {
  outline: 2px solid #ef4444;
}

.kg-note-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.kg-note-tag {
  display: inline-block;
  background: #dc2626;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 3px;
  white-space: nowrap;
  flex-shrink: 0;
}

.kg-note-title {
  font-size: 14px;
  font-weight: 600;
  color: #991b1b;
  line-height: 1.4;
}

.kg-note-text {
  font-size: 13px;
  color: #7f1d1d;
  line-height: 1.7;
  white-space: pre-wrap;
}
</style>
