<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { Delete, RefreshLeft } from '@element-plus/icons-vue'

// ── props / emits ────────────────────────────────────────────
const props = defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
}>()

// ── 工具状态 ─────────────────────────────────────────────────
type Tool = 'pen' | 'eraser'
const activeTool = ref<Tool>('pen')
const activeColor = ref('#000000')
const brushSize = ref(3)

const COLORS = [
  { label: '黑', value: '#000000' },
  { label: '红', value: '#e63946' },
  { label: '蓝', value: '#1d6fa4' },
  { label: '绿', value: '#2a9d5c' },
]
const BRUSH_SIZES: { label: string; value: number }[] = [
  { label: '细', value: 2 },
  { label: '中', value: 5 },
  { label: '粗', value: 10 },
]

// ── canvas 引用与绘图状态 ─────────────────────────────────────
const canvasRef = ref<HTMLCanvasElement | null>(null)
let ctx: CanvasRenderingContext2D | null = null
let drawing = false
let lastX = 0
let lastY = 0

// 撤销快照栈（每次 mousedown 前保存一帧）
const snapshots: ImageData[] = []

// ── 初始化 / 重置 ─────────────────────────────────────────────
function initCanvas() {
  const canvas = canvasRef.value
  if (!canvas) return
  ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  snapshots.length = 0
}

function resetCanvas() {
  if (!ctx || !canvasRef.value) return
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvasRef.value.width, canvasRef.value.height)
  snapshots.length = 0
}

// ── 监听 visible：打开时初始化，关闭时重置 ───────────────────
watch(
  () => props.visible,
  async (v) => {
    if (v) {
      await nextTick()
      initCanvas()
    } else {
      // 关闭后延迟重置，避免关闭动画期间有残影问题
      setTimeout(resetCanvas, 300)
    }
  }
)

// ── 坐标换算（相对 canvas 左上角） ──────────────────────────
function getPos(e: MouseEvent): { x: number; y: number } {
  const canvas = canvasRef.value!
  const rect = canvas.getBoundingClientRect()
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  }
}

// ── 保存快照到栈（用 getImageData，比 toDataURL 快） ─────────
function pushSnapshot() {
  if (!ctx || !canvasRef.value) return
  const data = ctx.getImageData(0, 0, canvasRef.value.width, canvasRef.value.height)
  snapshots.push(data)
  // 最多保留 50 步，防内存膨胀
  if (snapshots.length > 50) snapshots.shift()
}

// ── 鼠标事件 ─────────────────────────────────────────────────
function onMouseDown(e: MouseEvent) {
  if (!ctx) return
  pushSnapshot()
  drawing = true
  const { x, y } = getPos(e)
  lastX = x
  lastY = y
  // 单点点击（不移动）也能落点
  ctx.beginPath()
  ctx.arc(x, y, currentLineWidth() / 2, 0, Math.PI * 2)
  ctx.fillStyle = activeTool.value === 'eraser' ? '#ffffff' : activeColor.value
  ctx.fill()
}

function onMouseMove(e: MouseEvent) {
  if (!drawing || !ctx) return
  const { x, y } = getPos(e)

  ctx.beginPath()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = currentLineWidth()

  if (activeTool.value === 'eraser') {
    ctx.globalCompositeOperation = 'source-over'
    ctx.strokeStyle = '#ffffff'
  } else {
    ctx.globalCompositeOperation = 'source-over'
    ctx.strokeStyle = activeColor.value
  }

  ctx.moveTo(lastX, lastY)
  ctx.lineTo(x, y)
  ctx.stroke()

  lastX = x
  lastY = y
}

function onMouseUp() {
  drawing = false
}

function onMouseLeave() {
  drawing = false
}

function currentLineWidth(): number {
  return activeTool.value === 'eraser' ? brushSize.value * 4 : brushSize.value
}

// ── 撤销 ─────────────────────────────────────────────────────
function handleUndo() {
  if (!ctx || !canvasRef.value || snapshots.length === 0) return
  const data = snapshots.pop()!
  ctx.putImageData(data, 0, 0)
}

// ── 清空 ─────────────────────────────────────────────────────
function handleClear() {
  pushSnapshot()
  resetCanvas()
}

// ── 关闭弹窗 ─────────────────────────────────────────────────
function handleClose() {
  emit('update:visible', false)
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    title="草稿纸"
    width="900px"
    :close-on-click-modal="false"
    :append-to-body="true"
    @close="handleClose"
  >
    <!-- 工具栏 -->
    <div class="sketch-toolbar">
      <!-- 工具切换 -->
      <div class="toolbar-group">
        <el-button
          size="small"
          :type="activeTool === 'pen' ? 'primary' : 'default'"
          @click="activeTool = 'pen'"
        >画笔</el-button>
        <el-button
          size="small"
          :type="activeTool === 'eraser' ? 'primary' : 'default'"
          @click="activeTool = 'eraser'"
        >橡皮</el-button>
      </div>

      <!-- 粗细选择 -->
      <div class="toolbar-group">
        <span class="toolbar-label">粗细：</span>
        <el-button
          v-for="s in BRUSH_SIZES"
          :key="s.value"
          size="small"
          :type="brushSize === s.value ? 'primary' : 'default'"
          @click="brushSize = s.value"
        >{{ s.label }}</el-button>
      </div>

      <!-- 颜色选择 -->
      <div class="toolbar-group">
        <span class="toolbar-label">颜色：</span>
        <button
          v-for="c in COLORS"
          :key="c.value"
          class="color-btn"
          :class="{ active: activeColor === c.value && activeTool === 'pen' }"
          :style="{ background: c.value }"
          :title="c.label"
          @click="activeColor = c.value; activeTool = 'pen'"
        />
      </div>

      <div class="toolbar-spacer" />

      <!-- 撤销 / 清空 -->
      <div class="toolbar-group">
        <el-button size="small" :icon="RefreshLeft" :disabled="snapshots.length === 0" @click="handleUndo">
          撤销
        </el-button>
        <el-button size="small" :icon="Delete" @click="handleClear">清空</el-button>
      </div>
    </div>

    <!-- 画布 -->
    <div class="sketch-canvas-wrap">
      <canvas
        ref="canvasRef"
        width="820"
        height="480"
        class="sketch-canvas"
        :style="{ cursor: activeTool === 'eraser' ? 'cell' : 'crosshair' }"
        @mousedown="onMouseDown"
        @mousemove="onMouseMove"
        @mouseup="onMouseUp"
        @mouseleave="onMouseLeave"
      />
    </div>

    <template #footer>
      <el-button @click="handleClose">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.sketch-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 0 12px;
}

.toolbar-group {
  display: flex;
  align-items: center;
  gap: 4px;
}

.toolbar-label {
  font-size: 13px;
  color: #606266;
  white-space: nowrap;
}

.toolbar-spacer {
  flex: 1;
}

.color-btn {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  padding: 0;
  transition: border-color 0.15s;
  outline: none;
}

.color-btn.active {
  border-color: #409eff;
  box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.3);
}

.sketch-canvas-wrap {
  border: 1px solid #dcdfe6;
  border-radius: 6px;
  overflow: hidden;
  line-height: 0;
  background: #fff;
}

.sketch-canvas {
  display: block;
  width: 100%;
  height: auto;
  touch-action: none;
}
</style>
