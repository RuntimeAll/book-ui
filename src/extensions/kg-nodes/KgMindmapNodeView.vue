<!--
  kgMindmap 自定义节点的 Vue NodeView。
  data attr = JSON.stringify(root)，root 结构：{ text, color?, detail?, children[] }
  用 simple-mind-map 只读渲染横向逻辑结构图（对齐崔崔原版的横向思维导图观感）。
  - 内联：固定预览（fit 看全貌，pointer-events:none 不响应交互）
  - 全屏：Teleport 到 body 的全屏层，可缩放/拖拽/滚动查看细节
-->
<script setup lang="ts">
import { NodeViewWrapper } from '@tiptap/vue-3'
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
// PRD-C-212 V0：simple-mind-map（~几百KB）改首用动态加载，不再拖累讲义 chunk 首屏
import type MindMapType from 'simple-mind-map'

type MindMapCtor = typeof MindMapType
type MindMapInstance = InstanceType<MindMapCtor>

let smmCtor: MindMapCtor | null = null
let smmLoadPromise: Promise<MindMapCtor> | null = null
function loadSmm(): Promise<MindMapCtor> {
  if (!smmLoadPromise) {
    smmLoadPromise = import('simple-mind-map')
      .then((m) => {
        smmCtor = m.default
        return smmCtor
      })
      .catch((e) => {
        // 允许下次重试（chunk 网络抖动）
        smmLoadPromise = null
        throw e
      })
  }
  return smmLoadPromise
}

const props = defineProps<{
  node: { attrs: { data: string } }
  selected: boolean
}>()

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

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// 我方树 → simple-mind-map 数据（detail 作第二行灰字；一级分支上色）
function toSmm(n: MindmapTreeNode, depth = 0): unknown {
  const lines = [`<span>${escapeHtml(n.text)}</span>`]
  if (n.detail) {
    lines.push(`<span style="font-size:12px;color:#94a3b8">${escapeHtml(n.detail)}</span>`)
  }
  const data: Record<string, unknown> = {
    text: `<div style="text-align:left">${lines.join('<br/>')}</div>`,
    richText: true,
  }
  if (depth === 1) {
    data.fillColor = n.color || '#64748b'
    data.color = '#ffffff'
    data.borderColor = n.color || '#64748b'
  }
  return {
    data,
    children: (n.children ?? []).map((c) => toSmm(c, depth + 1)),
  }
}

const THEME_CONFIG = {
  backgroundColor: '#ffffff',
  lineWidth: 2,
  lineColor: '#cbd5e1',
  root: { fillColor: '#334155', color: '#ffffff', fontSize: 15, borderRadius: 8, paddingX: 14, paddingY: 10 },
  second: { borderRadius: 8, fontSize: 14, paddingX: 12, paddingY: 8 },
  node: { fontSize: 13, paddingX: 8, paddingY: 5, borderRadius: 4, color: '#1e293b' },
}

function buildMindMap(el: HTMLElement): MindMapInstance {
  if (!smmCtor) throw new Error('simple-mind-map 尚未加载（先 await loadSmm()）')
  // 上游 d.ts 把全部 140+ 选项标成必填（运行时实际全可选），窄断言到构造参数类型
  const mm = new smmCtor({
    el,
    data: toSmm(tree.value as MindmapTreeNode) as never,
    readonly: true,
    layout: 'logicalStructure',
    theme: 'freshGreen',
    initRootNodePosition: ['left', 'center'],
    themeConfig: THEME_CONFIG,
    mousewheelAction: 'zoom',
    enableFreeDrag: false,
  } as unknown as ConstructorParameters<MindMapCtor>[0])
  mm.on('node_tree_render_end', () => {
    try {
      // 上游 d.ts 给 fit 标了 3 个必填参数，运行时 0 参调用是官方用法，窄断言绕过
      ;(mm.view as unknown as { fit: () => void }).fit()
    } catch {
      /* fit 偶发在尺寸未定时抛错，忽略 */
    }
  })
  return mm
}

// ── 内联实例（固定预览） ──
const containerRef = ref<HTMLDivElement | null>(null)
const smmLoading = ref(false)
let mindMap: MindMapInstance | null = null

async function renderInline() {
  if (!containerRef.value || !tree.value) return
  if (!smmCtor) {
    smmLoading.value = true
    try {
      await loadSmm()
    } catch (e) {
      console.warn('[kgMindmap] simple-mind-map 加载失败:', e)
      return
    } finally {
      smmLoading.value = false
    }
    // await 期间组件可能已卸载/数据已变
    if (!containerRef.value || !tree.value) return
  }
  if (mindMap) {
    mindMap.destroy()
    mindMap = null
  }
  mindMap = buildMindMap(containerRef.value)
}

// ── 全屏实例（可交互） ──
const fullscreen = ref(false)
const fsContainerRef = ref<HTMLDivElement | null>(null)
let fsMindMap: MindMapInstance | null = null

watch(fullscreen, (open) => {
  if (open) {
    nextTick(async () => {
      if (!smmCtor) {
        try {
          await loadSmm()
        } catch (e) {
          console.warn('[kgMindmap] simple-mind-map 加载失败:', e)
          return
        }
      }
      if (fullscreen.value && fsContainerRef.value && tree.value) {
        fsMindMap = buildMindMap(fsContainerRef.value)
      }
    })
  } else if (fsMindMap) {
    fsMindMap.destroy()
    fsMindMap = null
  }
})

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && fullscreen.value) fullscreen.value = false
}

onMounted(() => {
  nextTick(renderInline)
  window.addEventListener('keydown', onKeydown)
})

watch(() => props.node.attrs.data, () => nextTick(renderInline))

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  mindMap?.destroy()
  fsMindMap?.destroy()
  mindMap = null
  fsMindMap = null
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
      <button
        v-if="tree"
        class="kg-mindmap-fs-btn"
        type="button"
        @click.stop="fullscreen = true"
      >
        ⛶ 全屏查看
      </button>
    </div>

    <!-- 内联固定预览：pointer-events:none，纯展示不响应交互 -->
    <div v-if="tree && smmLoading" class="mm-empty">思维导图加载中…</div>
    <div v-if="tree" ref="containerRef" class="kg-mindmap-canvas" />
    <div v-else class="mm-empty">（思维导图数据为空）</div>

    <!-- 全屏层：Teleport 到 body，避开编辑器 overflow 裁剪；内部可缩放/拖拽/滚动 -->
    <Teleport to="body">
      <div v-if="fullscreen" class="mm-fullscreen" @click.self="fullscreen = false">
        <div class="mm-fs-bar">
          <span class="mm-fs-title">🗺 思维导图</span>
          <span class="mm-fs-hint">滚轮缩放 · 拖拽平移</span>
          <button class="mm-fs-close" type="button" @click="fullscreen = false">✕ 关闭</button>
        </div>
        <div ref="fsContainerRef" class="mm-fs-canvas" />
      </div>
    </Teleport>
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

.kg-mindmap-fs-btn {
  margin-left: auto;
  font-size: 12px;
  font-weight: 600;
  color: #2563eb;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.kg-mindmap-fs-btn:hover {
  background: #dbeafe;
  border-color: #93c5fd;
}

/* 内联画布：固定预览，pointer-events:none 不响应交互（外面固定，看细节走全屏） */
.kg-mindmap-canvas {
  width: 100%;
  height: 420px;
  background: #ffffff;
  border-radius: 8px;
  overflow: hidden;
  pointer-events: none;
}

.mm-empty {
  color: #94a3b8;
  font-size: 13px;
  font-style: italic;
}

/* ── 全屏层 ── */
.mm-fullscreen {
  position: fixed;
  inset: 0;
  z-index: 3000;
  background: rgba(255, 255, 255, 0.98);
  display: flex;
  flex-direction: column;
}

.mm-fs-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 20px;
  border-bottom: 1px solid #e2e8f0;
  flex-shrink: 0;
  background: #f8fafc;
}

.mm-fs-title {
  font-size: 15px;
  font-weight: 700;
  color: #1e293b;
}

.mm-fs-hint {
  font-size: 12px;
  color: #94a3b8;
}

.mm-fs-close {
  margin-left: auto;
  font-size: 13px;
  font-weight: 600;
  color: #475569;
  background: #fff;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 6px 14px;
  cursor: pointer;
}

.mm-fs-close:hover {
  background: #f1f5f9;
  border-color: #94a3b8;
}

/* 全屏画布：撑满剩余空间，可缩放拖拽 */
.mm-fs-canvas {
  flex: 1;
  min-height: 0;
  background: #ffffff;
  overflow: hidden;
}
</style>
