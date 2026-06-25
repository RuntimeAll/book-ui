<script setup lang="ts">
// ---------------------------------------------------------------------------
// PRD-A-002 路A「框选录题全屏页」。
//
// 老师上传一张题/卷照片 → 在放大的图上拖框选区（可多框）→ 每框自动调识别接口得「去手写
// 富文本题(+可选解题/DNA)」→ 可就地改题 → 选绑定章节 →「录入」落 biz_question 草稿(status='0')。
//
// 流程：上传 → 读成 Image 画到承载 img（按自然分辨率）→ 拖框（显示坐标换算回自然分辨率）→
//   离屏 canvas 自然分辨率裁出 → toDataURL('image/png')（无损 PNG，禁压缩，R7）→
//   去 data: 前缀得 image_base64 喂识别；录入时再转 Blob 喂上传 → ingest/question。
// ---------------------------------------------------------------------------
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Back, Upload, ZoomIn, ZoomOut, Delete, MagicStick } from '@element-plus/icons-vue'
import MarkdownMath from '@/components/MarkdownMath.vue'
import { lazyTree, type SubjectNode } from '@/api/question/index'
import {
  recognize,
  uploadIngestImage,
  ingestQuestion,
  mapQtypeToCode,
  mapDifficultyToCode,
  type RecognizeResult,
  type IngestQuestionImage,
} from '@/api/ingest/index'

const router = useRouter()

// ── 框卡状态机 ───────────────────────────────────────────────────────────
type CardStatus = 'pending' | 'recognizing' | 'done' | 'failed'

interface RegionRect {
  // 自然分辨率坐标（裁剪/识别口径）
  x: number
  y: number
  w: number
  h: number
}

interface IngestCard {
  id: number
  rect: RegionRect
  /** 该框裁出的无损 PNG dataURL（data:image/png;base64,...） */
  dataUrl: string
  status: CardStatus
  error: string | null
  /** 默认勾选录入 */
  selected: boolean
  /** 是否已解题（带 answer/analysis/dna/verify） */
  solved: boolean
  recognizing: boolean
  // 识别 + 改题后的可编辑字段
  stem: string
  qtype: string
  options: string[]
  answer: string
  analysis: string
  solvedAnswer: string
  dnaDifficulty: number | null
  verifyVerdict: string | null
  verifyDetail: string | null
  examType: string | null
  mainKp: string | null
  tags: string[]
  // 改题编辑态
  editing: boolean
  draftStem: string
  draftAnswer: string
  draftAnalysis: string
  // 录入态
  ingesting: boolean
  ingested: boolean
}

let cardSeq = 0

// ── 图像承载 ─────────────────────────────────────────────────────────────
const fileInputRef = ref<HTMLInputElement>()
const imgEl = ref<HTMLImageElement>()
const stageRef = ref<HTMLDivElement>()
const imageSrc = ref<string>('') // 原图 dataURL
const naturalW = ref(0)
const naturalH = ref(0)
const scale = ref(1) // 显示缩放（transform）
const cards = ref<IngestCard[]>([])

const hasImage = computed(() => !!imageSrc.value)

// 解题开关（影响每框识别是否带 solve）
const solveOnRecognize = ref(false)
// 学段提示（可选，传给识别接口）
const gradeHint = ref('')

// ── 上传/读图 ────────────────────────────────────────────────────────────
function triggerUpload() {
  fileInputRef.value?.click()
}

function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) loadImageFile(file)
  // 允许重选同一文件
  input.value = ''
}

function loadImageFile(file: File) {
  if (!/^image\//.test(file.type)) {
    ElMessage.warning('请上传图片文件')
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    const url = String(reader.result || '')
    const img = new Image()
    img.onload = () => {
      naturalW.value = img.naturalWidth
      naturalH.value = img.naturalHeight
      imageSrc.value = url
      cards.value = []
      // 初始缩放：让图宽度大致铺满舞台（最大 1，避免小图放大失真）
      fitScale()
    }
    img.onerror = () => ElMessage.error('图片加载失败')
    img.src = url
  }
  reader.onerror = () => ElMessage.error('图片读取失败')
  reader.readAsDataURL(file)
}

function fitScale() {
  const stage = stageRef.value
  if (!stage || !naturalW.value) return
  const avail = stage.clientWidth - 32
  if (avail <= 0) return
  scale.value = Math.min(1, avail / naturalW.value)
}

// 粘贴上传（可选增强）
function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items
  if (!items) return
  for (const it of items) {
    if (it.type.startsWith('image/')) {
      const f = it.getAsFile()
      if (f) {
        loadImageFile(f)
        e.preventDefault()
        return
      }
    }
  }
}

function zoomIn() {
  scale.value = Math.min(3, +(scale.value + 0.15).toFixed(2))
}
function zoomOut() {
  scale.value = Math.max(0.2, +(scale.value - 0.15).toFixed(2))
}

// ── 拖框选区 ─────────────────────────────────────────────────────────────
const drawing = ref(false)
const drawRect = reactive({ x: 0, y: 0, w: 0, h: 0 }) // 显示坐标（相对承载图左上）
let startX = 0
let startY = 0

// 把鼠标事件坐标换算到「图显示坐标系」（相对 imgEl 左上，未除 scale）
function toDisplayCoord(e: MouseEvent): { x: number; y: number } | null {
  const img = imgEl.value
  if (!img) return null
  const r = img.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top }
}

function onStageMouseDown(e: MouseEvent) {
  if (!hasImage.value) return
  const p = toDisplayCoord(e)
  if (!p) return
  drawing.value = true
  startX = p.x
  startY = p.y
  drawRect.x = p.x
  drawRect.y = p.y
  drawRect.w = 0
  drawRect.h = 0
}

function onStageMouseMove(e: MouseEvent) {
  if (!drawing.value) return
  const p = toDisplayCoord(e)
  if (!p) return
  drawRect.x = Math.min(startX, p.x)
  drawRect.y = Math.min(startY, p.y)
  drawRect.w = Math.abs(p.x - startX)
  drawRect.h = Math.abs(p.y - startY)
}

function onStageMouseUp() {
  if (!drawing.value) return
  drawing.value = false
  // 太小的框忽略（误点）
  if (drawRect.w < 12 || drawRect.h < 12) return
  commitRegion()
}

// 把显示坐标的框换算回自然分辨率并裁剪、生成卡
function commitRegion() {
  const s = scale.value || 1
  // 显示坐标 → 自然分辨率坐标（显示坐标已含 scale，除回去）
  let nx = drawRect.x / s
  let ny = drawRect.y / s
  let nw = drawRect.w / s
  let nh = drawRect.h / s
  // 夹取到图边界内
  nx = Math.max(0, Math.min(nx, naturalW.value))
  ny = Math.max(0, Math.min(ny, naturalH.value))
  nw = Math.min(nw, naturalW.value - nx)
  nh = Math.min(nh, naturalH.value - ny)
  if (nw < 8 || nh < 8) return

  const rect: RegionRect = {
    x: Math.round(nx),
    y: Math.round(ny),
    w: Math.round(nw),
    h: Math.round(nh),
  }
  const dataUrl = cropRegion(rect)
  if (!dataUrl) {
    ElMessage.error('裁剪失败')
    return
  }
  const card = createCard(rect, dataUrl)
  cards.value.push(card)
  void recognizeCard(card)
}

// 离屏 canvas 在自然分辨率裁出区域 → 无损 PNG dataURL（禁压缩，R7）
function cropRegion(rect: RegionRect): string | null {
  const img = imgEl.value
  if (!img) return null
  const canvas = document.createElement('canvas')
  canvas.width = rect.w
  canvas.height = rect.h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  // img 元素天然按自然分辨率绘制（drawImage 用自然像素坐标，不受 CSS 缩放影响）
  ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)
  // 🔴 无损 PNG，禁传质量参数压缩
  return canvas.toDataURL('image/png')
}

function createCard(rect: RegionRect, dataUrl: string): IngestCard {
  // 🔴 必须 reactive 包裹：cards 是 ref<IngestCard[]>，push 普通对象后异步回调持有的是原始引用，
  // 在其上改 status/stem 不触发渲染（首帧"识别中"只因 push 触发数组重渲染+同步预设）。
  // 包成 reactive 后对象本身即代理，识别/解题/改题/录入各异步突变均生效。
  return reactive({
    id: ++cardSeq,
    rect,
    dataUrl,
    status: 'pending',
    error: null,
    selected: true,
    solved: false,
    recognizing: false,
    stem: '',
    qtype: '',
    options: [],
    answer: '',
    analysis: '',
    solvedAnswer: '',
    dnaDifficulty: null,
    verifyVerdict: null,
    verifyDetail: null,
    examType: null,
    mainKp: null,
    tags: [],
    editing: false,
    draftStem: '',
    draftAnswer: '',
    draftAnalysis: '',
    ingesting: false,
    ingested: false,
  })
}

// ── 识别 ─────────────────────────────────────────────────────────────────
function stripDataPrefix(dataUrl: string): string {
  const idx = dataUrl.indexOf(',')
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl
}

async function recognizeCard(card: IngestCard, solve = solveOnRecognize.value) {
  card.status = 'recognizing'
  card.recognizing = true
  card.error = null
  try {
    const result: RecognizeResult = await recognize({
      image_base64: stripDataPrefix(card.dataUrl),
      solve,
      ...(gradeHint.value.trim() ? { grade_hint: gradeHint.value.trim() } : {}),
    })
    if (!result.ok || result.error) {
      card.status = 'failed'
      card.error = result.error || '识别失败'
      return
    }
    applyRecognizeResult(card, result, solve)
    card.status = 'done'
  } catch (e) {
    card.status = 'failed'
    card.error = e instanceof Error ? e.message : '识别失败'
  } finally {
    card.recognizing = false
  }
}

function applyRecognizeResult(card: IngestCard, r: RecognizeResult, solved: boolean) {
  card.stem = r.stem || ''
  card.qtype = r.qtype || ''
  card.options = Array.isArray(r.options) ? r.options : []
  if (solved) {
    card.solved = true
    card.answer = r.answer || ''
    card.analysis = r.analysis || ''
    card.solvedAnswer = r.solved_answer || ''
    card.dnaDifficulty = r.dna?.difficulty ?? null
    card.examType = r.dna?.exam_type ?? null
    card.mainKp = r.dna?.main_kp?.name ?? null
    card.tags = r.dna?.tags ?? []
    card.verifyVerdict = r.verify?.verdict ?? null
    card.verifyDetail = r.verify?.detail ?? null
  }
}

// 解题（重调识别带 solve=true）
function solveCard(card: IngestCard) {
  if (card.recognizing || card.ingesting) return
  void recognizeCard(card, true)
}

function retryCard(card: IngestCard) {
  if (card.recognizing) return
  void recognizeCard(card)
}

function removeCard(card: IngestCard) {
  const i = cards.value.findIndex((c) => c.id === card.id)
  if (i >= 0) cards.value.splice(i, 1)
}

// ── 改题 ─────────────────────────────────────────────────────────────────
function startEdit(card: IngestCard) {
  card.draftStem = card.stem
  card.draftAnswer = card.answer
  card.draftAnalysis = card.analysis
  card.editing = true
}

function saveEdit(card: IngestCard) {
  card.stem = card.draftStem
  card.answer = card.draftAnswer
  card.analysis = card.draftAnalysis
  card.editing = false
}

function cancelEdit(card: IngestCard) {
  card.editing = false
}

// ── 章节绑定（el-tree-select，懒加载） ─────────────────────────────────────
const chapterTreeData = ref<SubjectNode[]>([])
const chapterTreeLoading = ref(false)
const selectedSubjectId = ref<string>('')

async function loadChapterTree() {
  chapterTreeLoading.value = true
  try {
    const result = await lazyTree(0, true)
    if (Array.isArray(result)) chapterTreeData.value = result
    else if (result && typeof result === 'object') chapterTreeData.value = [result as unknown as SubjectNode]
  } catch (e) {
    console.warn('[ingest][tree] lazyTree failed', e)
  } finally {
    chapterTreeLoading.value = false
  }
}

// ── 录入 ─────────────────────────────────────────────────────────────────
const ingestingAll = ref(false)

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64] = dataUrl.split(',')
  const mime = /:(.*?);/.exec(head)?.[1] || 'image/png'
  const bin = atob(b64)
  const len = bin.length
  const arr = new Uint8Array(len)
  for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i)
  return new Blob([arr], { type: mime })
}

const ingestableCards = computed(() =>
  cards.value.filter((c) => c.status === 'done' && c.selected && !c.ingested),
)

async function ingestOne(card: IngestCard): Promise<boolean> {
  card.ingesting = true
  try {
    // ② 上传配图（无损 PNG Blob）
    const blob = dataUrlToBlob(card.dataUrl)
    const up = await uploadIngestImage(blob)
    const images: IngestQuestionImage[] = [
      { assetId: up.assetId, ossUrl: up.ossUrl, role: 'figure', seq: 0, isDecorative: 0 },
    ]
    // ③ 录入草稿
    await ingestQuestion({
      status: '0',
      subjectId: selectedSubjectId.value,
      questionType: mapQtypeToCode(card.qtype),
      difficult: mapDifficultyToCode(card.dnaDifficulty),
      stemText: card.stem,
      ...(card.answer ? { answerText: card.answer } : {}),
      ...(card.analysis ? { analyzeText: card.analysis } : {}),
      images,
      importSource: 'ingest-frame',
    })
    card.ingested = true
    return true
  } catch (e) {
    console.warn('[ingest] one failed', e)
    return false
  } finally {
    card.ingesting = false
  }
}

async function ingestAll() {
  if (ingestingAll.value) return
  if (!selectedSubjectId.value) {
    ElMessage.warning('请先选择绑定章节')
    return
  }
  const targets = ingestableCards.value.slice()
  if (targets.length === 0) {
    ElMessage.warning('没有可录入的题（需已识别成功且勾选）')
    return
  }
  ingestingAll.value = true
  let okCount = 0
  try {
    // 逐卡录入（有进度，禁重复点）
    for (const card of targets) {
      const ok = await ingestOne(card)
      if (ok) okCount++
    }
  } finally {
    ingestingAll.value = false
  }
  if (okCount === targets.length) {
    ElMessage.success(`已录入 ${okCount} 道题到草稿`)
  } else if (okCount > 0) {
    ElMessage.warning(`录入完成 ${okCount}/${targets.length} 道（部分失败）`)
  } else {
    ElMessage.error('录入失败，请重试')
  }
}

function goBack() {
  router.push('/my-question')
}

function goMyQuestion() {
  router.push('/my-question')
}

// ── 框预览（显示坐标，叠在图上） ───────────────────────────────────────────
function cardDisplayStyle(card: IngestCard) {
  const s = scale.value || 1
  return {
    left: `${card.rect.x * s}px`,
    top: `${card.rect.y * s}px`,
    width: `${card.rect.w * s}px`,
    height: `${card.rect.h * s}px`,
  }
}

// 难度文本
function difficultyText(d: number | null): string {
  if (d == null) return ''
  return `${d}星`
}

// verify 徽章类型
function verifyTagType(v: string | null): 'success' | 'danger' | 'info' {
  if (v === 'pass') return 'success'
  if (v === 'fail') return 'danger'
  return 'info'
}

function verifyText(v: string | null): string {
  if (v === 'pass') return '验算通过'
  if (v === 'fail') return '验算不通过'
  if (v === 'degrade') return '验算降级'
  return v || ''
}

onMounted(() => {
  loadChapterTree()
  window.addEventListener('resize', fitScale)
  window.addEventListener('paste', onPaste)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', fitScale)
  window.removeEventListener('paste', onPaste)
})
</script>

<template>
  <div class="ingest-frame">
    <!-- ══ 顶栏 ══ -->
    <header class="topbar">
      <div class="topbar-left">
        <el-button text :icon="Back" @click="goBack">返回</el-button>
        <span class="topbar-title">框选录题</span>
      </div>
      <div class="topbar-right">
        <span class="bind-label">绑定章节</span>
        <el-tree-select
          v-model="selectedSubjectId"
          :data="chapterTreeData"
          :props="{ label: 'title', children: 'children' }"
          node-key="id"
          placeholder="请选择章节（必选）"
          check-strictly
          :render-after-expand="false"
          class="chapter-select"
          :loading="chapterTreeLoading"
        />
        <el-button
          type="primary"
          :loading="ingestingAll"
          :disabled="ingestableCards.length === 0 || !selectedSubjectId"
          @click="ingestAll"
        >
          全部录入{{ ingestableCards.length ? `（${ingestableCards.length}）` : '' }}
        </el-button>
      </div>
    </header>

    <div class="body">
      <!-- ══ 左：图像 + 框选舞台 ══ -->
      <section class="stage-pane">
        <!-- 空态 -->
        <div v-if="!hasImage" class="empty-stage" @click="triggerUpload">
          <el-icon class="empty-icon"><Upload /></el-icon>
          <p class="empty-title">点击上传题/卷照片</p>
          <p class="empty-hint">支持点击选择或直接粘贴（Ctrl+V）图片；上传后在图上拖框选区</p>
        </div>

        <!-- 有图：工具条 + 舞台 -->
        <template v-else>
          <div class="stage-toolbar">
            <el-button text :icon="Upload" @click="triggerUpload">重新上传</el-button>
            <el-divider direction="vertical" />
            <el-button text :icon="ZoomOut" @click="zoomOut" />
            <span class="zoom-val">{{ Math.round(scale * 100) }}%</span>
            <el-button text :icon="ZoomIn" @click="zoomIn" />
            <el-divider direction="vertical" />
            <el-checkbox v-model="solveOnRecognize">识别时同时解题（较慢）</el-checkbox>
            <el-input v-model="gradeHint" placeholder="学段提示（可选，如 七年级）" size="small" class="grade-input" />
            <span class="stage-tip">在图上按住鼠标拖动画框，每框自动识别</span>
          </div>

          <div ref="stageRef" class="stage-scroll">
            <div
              class="stage-canvas"
              :style="{ width: `${naturalW * scale}px`, height: `${naturalH * scale}px` }"
              @mousedown="onStageMouseDown"
              @mousemove="onStageMouseMove"
              @mouseup="onStageMouseUp"
              @mouseleave="onStageMouseUp"
            >
              <img
                ref="imgEl"
                :src="imageSrc"
                class="stage-img"
                :style="{ width: `${naturalW * scale}px`, height: `${naturalH * scale}px` }"
                draggable="false"
                alt="待框选题图"
              />
              <!-- 已提交的框 -->
              <div
                v-for="(card, idx) in cards"
                :key="card.id"
                class="region-box"
                :class="{ 'is-failed': card.status === 'failed', 'is-done': card.status === 'done' }"
                :style="cardDisplayStyle(card)"
              >
                <span class="region-no">{{ idx + 1 }}</span>
              </div>
              <!-- 正在画的框 -->
              <div
                v-if="drawing"
                class="region-box drawing"
                :style="{ left: `${drawRect.x}px`, top: `${drawRect.y}px`, width: `${drawRect.w}px`, height: `${drawRect.h}px` }"
              />
            </div>
          </div>
        </template>

        <input
          ref="fileInputRef"
          type="file"
          accept="image/*"
          style="display: none"
          @change="onFileChange"
        />
      </section>

      <!-- ══ 右：题卡列表 ══ -->
      <aside class="cards-pane">
        <div class="cards-header">
          <span class="cards-title">题卡</span>
          <el-tag v-if="cards.length" type="info" size="small" round>{{ cards.length }} 框</el-tag>
        </div>

        <el-empty
          v-if="cards.length === 0"
          description="还没有框选。上传图片后在左侧拖框，每框生成一张题卡"
          :image-size="80"
        />

        <div v-else class="cards-list">
          <div
            v-for="(card, idx) in cards"
            :key="card.id"
            class="ingest-card"
            :class="{ 'card-ingested': card.ingested }"
          >
            <!-- 卡头 -->
            <div class="card-top">
              <el-checkbox
                v-model="card.selected"
                :disabled="card.status !== 'done' || card.ingested"
              />
              <span class="card-no">第 {{ idx + 1 }} 框</span>
              <el-tag v-if="card.ingested" type="success" size="small">已录入</el-tag>
              <div class="card-top-spacer" />
              <el-button text :icon="Delete" size="small" :disabled="card.ingesting" @click="removeCard(card)" />
            </div>

            <!-- 缩略图 -->
            <div class="card-thumb">
              <img :src="card.dataUrl" alt="框选区域" />
            </div>

            <!-- 识别中 -->
            <div v-if="card.status === 'recognizing'" class="card-loading">
              <el-icon class="is-loading"><MagicStick /></el-icon>
              <span>识别中…{{ solveOnRecognize ? '（含解题，约 30 秒）' : '（约 12 秒）' }}</span>
            </div>

            <!-- 待识别（理论上瞬间转走，兜底） -->
            <div v-else-if="card.status === 'pending'" class="card-loading">
              <span>待识别…</span>
            </div>

            <!-- 识别失败 -->
            <div v-else-if="card.status === 'failed'" class="card-failed">
              <p class="fail-msg">识别失败：{{ card.error }}</p>
              <div class="fail-actions">
                <el-button size="small" @click="retryCard(card)">重新识别</el-button>
                <el-button size="small" @click="removeCard(card)">删除此框</el-button>
              </div>
            </div>

            <!-- 已识别 -->
            <div v-else class="card-body">
              <!-- 改题编辑态 -->
              <template v-if="card.editing">
                <div class="edit-field">
                  <label class="edit-label">题干</label>
                  <el-input v-model="card.draftStem" type="textarea" :rows="4" />
                  <div class="edit-preview"><MarkdownMath :content="card.draftStem || ' '" /></div>
                </div>
                <div v-if="card.solved" class="edit-field">
                  <label class="edit-label">答案</label>
                  <el-input v-model="card.draftAnswer" type="textarea" :rows="2" />
                  <div class="edit-preview"><MarkdownMath :content="card.draftAnswer || ' '" /></div>
                </div>
                <div v-if="card.solved" class="edit-field">
                  <label class="edit-label">解析</label>
                  <el-input v-model="card.draftAnalysis" type="textarea" :rows="3" />
                  <div class="edit-preview"><MarkdownMath :content="card.draftAnalysis || ' '" /></div>
                </div>
                <div class="edit-actions">
                  <el-button type="primary" size="small" @click="saveEdit(card)">保存</el-button>
                  <el-button size="small" @click="cancelEdit(card)">取消</el-button>
                </div>
              </template>

              <!-- 展示态 -->
              <template v-else>
                <div class="meta-row">
                  <el-tag v-if="card.qtype" size="small" type="info">{{ card.qtype }}</el-tag>
                  <el-tag v-if="difficultyText(card.dnaDifficulty)" size="small" type="warning">
                    {{ difficultyText(card.dnaDifficulty) }}
                  </el-tag>
                  <el-tag v-if="card.examType" size="small">{{ card.examType }}</el-tag>
                  <el-tag
                    v-if="card.verifyVerdict"
                    size="small"
                    :type="verifyTagType(card.verifyVerdict)"
                  >
                    {{ verifyText(card.verifyVerdict) }}
                  </el-tag>
                </div>

                <div class="stem-render">
                  <MarkdownMath :content="card.stem || '（题干为空）'" />
                </div>

                <ul v-if="card.options.length" class="opt-list">
                  <li v-for="(opt, oi) in card.options" :key="oi">
                    <MarkdownMath :content="opt" />
                  </li>
                </ul>

                <div v-if="card.mainKp" class="kp-row">考点：{{ card.mainKp }}</div>
                <div v-if="card.tags.length" class="tag-row">
                  <el-tag v-for="(t, ti) in card.tags" :key="ti" size="small" type="info" effect="plain">
                    {{ t }}
                  </el-tag>
                </div>

                <!-- 解题结果 -->
                <div v-if="card.solved && (card.answer || card.analysis)" class="solve-block">
                  <p v-if="card.answer" class="solve-label">答案</p>
                  <MarkdownMath v-if="card.answer" :content="card.answer" />
                  <p v-if="card.analysis" class="solve-label">解析</p>
                  <MarkdownMath v-if="card.analysis" :content="card.analysis" />
                  <div v-if="card.verifyDetail" class="verify-detail">{{ card.verifyDetail }}</div>
                </div>

                <!-- 卡操作 -->
                <div class="card-actions">
                  <el-button
                    v-if="!card.solved"
                    size="small"
                    :loading="card.recognizing"
                    :disabled="card.ingesting"
                    @click="solveCard(card)"
                  >
                    解题
                  </el-button>
                  <el-button size="small" :disabled="card.ingesting" @click="startEdit(card)">改题</el-button>
                  <el-button
                    size="small"
                    type="primary"
                    :loading="card.ingesting"
                    :disabled="card.ingested || !selectedSubjectId"
                    @click="ingestOne(card)"
                  >
                    {{ card.ingested ? '已录入' : '录入' }}
                  </el-button>
                </div>
              </template>
            </div>
          </div>
        </div>

        <div v-if="cards.some((c) => c.ingested)" class="cards-footer">
          <el-button text type="primary" @click="goMyQuestion">前往我的题库查看 →</el-button>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.ingest-frame {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  background: #f0f2f5;
}

/* 顶栏 */
.topbar {
  flex-shrink: 0;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  background: #fff;
  border-bottom: 1px solid #e5e6eb;
}
.topbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
.topbar-title {
  font-size: 16px;
  font-weight: 600;
  color: #1d2129;
}
.topbar-right {
  display: flex;
  align-items: center;
  gap: 12px;
}
.bind-label {
  font-size: 13px;
  color: #4e5969;
}
.chapter-select {
  width: 280px;
}

/* 主体 */
.body {
  flex: 1;
  display: flex;
  min-height: 0;
}

/* 左舞台 */
.stage-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-right: 1px solid #e5e6eb;
}
.empty-stage {
  flex: 1;
  margin: 24px;
  border: 2px dashed #c9cdd4;
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  cursor: pointer;
  background: #fff;
  transition: border-color 0.2s;
}
.empty-stage:hover {
  border-color: #1e8a8a;
}
.empty-icon {
  font-size: 48px;
  color: #1e8a8a;
}
.empty-title {
  font-size: 16px;
  font-weight: 600;
  color: #1d2129;
}
.empty-hint {
  font-size: 13px;
  color: #86909c;
}

.stage-toolbar {
  flex-shrink: 0;
  height: 48px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  background: #fff;
  border-bottom: 1px solid #e5e6eb;
}
.zoom-val {
  font-size: 13px;
  color: #4e5969;
  min-width: 42px;
  text-align: center;
}
.grade-input {
  width: 180px;
}
.stage-tip {
  font-size: 12px;
  color: #86909c;
  margin-left: auto;
}

.stage-scroll {
  flex: 1;
  overflow: auto;
  padding: 16px;
}
.stage-canvas {
  position: relative;
  user-select: none;
  cursor: crosshair;
}
.stage-img {
  display: block;
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
}

/* 框 */
.region-box {
  position: absolute;
  border: 2px solid #1e8a8a;
  background: rgba(30, 138, 138, 0.08);
  box-sizing: border-box;
  pointer-events: none;
}
.region-box.is-failed {
  border-color: #f53f3f;
  background: rgba(245, 63, 63, 0.08);
}
.region-box.drawing {
  border-style: dashed;
}
.region-no {
  position: absolute;
  left: 0;
  top: 0;
  background: #1e8a8a;
  color: #fff;
  font-size: 12px;
  line-height: 18px;
  min-width: 18px;
  text-align: center;
  padding: 0 4px;
}

/* 右题卡列 */
.cards-pane {
  width: 440px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: #fff;
}
.cards-header {
  flex-shrink: 0;
  height: 48px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  border-bottom: 1px solid #e5e6eb;
}
.cards-title {
  font-size: 14px;
  font-weight: 600;
  color: #1d2129;
}
.cards-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ingest-card {
  border: 1px solid #e5e6eb;
  border-radius: 10px;
  padding: 10px 12px;
  background: #fff;
}
.card-ingested {
  background: #f6ffed;
  border-color: #b7eb8f;
}
.card-top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.card-no {
  font-size: 13px;
  font-weight: 600;
  color: #1d2129;
}
.card-top-spacer {
  flex: 1;
}
.card-thumb {
  margin: 8px 0;
  border: 1px solid #f0f0f0;
  border-radius: 6px;
  overflow: hidden;
  max-height: 160px;
  display: flex;
  justify-content: center;
  background: #fafafa;
}
.card-thumb img {
  max-width: 100%;
  max-height: 160px;
  object-fit: contain;
}

.card-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 0;
  color: #86909c;
  font-size: 13px;
}
.card-failed {
  padding: 8px 0;
}
.fail-msg {
  color: #f53f3f;
  font-size: 13px;
  margin-bottom: 8px;
}
.fail-actions {
  display: flex;
  gap: 8px;
}

.card-body {
  margin-top: 4px;
}
.meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.stem-render {
  font-size: 14px;
  color: #1d2129;
}
.opt-list {
  list-style: none;
  padding: 0;
  margin: 6px 0 0;
}
.opt-list li {
  margin: 2px 0;
}
.kp-row {
  margin-top: 8px;
  font-size: 12px;
  color: #4e5969;
}
.tag-row {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.solve-block {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed #e5e6eb;
}
.solve-label {
  font-size: 12px;
  font-weight: 600;
  color: #4080ff;
  margin: 6px 0 2px;
}
.verify-detail {
  margin-top: 6px;
  font-size: 12px;
  color: #86909c;
  background: #f7f8fa;
  border-radius: 4px;
  padding: 6px 8px;
}

.card-actions {
  margin-top: 10px;
  display: flex;
  gap: 8px;
}

.edit-field {
  margin-bottom: 10px;
}
.edit-label {
  display: block;
  font-size: 12px;
  color: #4e5969;
  margin-bottom: 4px;
}
.edit-preview {
  margin-top: 6px;
  padding: 6px 8px;
  background: #f7f8fa;
  border-radius: 4px;
  font-size: 13px;
}
.edit-actions {
  display: flex;
  gap: 8px;
}

.cards-footer {
  flex-shrink: 0;
  padding: 10px 16px;
  border-top: 1px solid #e5e6eb;
  text-align: center;
}
</style>
