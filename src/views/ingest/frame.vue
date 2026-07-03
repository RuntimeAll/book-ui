<script setup lang="ts">
// ---------------------------------------------------------------------------
// PRD-A-002 路A「框选录题全屏页」（bug 轮 B3/B4/B6 + 流式重构）。
//
// 🔴 维护者拍板（2026-06-26 二轮）：解题/批改要**像举一反三第一阶段一样实时流式**——
//   按钮直调封装好的预设 prompt，但 LLM 逐字流式（老师**实时看到怎么解 / 怎么改**），不黑盒等待。
//   打标(DNA) 是**异步额外**的事，跟在解题后面（解出来就异步打标），不阻塞老师的其他操作。
//   解题过程 / 批改 / 打标都能**折叠收起**。
//
// 流程：上传(点击/拖拽/粘贴) → 拖框选区（可多框）→ 框完裁剪暂存到右侧题卡 →
//   每张题卡 4 功能：
//     · 解题 = 识别+解题一起做（流式输出识别题干+解题过程+答案），完成后异步打标(DNA)。
//     · 批改 = 识别+先解题+判学生作答对错（流式输出批改过程）。本页**所有题都可批改**。
//     · 编辑 = 改题面/答案文本（非 LLM）。
//     · 录题 = 落 biz_question 草稿(status='0')。
//   绑定章节（录题必选，从顶栏选）→ 录题/全部录入。
// ---------------------------------------------------------------------------
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Back, Upload, ZoomIn, ZoomOut, Delete, MagicStick, EditPen, DocumentChecked, ArrowDown, ArrowRight } from '@element-plus/icons-vue'
import MarkdownMath from '@/components/MarkdownMath.vue'
import { lazyTree, type SubjectNode } from '@/api/question/index'
import {
  solveStream,
  gradeStream,
  labelQuestion,
  uploadIngestImage,
  ingestQuestion,
  mapQtypeToCode,
  mapDifficultyToCode,
  type SolveStreamResult,
  type GradeStreamResult,
  type IngestQuestionImage,
} from '@/api/ingest/index'

const router = useRouter()

type CardStatus = 'idle' | 'done' | 'failed'

interface RegionRect {
  x: number
  y: number
  w: number
  h: number
}

interface IngestCard {
  id: number
  rect: RegionRect
  dataUrl: string
  status: CardStatus
  error: string | null
  selected: boolean
  // ── 流式态 ──
  /** 当前在跑的流：solve / grade / '' */
  streamKind: 'solve' | 'grade' | ''
  /** 流式累计的人类可读文本（解题过程 / 批改过程），实时追加 */
  streamText: string
  /** 流式区是否展开（跑时自动展开，完成后可折叠） */
  streamExpanded: boolean
  solving: boolean
  grading: boolean
  // ── 解题结果 ──
  solved: boolean
  stem: string
  qtype: string
  options: string[]
  answer: string
  analysis: string
  needGrading: boolean
  // ── 打标（异步跟在解题后） ──
  labeling: boolean
  dnaReady: boolean
  dnaExpanded: boolean
  dnaDifficulty: number | null
  examType: string | null
  mainKp: string | null
  tags: string[]
  // ── 批改结果 ──
  graded: boolean
  gradeVerdict: string | null
  gradeFeedback: string
  gradeStudentAnswer: string
  gradeStandardAnswer: string
  // ── 编辑态 ──
  editing: boolean
  draftStem: string
  draftAnswer: string
  draftAnalysis: string
  // ── 录题态 ──
  ingesting: boolean
  ingested: boolean
  // 流控制器（中止用）
  _abort: null | (() => void)
}

let cardSeq = 0

// ── 图像承载 ─────────────────────────────────────────────────────────────
const fileInputRef = ref<HTMLInputElement>()
const imgEl = ref<HTMLImageElement>()
const stageRef = ref<HTMLDivElement>()
const imageSrc = ref<string>('')
const naturalW = ref(0)
const naturalH = ref(0)
const scale = ref(1)
const cards = ref<IngestCard[]>([])

const hasImage = computed(() => !!imageSrc.value)
const isDragOver = ref(false)

// ── 上传/读图 ────────────────────────────────────────────────────────────
function triggerUpload() {
  fileInputRef.value?.click()
}
function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) loadImageFile(file)
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
function onDragOver(e: DragEvent) {
  e.preventDefault()
  isDragOver.value = true
}
function onDragLeave(e: DragEvent) {
  e.preventDefault()
  isDragOver.value = false
}
function onDrop(e: DragEvent) {
  e.preventDefault()
  isDragOver.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) loadImageFile(file)
}
function zoomIn() {
  scale.value = Math.min(3, +(scale.value + 0.15).toFixed(2))
}
function zoomOut() {
  scale.value = Math.max(0.2, +(scale.value - 0.15).toFixed(2))
}

// ── 拖框选区 ─────────────────────────────────────────────────────────────
const drawing = ref(false)
const drawRect = reactive({ x: 0, y: 0, w: 0, h: 0 })
let startX = 0
let startY = 0
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
  if (drawRect.w < 12 || drawRect.h < 12) return
  commitRegion()
}
function commitRegion() {
  const s = scale.value || 1
  let nx = drawRect.x / s
  let ny = drawRect.y / s
  let nw = drawRect.w / s
  let nh = drawRect.h / s
  nx = Math.max(0, Math.min(nx, naturalW.value))
  ny = Math.max(0, Math.min(ny, naturalH.value))
  nw = Math.min(nw, naturalW.value - nx)
  nh = Math.min(nh, naturalH.value - ny)
  if (nw < 8 || nh < 8) return
  const rect: RegionRect = { x: Math.round(nx), y: Math.round(ny), w: Math.round(nw), h: Math.round(nh) }
  const dataUrl = cropRegion(rect)
  if (!dataUrl) {
    ElMessage.error('裁剪失败')
    return
  }
  cards.value.push(createCard(rect, dataUrl))
}
function cropRegion(rect: RegionRect): string | null {
  const img = imgEl.value
  if (!img) return null
  const canvas = document.createElement('canvas')
  canvas.width = rect.w
  canvas.height = rect.h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)
  return canvas.toDataURL('image/png') // 无损 PNG，禁压缩（R7）
}
function createCard(rect: RegionRect, dataUrl: string): IngestCard {
  return reactive({
    id: ++cardSeq,
    rect,
    dataUrl,
    status: 'idle',
    error: null,
    selected: true,
    streamKind: '',
    streamText: '',
    streamExpanded: true,
    solving: false,
    grading: false,
    solved: false,
    stem: '',
    qtype: '',
    options: [],
    answer: '',
    analysis: '',
    needGrading: false,
    labeling: false,
    dnaReady: false,
    dnaExpanded: false,
    dnaDifficulty: null,
    examType: null,
    mainKp: null,
    tags: [],
    graded: false,
    gradeVerdict: null,
    gradeFeedback: '',
    gradeStudentAnswer: '',
    gradeStandardAnswer: '',
    editing: false,
    draftStem: '',
    draftAnswer: '',
    draftAnalysis: '',
    ingesting: false,
    ingested: false,
    _abort: null,
  })
}

function stripDataPrefix(dataUrl: string): string {
  const idx = dataUrl.indexOf(',')
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl
}

// ── 解题（识别+解题，流式）+ 异步打标 ──────────────────────────────────────
function solveCard(card: IngestCard) {
  if (card.solving || card.grading) return
  card.solving = true
  card.streamKind = 'solve'
  card.streamText = ''
  card.streamExpanded = true
  card.error = null
  card.status = 'idle'
  const handle = solveStream(stripDataPrefix(card.dataUrl), {
    onToken: (delta) => {
      card.streamText += delta
    },
    onResult: (r: SolveStreamResult) => {
      card.stem = r.stem || ''
      card.qtype = r.qtype || ''
      card.options = Array.isArray(r.options) ? r.options : []
      card.answer = r.answer || ''
      card.analysis = r.analysis || card.streamText
      card.needGrading = !!r.need_grading
      card.solved = true
      card.status = 'done'
      // 🔴 打标异步跟在解题后（不阻塞老师其他操作）
      void labelAsync(card)
    },
    onError: (msg) => {
      card.error = msg
      card.status = 'failed'
    },
    onClose: () => {
      card.solving = false
      card._abort = null
    },
  })
  card._abort = handle.abort
}

// 异步打标（解出来就跑，失败静默，不影响录题）
async function labelAsync(card: IngestCard) {
  if (!card.stem) return
  card.labeling = true
  try {
    const r = await labelQuestion({
      stem: card.stem,
      qtype: card.qtype,
      options: card.options,
      answer: card.answer,
      analysis: card.analysis,
    })
    const dna = (r?.dna || {}) as Record<string, unknown>
    if (dna && typeof dna === 'object') {
      const diff = dna.difficulty
      card.dnaDifficulty = typeof diff === 'number' ? diff : null
      card.examType = (dna.assessmentType as string) || null
      const pk = dna.primaryKp as Record<string, unknown> | undefined
      card.mainKp = (pk?.name as string) || null
      card.tags = Array.isArray(dna.tags) ? (dna.tags as string[]) : []
      card.dnaReady = true
    }
  } catch {
    // 打标是额外的事，失败静默
  } finally {
    card.labeling = false
  }
}

// ── 批改（识别+先解题+判对错，流式）。本页所有题都可批改 ──────────────────────
function gradeCard(card: IngestCard) {
  if (card.solving || card.grading) return
  card.grading = true
  card.streamKind = 'grade'
  card.streamText = ''
  card.streamExpanded = true
  const handle = gradeStream(
    {
      imageBase64: stripDataPrefix(card.dataUrl),
      knowledge: card.mainKp || '',
      chapter: selectedChapterLabel.value || '',
    },
    {
      onToken: (delta) => {
        card.streamText += delta
      },
      onResult: (r: GradeStreamResult) => {
        card.graded = true
        card.gradeVerdict = r.verdict
        card.gradeFeedback = r.feedback || ''
        card.gradeStudentAnswer = r.student_answer || ''
        card.gradeStandardAnswer = r.standard_answer || ''
        if (!card.stem && r.stem) card.stem = r.stem
        if (!card.answer && r.standard_answer) card.answer = r.standard_answer
        if (!card.solved && r.standard_answer) {
          card.solved = true
          card.status = 'done'
        }
      },
      onError: (msg) => {
        ElMessage.error('批改失败：' + msg)
      },
      onClose: () => {
        card.grading = false
        card._abort = null
      },
    },
  )
  card._abort = handle.abort
}

function toggleStream(card: IngestCard) {
  card.streamExpanded = !card.streamExpanded
}
function toggleDna(card: IngestCard) {
  card.dnaExpanded = !card.dnaExpanded
}

function gradeVerdictText(v: string | null): string {
  switch (v) {
    case 'correct':
      return '✅ 作答正确'
    case 'wrong':
      return '❌ 作答错误'
    case 'partial':
      return '⚠️ 部分正确'
    case 'blank':
      return '⬜ 未作答'
    case 'uncertain':
      return '❓ 存疑（建议人工复核）'
    default:
      return v || ''
  }
}

function removeCard(card: IngestCard) {
  card._abort?.()
  const i = cards.value.findIndex((c) => c.id === card.id)
  if (i >= 0) cards.value.splice(i, 1)
}

async function clearAll() {
  if (cards.value.length === 0) return
  try {
    await ElMessageBox.confirm('清空所有题框重新框选？已识别但未录入的内容会丢失。', '清空重框', {
      type: 'warning',
      confirmButtonText: '清空',
      cancelButtonText: '取消',
    })
    cards.value.forEach((c) => c._abort?.())
    cards.value = []
  } catch {
    // 取消
  }
}

// ── 编辑（改题面/答案文本，非 LLM）──────────────────────────────────────────
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

// ── 章节（录题必选，从顶栏选；去掉「绑定章节」字样） ─────────────────────────
const chapterTreeData = ref<SubjectNode[]>([])
const chapterTreeLoading = ref(false)
const selectedSubjectId = ref<string>('')
const selectedChapterLabel = computed(() => {
  const find = (nodes: SubjectNode[]): string => {
    for (const n of nodes) {
      const node = n as unknown as { id: string; title?: string; name?: string; children?: SubjectNode[] }
      if (String(node.id) === selectedSubjectId.value) return node.title || node.name || ''
      if (node.children?.length) {
        const got = find(node.children)
        if (got) return got
      }
    }
    return ''
  }
  return selectedSubjectId.value ? find(chapterTreeData.value) : ''
})
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

// ── 录题 ─────────────────────────────────────────────────────────────────
const ingestingAll = ref(false)
function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64] = dataUrl.split(',')
  const mime = /:(.*?);/.exec(head)?.[1] || 'image/png'
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return new Blob([arr], { type: mime })
}
const ingestableCards = computed(() =>
  cards.value.filter((c) => c.solved && c.selected && !c.ingested),
)
async function ingestOne(card: IngestCard): Promise<boolean> {
  if (!card.stem) {
    ElMessage.warning('请先解题（得到题干）再录题')
    return false
  }
  if (!selectedSubjectId.value) {
    ElMessage.warning('请先在右上角选择章节')
    return false
  }
  card.ingesting = true
  try {
    const blob = dataUrlToBlob(card.dataUrl)
    const up = await uploadIngestImage(blob)
    const images: IngestQuestionImage[] = [
      { assetId: up.assetId, ossUrl: up.ossUrl, role: 'figure', seq: 0, isDecorative: 0 },
    ]
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
    ElMessage.success('已录入草稿')
    return true
  } catch (e) {
    console.warn('[ingest] one failed', e)
    ElMessage.error('录题失败')
    return false
  } finally {
    card.ingesting = false
  }
}
async function ingestAll() {
  if (ingestingAll.value) return
  if (!selectedSubjectId.value) {
    ElMessage.warning('请先在右上角选择章节')
    return
  }
  const targets = ingestableCards.value.slice()
  if (targets.length === 0) {
    ElMessage.warning('没有可录入的题（需已解题且勾选）')
    return
  }
  ingestingAll.value = true
  let okCount = 0
  try {
    for (const card of targets) {
      if (await ingestOne(card)) okCount++
    }
  } finally {
    ingestingAll.value = false
  }
  if (okCount === targets.length) ElMessage.success(`已录入 ${okCount} 道题`)
  else if (okCount > 0) ElMessage.warning(`录入 ${okCount}/${targets.length} 道（部分失败）`)
}

function goBack() {
  router.push('/desk/my-question')
}
function goMyQuestion() {
  router.push('/desk/my-question')
}

function cardDisplayStyle(card: IngestCard) {
  const s = scale.value || 1
  return {
    left: `${card.rect.x * s}px`,
    top: `${card.rect.y * s}px`,
    width: `${card.rect.w * s}px`,
    height: `${card.rect.h * s}px`,
  }
}
function difficultyText(d: number | null): string {
  return d == null ? '' : `${d}星`
}

onMounted(() => {
  loadChapterTree()
  window.addEventListener('resize', fitScale)
  window.addEventListener('paste', onPaste)
})
onBeforeUnmount(() => {
  cards.value.forEach((c) => c._abort?.())
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
        <el-tree-select
          v-model="selectedSubjectId"
          :data="chapterTreeData"
          :props="{ label: 'title', children: 'children' }"
          node-key="id"
          placeholder="选择章节（录题必选）"
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
          全部录题{{ ingestableCards.length ? `（${ingestableCards.length}）` : '' }}
        </el-button>
      </div>
    </header>

    <div class="body">
      <!-- ══ 左：图像 + 框选舞台 ══ -->
      <section class="stage-pane">
        <div
          v-if="!hasImage"
          class="empty-stage"
          :class="{ 'is-dragover': isDragOver }"
          @click="triggerUpload"
          @dragover="onDragOver"
          @dragleave="onDragLeave"
          @drop="onDrop"
        >
          <el-icon class="empty-icon"><Upload /></el-icon>
          <p class="empty-title">点击 / 拖拽 / 粘贴 上传题卷照片</p>
          <p class="empty-hint">上传后在图上拖框选区，每框右侧可解题 / 批改</p>
        </div>

        <template v-else>
          <div class="stage-toolbar">
            <el-button text :icon="Upload" @click="triggerUpload">重新上传</el-button>
            <el-divider direction="vertical" />
            <el-button text :icon="ZoomOut" @click="zoomOut" />
            <span class="zoom-val">{{ Math.round(scale * 100) }}%</span>
            <el-button text :icon="ZoomIn" @click="zoomIn" />
            <el-divider direction="vertical" />
            <el-button size="small" text :disabled="cards.length === 0" @click="clearAll">清空重框</el-button>
            <span class="stage-tip">按住鼠标拖动画框，框完在右侧解题 / 批改</span>
          </div>

          <div ref="stageRef" class="stage-scroll" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
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
              <div
                v-for="(card, idx) in cards"
                :key="card.id"
                class="region-box"
                :class="{ 'is-done': card.solved, 'is-busy': card.solving || card.grading }"
                :style="cardDisplayStyle(card)"
              >
                <span class="region-no">{{ idx + 1 }}</span>
              </div>
              <div
                v-if="drawing"
                class="region-box drawing"
                :style="{ left: `${drawRect.x}px`, top: `${drawRect.y}px`, width: `${drawRect.w}px`, height: `${drawRect.h}px` }"
              />
            </div>
          </div>
        </template>

        <input ref="fileInputRef" type="file" accept="image/*" style="display: none" @change="onFileChange" />
      </section>

      <!-- ══ 右：题卡列表 ══ -->
      <aside class="cards-pane">
        <div class="cards-header">
          <span class="cards-title">题卡</span>
          <el-tag v-if="cards.length" type="info" size="small" round>{{ cards.length }} 框</el-tag>
        </div>

        <el-empty
          v-if="cards.length === 0"
          description="还没有框选。上传图片后在左侧拖框，每框可解题 / 批改"
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
              <el-checkbox v-model="card.selected" :disabled="!card.solved || card.ingested" />
              <span class="card-no">第 {{ idx + 1 }} 框</span>
              <el-tag v-if="card.ingested" type="success" size="small">已录入</el-tag>
              <el-tag v-else-if="card.needGrading" size="small" type="warning" effect="plain">含作答</el-tag>
              <div class="card-top-spacer" />
              <el-button text :icon="Delete" size="small" :disabled="card.ingesting" @click="removeCard(card)" />
            </div>

            <!-- 裁剪暂存图 -->
            <div class="card-thumb">
              <img :src="card.dataUrl" alt="框选区域" />
            </div>

            <!-- 编辑态 -->
            <template v-if="card.editing">
              <div class="edit-field">
                <label class="edit-label">题干</label>
                <el-input v-model="card.draftStem" type="textarea" :rows="4" />
                <div class="edit-preview"><MarkdownMath :content="card.draftStem || ' '" /></div>
              </div>
              <div class="edit-field">
                <label class="edit-label">答案</label>
                <el-input v-model="card.draftAnswer" type="textarea" :rows="2" />
              </div>
              <div class="edit-field">
                <label class="edit-label">解析</label>
                <el-input v-model="card.draftAnalysis" type="textarea" :rows="3" />
              </div>
              <div class="edit-actions">
                <el-button type="primary" size="small" @click="saveEdit(card)">保存</el-button>
                <el-button size="small" @click="cancelEdit(card)">取消</el-button>
              </div>
            </template>

            <!-- 展示态 -->
            <template v-else>
              <!-- 题干（解题后） -->
              <div v-if="card.stem" class="stem-render">
                <MarkdownMath :content="card.stem" />
              </div>
              <ul v-if="card.options.length" class="opt-list">
                <li v-for="(opt, oi) in card.options" :key="oi"><MarkdownMath :content="opt" /></li>
              </ul>

              <!-- 答案（解题后） -->
              <div v-if="card.solved && card.answer" class="answer-line">
                <span class="answer-tag">答案</span><MarkdownMath :content="card.answer" />
              </div>

              <!-- 解题/批改 流式过程（就地、可折叠） -->
              <div v-if="card.streamText || card.solving || card.grading" class="stream-block">
                <div class="stream-head" @click="toggleStream(card)">
                  <el-icon class="stream-caret"><component :is="card.streamExpanded ? ArrowDown : ArrowRight" /></el-icon>
                  <span class="stream-title">
                    {{ card.streamKind === 'grade' ? '批改过程' : '解题过程' }}
                    <el-icon v-if="card.solving || card.grading" class="is-loading stream-spin"><MagicStick /></el-icon>
                  </span>
                </div>
                <div v-show="card.streamExpanded" class="stream-body">
                  <MarkdownMath :content="card.streamText || '正在思考…'" />
                </div>
              </div>

              <!-- 批改结论 -->
              <div v-if="card.graded && card.gradeVerdict" class="grade-result">
                <el-tag size="small" effect="dark" :type="card.gradeVerdict === 'correct' ? 'success' : card.gradeVerdict === 'wrong' ? 'danger' : 'warning'">
                  {{ gradeVerdictText(card.gradeVerdict) }}
                </el-tag>
                <span v-if="card.gradeFeedback" class="grade-feedback">{{ card.gradeFeedback }}</span>
              </div>

              <!-- 打标(DNA) 异步、可折叠 -->
              <div v-if="card.labeling || card.dnaReady" class="dna-block">
                <div class="stream-head" @click="toggleDna(card)">
                  <el-icon class="stream-caret"><component :is="card.dnaExpanded ? ArrowDown : ArrowRight" /></el-icon>
                  <span class="stream-title">
                    考点 · 标签
                    <el-icon v-if="card.labeling" class="is-loading stream-spin"><MagicStick /></el-icon>
                    <span v-else-if="card.dnaReady" class="dna-ok">已打标</span>
                  </span>
                </div>
                <div v-show="card.dnaExpanded && card.dnaReady" class="dna-body">
                  <div class="meta-row">
                    <el-tag v-if="card.qtype" size="small" type="info">{{ card.qtype }}</el-tag>
                    <el-tag v-if="difficultyText(card.dnaDifficulty)" size="small" type="warning">{{ difficultyText(card.dnaDifficulty) }}</el-tag>
                    <el-tag v-if="card.examType" size="small">{{ card.examType }}</el-tag>
                  </div>
                  <div v-if="card.mainKp" class="kp-row">考点：{{ card.mainKp }}</div>
                  <div v-if="card.tags.length" class="tag-row">
                    <el-tag v-for="(t, ti) in card.tags" :key="ti" size="small" type="info" effect="plain">{{ t }}</el-tag>
                  </div>
                </div>
              </div>

              <!-- 失败 -->
              <div v-if="card.status === 'failed'" class="card-failed">
                <p class="fail-msg">{{ card.error }}</p>
              </div>

              <!-- ── 四功能：解题 / 批改 / 编辑 / 录题 ── -->
              <div class="card-actions">
                <el-button
                  size="small"
                  type="primary"
                  :icon="MagicStick"
                  :loading="card.solving"
                  :disabled="card.grading || card.ingesting"
                  @click="solveCard(card)"
                >
                  {{ card.solved ? '重新解题' : '解题' }}
                </el-button>
                <el-button
                  size="small"
                  type="warning"
                  :icon="DocumentChecked"
                  :loading="card.grading"
                  :disabled="card.solving || card.ingesting"
                  @click="gradeCard(card)"
                >
                  批改
                </el-button>
                <el-button size="small" :icon="EditPen" :disabled="!card.stem || card.ingesting" @click="startEdit(card)">
                  编辑
                </el-button>
                <el-button
                  size="small"
                  :loading="card.ingesting"
                  :disabled="!card.solved || card.ingested || !selectedSubjectId"
                  @click="ingestOne(card)"
                >
                  {{ card.ingested ? '已录题' : '录题' }}
                </el-button>
              </div>
            </template>
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
.chapter-select {
  width: 260px;
}
.body {
  flex: 1;
  display: flex;
  min-height: 0;
}
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
  transition: border-color 0.2s, background 0.2s;
}
.empty-stage:hover,
.empty-stage.is-dragover {
  border-color: #0fb488;
  background: #f0fdf9;
}
.empty-icon {
  font-size: 48px;
  color: #0fb488;
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
.region-box {
  position: absolute;
  border: 2px solid #f5a623;
  background: rgba(245, 166, 35, 0.08);
  box-sizing: border-box;
  pointer-events: none;
}
.region-box.is-done {
  border-color: #0fb488;
  background: rgba(15, 180, 136, 0.08);
}
.region-box.is-busy {
  border-color: #4080ff;
  background: rgba(64, 128, 255, 0.1);
}
.region-box.drawing {
  border-style: dashed;
}
.region-no {
  position: absolute;
  left: 0;
  top: 0;
  background: #f5a623;
  color: #fff;
  font-size: 12px;
  line-height: 18px;
  min-width: 18px;
  text-align: center;
  padding: 0 4px;
}
.region-box.is-done .region-no {
  background: #0fb488;
}
.cards-pane {
  width: 460px;
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
  max-height: 150px;
  display: flex;
  justify-content: center;
  background: #fafafa;
}
.card-thumb img {
  max-width: 100%;
  max-height: 150px;
  object-fit: contain;
}
.stem-render {
  font-size: 14px;
  color: #1d2129;
  margin-top: 4px;
}
.opt-list {
  list-style: none;
  padding: 0;
  margin: 6px 0 0;
}
.opt-list li {
  margin: 2px 0;
}
.answer-line {
  margin-top: 8px;
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 14px;
}
.answer-tag {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 600;
  color: #0fb488;
}
/* 流式区 */
.stream-block,
.dna-block {
  margin-top: 10px;
  border: 1px solid #eef0f3;
  border-radius: 8px;
  overflow: hidden;
}
.stream-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  cursor: pointer;
  background: #f7f8fa;
  user-select: none;
}
.stream-caret {
  font-size: 12px;
  color: #86909c;
}
.stream-title {
  font-size: 13px;
  font-weight: 600;
  color: #4e5969;
  display: flex;
  align-items: center;
  gap: 6px;
}
.stream-spin {
  color: #4080ff;
}
.dna-ok {
  font-size: 11px;
  color: #0fb488;
  font-weight: 400;
}
.stream-body,
.dna-body {
  padding: 8px 10px;
  font-size: 13px;
  color: #1d2129;
  max-height: 260px;
  overflow-y: auto;
}
.grade-result {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.grade-feedback {
  font-size: 13px;
  color: #4e5969;
}
.meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
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
.card-failed {
  margin-top: 8px;
}
.fail-msg {
  color: #f53f3f;
  font-size: 13px;
}
.card-actions {
  margin-top: 12px;
  display: flex;
  flex-wrap: wrap;
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
