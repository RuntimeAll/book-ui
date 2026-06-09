<script setup lang="ts">
/**
 * 草稿纸（SketchPad）—— 覆盖式涂画工具（用户 2026-06-05 重新拍板）。
 *
 * 🔴 设计变更：从「弹窗里一块白板」改为「在当前页面上直接涂画」。
 *   点「草稿」→ 全屏透明画布盖在当前页之上（看得见底下题目），悬浮工具条随手画线、标注、打草稿；
 *   退出即清空（纯临时，不持久化）。这才是老师做题时随手演算/圈画的真实用法。
 *
 * 实现要点：
 *   - teleport 到 body，固定全视口透明 canvas（pointer-events 捕获绘制）；
 *   - 橡皮用 globalCompositeOperation='destination-out' 擦成透明（露出底页），非涂白；
 *   - DPR 缩放保证线条清晰；开启时按当前视口尺寸初始化，resize 时重置；
 *   - 退出（关闭 / Esc）清空画布。
 *
 * props.visible(v-model) 契约不变 —— 所有调用点（题库 / 详情 / 源卷）仍只 toggle visible。
 */
import { ref, watch, nextTick, onBeforeUnmount } from 'vue'
import { Delete, RefreshLeft, Close, EditPen } from '@element-plus/icons-vue'

const props = defineProps<{
  visible: boolean
}>()
const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
}>()

// ── 工具状态 ─────────────────────────────────────────────────
type Tool = 'pen' | 'eraser'
const activeTool = ref<Tool>('pen')
const activeColor = ref('#e63946')
const brushSize = ref(3)

const COLORS = [
  { label: '红', value: '#e63946' },
  { label: '黑', value: '#1d2129' },
  { label: '蓝', value: '#1d6fa4' },
  { label: '绿', value: '#2a9d5c' },
]
const BRUSH_SIZES: { label: string; value: number }[] = [
  { label: '细', value: 2 },
  { label: '中', value: 4 },
  { label: '粗', value: 8 },
]

// ── canvas 引用与绘图状态 ─────────────────────────────────────
const canvasRef = ref<HTMLCanvasElement | null>(null)
let ctx: CanvasRenderingContext2D | null = null
let dpr = 1
let drawing = false
let lastX = 0
let lastY = 0
// 🔴 当前正在作画的「那一个」指针（按 pointerId 跟踪）：
//   不再用 isPrimary 一刀切（会误杀电容笔——握笔时手掌先落屏抢成 primary，
//   笔反成 secondary 被丢）。改为单指针跟踪 + 笔优先抢占，既防手掌乱画又让笔能写。
let activePointerId: number | null = null
let activePointerType = ''
const hasStroke = ref(false) // 是否画过（控制「清空/撤销」可用 + 退出提示）

// 撤销快照栈（设备像素，整帧）
const snapshots: ImageData[] = []

// ── 初始化（按当前视口尺寸 + DPR）─────────────────────────────
function initCanvas() {
  const canvas = canvasRef.value
  if (!canvas) return
  dpr = window.devicePixelRatio || 1
  const vw = window.innerWidth
  const vh = window.innerHeight
  canvas.width = Math.round(vw * dpr)
  canvas.height = Math.round(vh * dpr)
  canvas.style.width = vw + 'px'
  canvas.style.height = vh + 'px'
  ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.scale(dpr, dpr) // 之后按 CSS 像素坐标绘制
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  snapshots.length = 0
  hasStroke.value = false
  drawing = false
  activePointerId = null
  activePointerType = ''
}

function clearCanvas() {
  if (!ctx || !canvasRef.value) return
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvasRef.value.width, canvasRef.value.height)
  ctx.restore()
  snapshots.length = 0
  hasStroke.value = false
}

// ── 坐标（固定全屏 canvas，clientX/Y 即视口坐标）──────────────
// PointerEvent 继承 MouseEvent，clientX/Y 通用 —— 鼠标 / 触摸 / 触控笔同一套坐标。
function getPos(e: PointerEvent): { x: number; y: number } {
  return { x: e.clientX, y: e.clientY }
}

function pushSnapshot() {
  if (!ctx || !canvasRef.value) return
  const data = ctx.getImageData(0, 0, canvasRef.value.width, canvasRef.value.height)
  snapshots.push(data)
  if (snapshots.length > 30) snapshots.shift() // 全屏帧较大，限 30 步防内存膨胀
}

function applyStrokeStyle() {
  if (!ctx) return
  ctx.lineWidth = currentLineWidth()
  if (activeTool.value === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out'
    ctx.strokeStyle = 'rgba(0,0,0,1)'
    ctx.fillStyle = 'rgba(0,0,0,1)'
  } else {
    ctx.globalCompositeOperation = 'source-over'
    ctx.strokeStyle = activeColor.value
    ctx.fillStyle = activeColor.value
  }
}

// 🔴 Pointer Events 统一鼠标 / 触摸 / 触控笔 —— 平板（手指/Apple Pencil）也能画。
//   旧实现只绑 mouse* 事件，触摸设备完全不触发 → 画笔在平板失效。
function onPointerDown(e: PointerEvent) {
  if (!ctx) return
  if (e.pointerType === 'mouse' && e.button !== 0) return // 鼠标仅左键；触摸/笔 button 恒 0

  // 已有笔画进行中 + 来了别的指针：
  if (activePointerId !== null && activePointerId !== e.pointerId) {
    // 笔优先（手掌抑制）：当前是「触摸（手掌）」那一笔、现在落下的是「笔」→ 让笔抢占接管。
    const penPreempts = e.pointerType === 'pen' && activePointerType !== 'pen'
    if (!penPreempts) {
      e.preventDefault() // 吞掉次要触点（手掌/多指），不漏穿到下层 FAB
      return
    }
    // 笔抢占：放掉旧（触摸）指针捕获，下面改由笔接管（手掌那一小段保留无妨）
    try {
      canvasRef.value?.releasePointerCapture(activePointerId)
    } catch {
      /* 忽略 */
    }
  }

  e.preventDefault() // 抑制触摸滚动 / 长按选中 / 合成鼠标事件
  // 指针捕获：手指/笔划出 canvas 边界也持续收 move/up，避免断笔
  try {
    canvasRef.value?.setPointerCapture(e.pointerId)
  } catch {
    /* 个别浏览器不支持时忽略，不影响主流程 */
  }
  activePointerId = e.pointerId
  activePointerType = e.pointerType
  pushSnapshot()
  drawing = true
  hasStroke.value = true
  const { x, y } = getPos(e)
  lastX = x
  lastY = y
  // 落点（圆点）
  applyStrokeStyle()
  ctx.beginPath()
  ctx.arc(x, y, currentLineWidth() / 2, 0, Math.PI * 2)
  ctx.fill()
}

function onPointerMove(e: PointerEvent) {
  if (!ctx) return
  // 作画中、来的是「非当前指针」（手掌/多指）的 move：也要吞掉。
  //   否则手掌拖动会被浏览器拿去发起「文本选中」→ 弹系统「拷贝/搜索/翻译」菜单。
  if (activePointerId !== null && e.pointerId !== activePointerId) {
    e.preventDefault()
    return
  }
  if (!drawing || e.pointerId !== activePointerId) return
  e.preventDefault()
  const { x, y } = getPos(e)
  applyStrokeStyle()
  ctx.beginPath()
  ctx.moveTo(lastX, lastY)
  ctx.lineTo(x, y)
  ctx.stroke()
  lastX = x
  lastY = y
}

function onPointerUp(e: PointerEvent) {
  if (e.pointerId !== activePointerId) return // 非当前作画指针抬起，忽略
  drawing = false
  activePointerId = null
  activePointerType = ''
  try {
    canvasRef.value?.releasePointerCapture(e.pointerId)
  } catch {
    /* 忽略 */
  }
}

function currentLineWidth(): number {
  return activeTool.value === 'eraser' ? brushSize.value * 5 : brushSize.value
}

// ── 撤销 / 清空 ──────────────────────────────────────────────
function handleUndo() {
  if (!ctx || snapshots.length === 0) return
  const data = snapshots.pop()!
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.putImageData(data, 0, 0)
  ctx.restore()
  if (snapshots.length === 0) hasStroke.value = false
}

function handleClear() {
  if (snapshots.length > 0 || hasStroke.value) pushSnapshot()
  if (!ctx || !canvasRef.value) return
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvasRef.value.width, canvasRef.value.height)
  ctx.restore()
  hasStroke.value = false
}

// ── 退出（清空 + 关闭）───────────────────────────────────────
function handleClose() {
  clearCanvas()
  emit('update:visible', false)
}

// ── resize：重置画布尺寸（清空，草稿是临时态可接受）──────────
function onResize() {
  if (!props.visible) return
  initCanvas()
}

// Esc 退出
function onKeydown(e: KeyboardEvent) {
  if (props.visible && e.key === 'Escape') handleClose()
}

// ── 监听 visible：打开初始化 + 挂全局监听，关闭卸载 ───────────
watch(
  () => props.visible,
  async (v) => {
    if (v) {
      await nextTick()
      initCanvas()
      // 🔴 草稿激活：禁掉全局 FAB 的可点性（防笔写时误触试卷篮/试题栏），见底部全局样式
      document.body.classList.add('sketch-active')
      window.addEventListener('resize', onResize)
      window.addEventListener('keydown', onKeydown)
    } else {
      document.body.classList.remove('sketch-active')
      window.removeEventListener('resize', onResize)
      window.removeEventListener('keydown', onKeydown)
    }
  },
)

onBeforeUnmount(() => {
  document.body.classList.remove('sketch-active')
  window.removeEventListener('resize', onResize)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <teleport to="body">
    <div v-if="visible" class="sketch-overlay">
      <!-- 透明全屏画布：盖在当前页之上直接涂画 -->
      <canvas
        ref="canvasRef"
        class="sketch-canvas"
        :style="{ cursor: activeTool === 'eraser' ? 'cell' : 'crosshair' }"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      />

      <!-- 悬浮工具条 -->
      <div class="sketch-toolbar" @pointerdown.stop @pointermove.stop>
        <div class="tb-title">
          <el-icon><EditPen /></el-icon>
          <span>草稿</span>
        </div>

        <span class="tb-divider" />

        <!-- 画笔 / 橡皮 -->
        <div class="tb-group">
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

        <span class="tb-divider" />

        <!-- 颜色 -->
        <div class="tb-group">
          <button
            v-for="c in COLORS"
            :key="c.value"
            class="color-dot"
            :class="{ active: activeColor === c.value && activeTool === 'pen' }"
            :style="{ background: c.value }"
            :title="c.label"
            @click="activeColor = c.value; activeTool = 'pen'"
          />
        </div>

        <span class="tb-divider" />

        <!-- 粗细 -->
        <div class="tb-group">
          <el-button
            v-for="s in BRUSH_SIZES"
            :key="s.value"
            size="small"
            :type="brushSize === s.value ? 'primary' : 'default'"
            @click="brushSize = s.value"
          >{{ s.label }}</el-button>
        </div>

        <span class="tb-divider" />

        <!-- 撤销 / 清空 -->
        <div class="tb-group">
          <el-button size="small" :icon="RefreshLeft" :disabled="snapshots.length === 0" @click="handleUndo">撤销</el-button>
          <el-button size="small" :icon="Delete" :disabled="!hasStroke" @click="handleClear">清空</el-button>
        </div>

        <span class="tb-divider" />

        <!-- 退出 -->
        <el-button size="small" type="danger" plain :icon="Close" @click="handleClose">退出草稿</el-button>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.sketch-overlay {
  position: fixed;
  inset: 0;
  z-index: 3000;
  pointer-events: none; /* 容器不挡，canvas/toolbar 各自开启捕获 */
}

.sketch-canvas {
  position: fixed;
  top: 0;
  left: 0;
  pointer-events: auto;
  touch-action: none;
  /* 透明背景：看得见底下页面内容 */
  background: transparent;
}

/* 悬浮工具条（顶部居中）*/
.sketch-toolbar {
  position: fixed;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 3001;
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: rgba(255, 255, 255, 0.97);
  border: 1px solid #ebeef5;
  border-radius: 12px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.16);
  flex-wrap: wrap;
  max-width: calc(100vw - 32px);
}

.tb-title {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  font-weight: 700;
  color: #1d2129;
}

.tb-group {
  display: flex;
  align-items: center;
  gap: 4px;
}

.tb-divider {
  width: 1px;
  height: 18px;
  background: #ebeef5;
}

.color-dot {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  padding: 0;
  transition: border-color 0.15s, transform 0.15s;
  outline: none;
}

.color-dot:hover {
  transform: scale(1.1);
}

.color-dot.active {
  /* DESIGN §3.2 青系选中态：teal-600 边 + 青光晕（替换 EP 默认蓝） */
  border-color: #1E8A8A;
  box-shadow: 0 0 0 2px rgba(30, 138, 138, 0.3);
}
</style>

<!-- 🔴 全局样式（非 scoped）：草稿激活时的两项防护。
     ① 禁掉全局悬浮按钮可点性：FAB(试卷篮/试题栏)是盖在透明 canvas 下的活按钮，
        平板用笔写字时手掌等次要触点会漏穿成对 FAB 的点击。pointer-events:none 让任何
        触点直接穿透，根除误触；FAB 仍正常显示(含角标)，仅草稿期间不可点。
     ② 整页禁止文本选中 + 关掉 iOS 长按气泡：笔/手掌拖动易选中底层题目文字，弹出系统
        「拷贝/搜索/翻译/大声朗读」菜单。user-select:none 断掉选中，-webkit-touch-callout:none
        压掉 iOS 选择气泡。退出草稿即恢复（文字照常可选可复制）。 -->
<style>
body.sketch-active .paper-basket-fab-badge,
body.sketch-active .basket-fab-badge {
  pointer-events: none !important;
}
body.sketch-active {
  -webkit-user-select: none !important;
  -moz-user-select: none !important;
  user-select: none !important;
  -webkit-touch-callout: none !important;
}
</style>
