<!--
  GeoBoard — 几何画板组件（三态：readonly 展示 / edit 拖调 / draw 从零画）
  引擎 = JSXGraph（@/utils/geoEngine）。构造逻辑见 useGeoBoard.ts（移植自 geometry-board/board-app.js）。

  用法：
    <GeoBoard :spec="dsl" mode="readonly" />                          题库配图展示
    <GeoBoard v-model:spec="dsl" mode="edit" />                       老师拖调 agent 出的图
    <GeoBoard v-model:spec="dsl" mode="draw" :axis="true" />          老师从零画（含工具栏 + 吸附）
  spec 支持低层 DSL（objects）或高层构件 DSL（build:[...]，自动展开）。
  expose：exportPNG() / exportSVG() / getSpec() / clear() / loadSpec()
-->
<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick, toRef } from 'vue'
import { ElMessageBox } from 'element-plus'
import type { GeoSpec } from '@/utils/geoEngine'
import { useGeoBoard, type GeoTool } from './useGeoBoard'

const props = withDefaults(defineProps<{
  spec?: GeoSpec | Record<string, unknown> | null
  mode?: 'readonly' | 'edit' | 'draw'
  axis?: boolean
  grid?: boolean
  snap?: boolean
  autoLabel?: boolean
  height?: number | string
  /** 是否显示工具栏（默认仅 draw 模式显示） */
  toolbar?: boolean
  /** 是否显示导出条（PNG/SVG/JSON，默认非 readonly 显示） */
  exportBar?: boolean
}>(), {
  spec: null,
  mode: 'readonly',
  axis: false,
  grid: false,
  snap: true,
  autoLabel: true,
  height: 360,
  toolbar: undefined,
  exportBar: undefined
})

const emit = defineEmits<{
  (e: 'update:spec', spec: GeoSpec): void
  (e: 'change', spec: GeoSpec): void
  (e: 'png', dataUrl: string): void
  (e: 'ready'): void
}>()

const boxRef = ref<HTMLElement | null>(null)
const showToolbar = computed(() => (props.toolbar !== undefined ? props.toolbar : props.mode === 'draw'))
const showExport = computed(() => (props.exportBar !== undefined ? props.exportBar : props.mode !== 'readonly'))
const boxStyle = computed(() => ({ height: typeof props.height === 'number' ? props.height + 'px' : props.height }))

// 画板选项（可被工具栏勾选覆盖 props 初值）
const cfg = reactive({ axis: props.axis, grid: props.grid, snap: props.snap, autoLabel: props.autoLabel })
watch(() => [props.axis, props.grid, props.snap, props.autoLabel], ([a, g, s, l]) => {
  cfg.axis = !!a; cfg.grid = !!g; cfg.snap = !!s; cfg.autoLabel = !!l
})

let lastEmitted = ''
const board = useGeoBoard(boxRef, {
  mode: toRef(props, 'mode') as any,
  axis: toRef(cfg, 'axis'),
  grid: toRef(cfg, 'grid'),
  snap: toRef(cfg, 'snap'),
  autoLabel: toRef(cfg, 'autoLabel'),
  onChange: (s) => { lastEmitted = JSON.stringify(s); emit('update:spec', s); emit('change', s) }
})

/* ---------- 工具栏定义 ---------- */
interface ToolDef { key: GeoTool; label: string }
const TOOL_GROUPS: Array<{ title: string; tools: ToolDef[] }> = [
  { title: '基础', tools: [
    { key: 'select', label: '选择' }, { key: 'point', label: '点' }, { key: 'text', label: '文本' }, { key: 'delete', label: '删除' }
  ] },
  { title: '线', tools: [
    { key: 'segment', label: '线段' }, { key: 'line', label: '直线' }, { key: 'ray', label: '射线' }, { key: 'vector', label: '向量' }, { key: 'polygon', label: '多边形' }
  ] },
  { title: '圆', tools: [
    { key: 'circle', label: '圆' }, { key: 'circumcircle', label: '三点圆' }
  ] },
  { title: '构造', tools: [
    { key: 'midpoint', label: '中点' }, { key: 'perpendicular', label: '垂线' }, { key: 'parallel', label: '平行线' }, { key: 'anglebisector', label: '角平分线' }
  ] },
  { title: '角', tools: [
    { key: 'angle', label: '标角' }, { key: 'rightangle', label: '直角' }
  ] }
]

function pick(t: GeoTool) { board.setTool(t) }

/* ---------- 导出 ---------- */
async function onExportPNG() {
  try {
    const url = await board.exportPNG(2)
    emit('png', url)
    const a = document.createElement('a'); a.href = url; a.download = 'figure.png'; a.click()
  } catch (e) { console.warn('[GeoBoard] exportPNG 失败:', e) }
}
function onExportSVG() {
  try {
    const svg = board.exportSVG()
    const blob = new Blob([svg], { type: 'image/svg+xml' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'figure.svg'; a.click()
  } catch (e) { console.warn('[GeoBoard] exportSVG 失败:', e) }
}
async function onCopyJSON() {
  const json = JSON.stringify(board.getSpec(), null, 1)
  try { await navigator.clipboard.writeText(json) } catch { /* noop */ }
}

/* ---------- 生命周期 / 同步 ---------- */
// text 工具用 Element Plus 弹窗替代原生 prompt
board.setPrompt(async (msg: string) => {
  try {
    const { value } = await ElMessageBox.prompt(msg, '输入文本', { confirmButtonText: '确定', cancelButtonText: '取消' })
    return value
  } catch { return null }
})

// 外部 spec 变化 → 重载（跳过自身 emit 造成的回环）
watch(() => props.spec, (s) => {
  if (JSON.stringify(s ?? { objects: [] }) === lastEmitted) return
  board.loadSpec((s ?? { objects: [] }) as GeoSpec)
})
// 模式 / 选项变化 → 重渲（readonly↔edit↔draw 切换要重建 board 才生效：藏点/红点/工具锁）
watch(() => props.mode, () => { if (props.mode !== 'draw') board.setTool('select'); void board.render() })
watch(() => [cfg.axis, cfg.grid, cfg.autoLabel], () => { void board.render() })

// 容器尺寸变化 → 重渲（autoPosition 重算）
let ro: ResizeObserver | null = null
let resizeTimer: ReturnType<typeof setTimeout> | null = null
onMounted(async () => {
  await nextTick()
  board.loadSpec((props.spec ?? { objects: [] }) as GeoSpec)
  emit('ready')
  if (typeof ResizeObserver !== 'undefined' && boxRef.value) {
    ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => void board.render(), 160)
    })
    ro.observe(boxRef.value)
  }
})
onBeforeUnmount(() => {
  if (ro) { ro.disconnect(); ro = null }
  if (resizeTimer) clearTimeout(resizeTimer)
  board.destroy()
})

defineExpose({
  exportPNG: (scale = 2) => board.exportPNG(scale),
  exportSVG: () => board.exportSVG(),
  getSpec: () => board.getSpec(),
  clear: () => board.clear(),
  loadSpec: (s: GeoSpec) => board.loadSpec(s),
  undo: () => board.undo()
})
</script>

<template>
  <div class="geo-board" :class="'mode-' + props.mode">
    <!-- 工具栏（draw 模式） -->
    <div v-if="showToolbar" class="gb-toolbar">
      <div v-for="grp in TOOL_GROUPS" :key="grp.title" class="gb-group">
        <span class="gb-group-title">{{ grp.title }}</span>
        <button
          v-for="t in grp.tools"
          :key="t.key"
          class="gb-tool"
          :class="{ active: board.tool.value === t.key, danger: t.key === 'delete' }"
          type="button"
          @click="pick(t.key)"
        >{{ t.label }}</button>
      </div>
      <div class="gb-group gb-opts">
        <label><input v-model="cfg.axis" type="checkbox" />坐标轴</label>
        <label><input v-model="cfg.grid" type="checkbox" />网格</label>
        <label><input v-model="cfg.snap" type="checkbox" />吸附</label>
        <label><input v-model="cfg.autoLabel" type="checkbox" />标签避让</label>
      </div>
      <div class="gb-group gb-actions">
        <button class="gb-tool" type="button" @click="board.undo()">撤销</button>
        <button class="gb-tool" type="button" @click="board.clear()">清空</button>
      </div>
    </div>

    <!-- 画板容器 -->
    <div ref="boxRef" class="gb-box jxgbox" :style="boxStyle"></div>

    <!-- 提示 + 导出条 -->
    <div v-if="showToolbar || showExport" class="gb-footer">
      <span class="gb-hint">{{ board.hint.value || board.status.value }}</span>
      <span class="gb-spacer" />
      <template v-if="showExport">
        <button class="gb-tool sm" type="button" @click="onExportPNG">导出 PNG</button>
        <button class="gb-tool sm" type="button" @click="onExportSVG">导出 SVG</button>
        <button class="gb-tool sm" type="button" @click="onCopyJSON">复制 JSON</button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.geo-board { border: 1px solid #e6e9ef; border-radius: 10px; background: #fff; overflow: hidden; display: flex; flex-direction: column; }
.gb-toolbar { display: flex; flex-wrap: wrap; gap: 10px 14px; padding: 8px 10px; border-bottom: 1px solid #eef0f4; background: #fafbfc; align-items: center; }
.gb-group { display: flex; align-items: center; gap: 4px; }
.gb-group-title { font-size: 11px; color: #9aa2b1; margin-right: 2px; }
.gb-tool {
  font-size: 12px; line-height: 1; padding: 6px 10px; border: 1px solid #d7dbe3; border-radius: 6px;
  background: #fff; color: #333; cursor: pointer; transition: all .12s;
}
.gb-tool:hover { border-color: #7c5cfa; color: #5b3fe0; }
.gb-tool.active { background: #5b3fe0; border-color: #5b3fe0; color: #fff; }
.gb-tool.danger.active { background: #e11; border-color: #e11; }
.gb-tool.sm { padding: 4px 8px; }
.gb-opts label { font-size: 12px; color: #555; display: inline-flex; align-items: center; gap: 3px; cursor: pointer; }
.gb-opts input { cursor: pointer; }
.gb-box { width: 100%; background: #fff; touch-action: none; }
.gb-footer { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-top: 1px solid #eef0f4; background: #fafbfc; }
.gb-hint { font-size: 12px; color: #8a93a6; }
.gb-spacer { flex: 1; }
.mode-readonly .gb-box { cursor: default; }
</style>
