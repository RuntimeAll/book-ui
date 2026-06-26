<script setup lang="ts">
// ---------------------------------------------------------------------------
// PRD-A-002 路A「框选录题全屏页」（bug 轮 B3/B4/B6 重构）。
//
// 🔴 维护者拍板的正确流程（B3）：上传（点击/拖拽/粘贴）→ 在放大的图上拖框选区（可多框）→
//   **框完只裁剪、暂存到右侧题卡列**（不自动识别、不无痕操作）→ 老师在卡上点按钮**确认**触发：
//   智能识别 / 解题 / 批改 / 编辑（B4 四功能）→ 选绑定章节 →「录入」落 biz_question 草稿。
//
// 四功能（B4）：
//   · 智能识别 = OCR 转去手写富文本（顺带 need_grading 标记：框区有学生作答/笔迹）。
//   · 解题     = AI 解这道题（自动打标 DNA + sympy 验算）。
//   · 批改     = 仅 need_grading 时出现；裁剪图 → 先解题 → 判学生作答对错（弹窗展示）。
//   · 编辑     = 改题面/答案/解析文本（非 LLM）。
//
// 🔴 提示规范（B3）：不内联堆字占屏；耗时只用 loading 态，必要提示走弹窗/消息条。
// 🔴 学段提示已删（B6）：学段从绑定章节推断，不让老师填。
// ---------------------------------------------------------------------------
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Back, Upload, ZoomIn, ZoomOut, Delete, MagicStick, EditPen, DocumentChecked } from '@element-plus/icons-vue'
import MarkdownMath from '@/components/MarkdownMath.vue'
import { lazyTree, type SubjectNode } from '@/api/question/index'
import {
  recognize,
  grade,
  uploadIngestImage,
  ingestQuestion,
  mapQtypeToCode,
  mapDifficultyToCode,
  type RecognizeResult,
  type GradeResult,
  type IngestQuestionImage,
} from '@/api/ingest/index'

const router = useRouter()

// ── 框卡状态机 ───────────────────────────────────────────────────────────
// pending = 框完裁剪暂存、待识别；recognizing = 识别中；done = 已识别；failed = 识别失败
type CardStatus = 'pending' | 'recognizing' | 'done' | 'failed'

interface RegionRect {
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
  /** B4：智能识别标记到该框含学生作答/笔迹 → 出现「批改」按钮 */
  needGrading: boolean
  // 识别 + 编辑后的可编辑字段
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
  // 编辑态
  editing: boolean
  draftStem: string
  draftAnswer: string
  draftAnalysis: string
  // 批改态（B4）
  grading: boolean
  graded: boolean
  gradeVerdict: string | null
  gradeFeedback: string
  gradeStudentAnswer: string
  gradeStandardAnswer: string
  gradeStandardAnalysis: string
  // 录入态
  ingesting: boolean
  ingested: boolean
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

// 粘贴上传
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

// 拖拽上传（B3：空态 + 舞台均可拖入）
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
  // 🔴 B3：框完只裁剪暂存生成题卡，**不自动识别**（待老师在卡上点「智能识别」确认）
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
  // 🔴 无损 PNG，禁传质量参数压缩（R7）
  return canvas.toDataURL('image/png')
}

function createCard(rect: RegionRect, dataUrl: string): IngestCard {
  // 🔴 必须 reactive 包裹：异步识别/解题/批改各突变才触发渲染（见 bug 轮根因）。
  return reactive({
    id: ++cardSeq,
    rect,
    dataUrl,
    status: 'pending',
    error: null,
    selected: true,
    solved: false,
    recognizing: false,
    needGrading: false,
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
    grading: false,
    graded: false,
    gradeVerdict: null,
    gradeFeedback: '',
    gradeStudentAnswer: '',
    gradeStandardAnswer: '',
    gradeStandardAnalysis: '',
    ingesting: false,
    ingested: false,
  })
}

// ── 智能识别 / 解题（B4）─────────────────────────────────────────────────
function stripDataPrefix(dataUrl: string): string {
  const idx = dataUrl.indexOf(',')
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl
}

async function recognizeCard(card: IngestCard, solve = false) {
  if (card.recognizing || card.ingesting) return
  card.status = 'recognizing'
  card.recognizing = true
  card.error = null
  try {
    const result: RecognizeResult = await recognize({
      image_base64: stripDataPrefix(card.dataUrl),
      solve,
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
  card.needGrading = !!r.need_grading
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

// 智能识别（OCR 富文本，不解题）
function recognizeCardOnly(card: IngestCard) {
  void recognizeCard(card, false)
}

// 解题（识别 + 解题 + 自动打标）
function solveCard(card: IngestCard) {
  void recognizeCard(card, true)
}

// 批量识别所有待识别框（确认后识别的批量入口）
async function recognizeAllPending() {
  const pend = cards.value.filter((c) => c.status === 'pending' && !c.recognizing)
  if (pend.length === 0) {
    ElMessage.info('没有待识别的题框')
    return
  }
  for (const card of pend) {
    await recognizeCard(card, false)
  }
}

function retryCard(card: IngestCard) {
  if (card.recognizing) return
  void recognizeCard(card, card.solved)
}

function removeCard(card: IngestCard) {
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
    cards.value = []
  } catch {
    // 取消
  }
}

// ── 批改（B4）：裁剪图 → 先解题 → 判学生作答对错，弹窗展示 ──────────────────
async function gradeCard(card: IngestCard) {
  if (card.grading) return
  card.grading = true
  try {
    const knowledge = card.mainKp || ''
    const chapter = selectedChapterLabel.value || ''
    const r: GradeResult = await grade({
      image_base64: stripDataPrefix(card.dataUrl),
      ...(knowledge ? { knowledge } : {}),
      ...(chapter ? { chapter } : {}),
    })
    if (!r.ok && r.error) {
      ElMessage.error('批改失败：' + r.error)
      return
    }
    card.graded = true
    card.gradeVerdict = r.verdict
    card.gradeFeedback = r.feedback || ''
    card.gradeStudentAnswer = r.student_answer || ''
    card.gradeStandardAnswer = r.standard_answer || ''
    card.gradeStandardAnalysis = r.standard_analysis || ''
    showGradeDialog(card)
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '批改失败')
  } finally {
    card.grading = false
  }
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

// 批改结果弹窗（不内联占屏，B3 提示规范）
function showGradeDialog(card: IngestCard) {
  const lines = [
    `<p><b>${gradeVerdictText(card.gradeVerdict)}</b></p>`,
    card.gradeStudentAnswer ? `<p>学生作答：${escapeHtml(card.gradeStudentAnswer)}</p>` : '',
    card.gradeStandardAnswer ? `<p>标准答案：${escapeHtml(card.gradeStandardAnswer)}</p>` : '',
    card.gradeFeedback ? `<p style="color:#4e5969">点评：${escapeHtml(card.gradeFeedback)}</p>` : '',
  ].filter(Boolean)
  ElMessageBox.alert(lines.join(''), '批改结果', {
    dangerouslyUseHTMLString: true,
    confirmButtonText: '知道了',
  })
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c))
}

// ── 编辑（原「改题」，B4 重命名为编辑）─────────────────────────────────────
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

// ── 章节绑定 ───────────────────────────────────────────────────────────────
const chapterTreeData = ref<SubjectNode[]>([])
const chapterTreeLoading = ref(false)
const selectedSubjectId = ref<string>('')

// 选中章节的 label（B4 批改 prompt 注入章节上下文用）
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

// ── 框预览 ─────────────────────────────────────────────────────────────────
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
  if (d == null) return ''
  return `${d}星`
}

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

const pendingCount = computed(() => cards.value.filter((c) => c.status === 'pending').length)

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
        <!-- 空态（B3：点击 / 拖拽 / 粘贴 三入口上传） -->
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
          <p class="empty-hint">上传后在图上拖框选区，框完在右侧确认识别</p>
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
            <el-button
              size="small"
              type="primary"
              plain
              :disabled="pendingCount === 0"
              @click="recognizeAllPending"
            >
              识别全部待识别{{ pendingCount ? `（${pendingCount}）` : '' }}
            </el-button>
            <el-button size="small" text :disabled="cards.length === 0" @click="clearAll">清空重框</el-button>
            <span class="stage-tip">按住鼠标拖动画框，框完在右侧逐题确认识别</span>
          </div>

          <div
            ref="stageRef"
            class="stage-scroll"
            @dragover="onDragOver"
            @dragleave="onDragLeave"
            @drop="onDrop"
          >
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
                :class="{ 'is-failed': card.status === 'failed', 'is-done': card.status === 'done', 'is-pending': card.status === 'pending' }"
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
          description="还没有框选。上传图片后在左侧拖框，框完在此逐题确认识别"
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
              <el-tag v-else-if="card.needGrading" size="small" type="warning" effect="plain">含作答</el-tag>
              <div class="card-top-spacer" />
              <el-button text :icon="Delete" size="small" :disabled="card.ingesting" @click="removeCard(card)" />
            </div>

            <!-- 缩略图（裁剪暂存图） -->
            <div class="card-thumb">
              <img :src="card.dataUrl" alt="框选区域" />
            </div>

            <!-- 待识别（B3：框完暂存，等老师确认识别）-->
            <div v-if="card.status === 'pending'" class="card-pending">
              <div class="pending-actions">
                <el-button size="small" type="primary" :icon="MagicStick" @click="recognizeCardOnly(card)">
                  智能识别
                </el-button>
                <el-button size="small" :icon="Delete" @click="removeCard(card)">删除</el-button>
              </div>
            </div>

            <!-- 识别中 -->
            <div v-else-if="card.status === 'recognizing'" class="card-loading">
              <el-icon class="is-loading"><MagicStick /></el-icon>
              <span>处理中…</span>
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
              <!-- 编辑态 -->
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
                  <el-tag v-if="card.graded && card.gradeVerdict" size="small" effect="dark">
                    {{ gradeVerdictText(card.gradeVerdict) }}
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

                <div v-if="card.solved && (card.answer || card.analysis)" class="solve-block">
                  <p v-if="card.answer" class="solve-label">答案</p>
                  <MarkdownMath v-if="card.answer" :content="card.answer" />
                  <p v-if="card.analysis" class="solve-label">解析</p>
                  <MarkdownMath v-if="card.analysis" :content="card.analysis" />
                  <div v-if="card.verifyDetail" class="verify-detail">{{ card.verifyDetail }}</div>
                </div>

                <!-- B4 四功能：智能识别(重) / 解题 / 批改(条件) / 编辑 -->
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
                  <el-button
                    v-if="card.needGrading"
                    size="small"
                    type="warning"
                    :icon="DocumentChecked"
                    :loading="card.grading"
                    :disabled="card.ingesting"
                    @click="gradeCard(card)"
                  >
                    批改
                  </el-button>
                  <el-button size="small" :icon="EditPen" :disabled="card.ingesting" @click="startEdit(card)">
                    编辑
                  </el-button>
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

/* 框 */
.region-box {
  position: absolute;
  border: 2px solid #0fb488;
  background: rgba(15, 180, 136, 0.08);
  box-sizing: border-box;
  pointer-events: none;
}
.region-box.is-pending {
  border-color: #f5a623;
  background: rgba(245, 166, 35, 0.08);
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
  background: #0fb488;
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

.card-pending {
  padding: 4px 0 2px;
}
.pending-actions {
  display: flex;
  gap: 8px;
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
  color: #0fb488;
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
