<!--
  kgMindmap 自定义节点的 Vue NodeView。
  data attr = JSON.stringify(root)，root 结构：{ text, color?, detail?, children[] }
  渲染用 CSS 缩进树，不引重型思维导图库。
-->
<script setup lang="ts">
import { NodeViewWrapper } from '@tiptap/vue-3'
import { computed } from 'vue'

// Tiptap VueNodeViewRenderer 注入的标准 props
const props = defineProps<{
  node: { attrs: { data: string } }
  selected: boolean
}>()

// 思维导图节点树（契约 data 字段内的树结构）
interface MindmapTreeNode {
  text: string
  color?: string
  detail?: string
  children?: MindmapTreeNode[]
}

const tree = computed<MindmapTreeNode | null>(() => {
  const raw = props.node.attrs.data
  if (!raw) return null
  try {
    return JSON.parse(raw) as MindmapTreeNode
  } catch {
    return null
  }
})
</script>

<template>
  <NodeViewWrapper
    class="kg-mindmap-node"
    :class="{ selected: props.selected }"
    data-drag-handle
  >
    <div class="kg-mindmap-header">
      <span class="kg-mindmap-icon">🗺</span>
      <span class="kg-mindmap-title">思维导图</span>
    </div>
    <!-- 横向思维导图：中心节点在左，彩色分支向右展开（对齐崔崔原版布局） -->
    <div v-if="tree" class="mm-scroll">
      <div class="mm-map">
        <!-- 中心根节点 -->
        <div class="mm-root">{{ tree.text }}</div>

        <!-- 一级分支列 -->
        <div class="mm-branches">
          <div
            v-for="(branch, bi) in (tree.children ?? [])"
            :key="bi"
            class="mm-branch"
            :style="{ '--c': branch.color || '#64748b' }"
          >
            <!-- 一级：彩色标签 -->
            <div class="mm-branch-label">
              {{ branch.text }}
              <span v-if="branch.detail" class="mm-branch-detail">{{ branch.detail }}</span>
            </div>

            <!-- 二级：带说明的节点卡 -->
            <div v-if="(branch.children ?? []).length > 0" class="mm-leaves">
              <div
                v-for="(leaf, li) in (branch.children ?? [])"
                :key="li"
                class="mm-leaf"
              >
                <div class="mm-leaf-head">
                  <span class="mm-leaf-title">{{ leaf.text }}</span>
                  <span v-if="leaf.detail" class="mm-leaf-detail">{{ leaf.detail }}</span>
                </div>
                <!-- 三级：细分要点 -->
                <div v-if="(leaf.children ?? []).length > 0" class="mm-subs">
                  <div
                    v-for="(sub, si) in (leaf.children ?? [])"
                    :key="si"
                    class="mm-sub"
                  >
                    <span class="mm-sub-title">{{ sub.text }}</span>
                    <span v-if="sub.detail" class="mm-sub-detail">{{ sub.detail }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div v-else class="mm-empty">（思维导图数据为空）</div>
  </NodeViewWrapper>
</template>

<style scoped>
.kg-mindmap-node {
  display: block;
  margin: 12px 0;
  border: 1.5px solid #e2e8f0;
  border-radius: 10px;
  padding: 14px 18px;
  background: #f8fafc;
  cursor: default;
  user-select: none;
}

.kg-mindmap-node.selected {
  outline: 2px solid #3b82f6;
}

.kg-mindmap-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: #475569;
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid #e2e8f0;
}

.kg-mindmap-icon { font-size: 15px; }
.kg-mindmap-title { letter-spacing: 0.5px; }

/* ── 横向思维导图 ── */
.mm-scroll {
  overflow-x: auto;
  padding: 8px 4px;
}

.mm-map {
  display: flex;
  align-items: center;
  min-width: min-content;
  gap: 0;
}

/* 中心根节点 */
.mm-root {
  flex-shrink: 0;
  font-size: 15px;
  font-weight: 800;
  color: #fff;
  background: linear-gradient(135deg, #334155, #475569);
  padding: 14px 16px;
  border-radius: 10px;
  max-width: 140px;
  line-height: 1.4;
  box-shadow: 0 2px 8px rgba(51, 65, 85, 0.25);
}

/* 根 → 分支列 的主干横线 */
.mm-root::after {
  content: '';
  display: inline-block;
}

.mm-branches {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-left: 28px;
  position: relative;
}

/* 主干竖线（贯穿所有分支的连接干） */
.mm-branches::before {
  content: '';
  position: absolute;
  left: 0;
  top: 24px;
  bottom: 24px;
  width: 2px;
  background: #cbd5e1;
}

/* 一级分支行：标签 + 二级子节点 横向排 */
.mm-branch {
  display: flex;
  align-items: center;
  gap: 0;
  position: relative;
}

/* 分支横连线（主干 → 标签） */
.mm-branch::before {
  content: '';
  position: absolute;
  left: -28px;
  top: 50%;
  width: 28px;
  height: 2px;
  background: var(--c);
}

/* 一级：彩色实心标签 */
.mm-branch-label {
  flex-shrink: 0;
  align-self: center;
  background: var(--c);
  color: #fff;
  font-size: 14px;
  font-weight: 700;
  padding: 8px 12px;
  border-radius: 8px;
  max-width: 130px;
  line-height: 1.35;
  display: flex;
  flex-direction: column;
  gap: 2px;
  box-shadow: 0 1px 4px color-mix(in srgb, var(--c) 40%, transparent);
}

.mm-branch-detail {
  font-size: 11px;
  font-weight: 400;
  opacity: 0.9;
}

/* 二级节点列 */
.mm-leaves {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: 20px;
  position: relative;
}

/* 二级列的连接干（分支色） */
.mm-leaves::before {
  content: '';
  position: absolute;
  left: 0;
  top: 12px;
  bottom: 12px;
  width: 2px;
  background: color-mix(in srgb, var(--c) 45%, transparent);
}

/* 二级节点卡 */
.mm-leaf {
  position: relative;
  padding-left: 12px;
}

.mm-leaf::before {
  content: '';
  position: absolute;
  left: -20px;
  top: 14px;
  width: 20px;
  height: 2px;
  background: color-mix(in srgb, var(--c) 45%, transparent);
}

.mm-leaf-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  border-bottom: 1.5px solid color-mix(in srgb, var(--c) 30%, transparent);
  padding-bottom: 2px;
}

.mm-leaf-title {
  font-size: 13.5px;
  font-weight: 700;
  color: #1e293b;
  white-space: nowrap;
}

.mm-leaf-detail {
  font-size: 12.5px;
  color: #475569;
}

/* 三级细分 */
.mm-subs {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 3px 0 3px 10px;
}

.mm-sub {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
}

.mm-sub::before {
  content: '›';
  color: var(--c);
  font-weight: 700;
}

.mm-sub-title {
  font-weight: 600;
  color: #334155;
  white-space: nowrap;
}

.mm-sub-detail {
  color: #64748b;
}

.mm-empty {
  color: #94a3b8;
  font-size: 13px;
  font-style: italic;
}
</style>
