<script setup lang="ts">
/**
 * MultiFunctionFab — PRD-A-002 B1 多功能球 hub（合并三球为一）
 *
 * 背景：原先画面右下叠了 3 个独立浮球（试题栏 QuestionBasket / 试卷篮 PaperBasketFab /
 *   拆题 IngestFab），偏离设计稿正本（page1-mybank.html FP2/FP7：要求合并成「一个多
 *   功能球 + hub 面板」）。本组件按正本重做：
 *
 *   - 单个浮球，单击展开 / 收起一个 hub 面板。
 *   - hub 头部「＋录入新题」入口（跳 /ingest/frame 框选录题页）。
 *   - 三 tab：进行中(n) / 试题栏(n) / 试卷篮(n)。
 *       · 试题栏 tab  = 复用 useQuestionBasket 的列表内容（移除 / 拖拽重排 / 组卷）。
 *       · 试卷篮 tab  = 复用 usePaperBasket 的列表内容（移除 / 去组卷工作台）。
 *       · 进行中 tab  = 录题作业进度列表（轮询 GET /teacher/ingest/jobs + 去审核）。
 *   - 收起态（FP7）：球内进度环 + 球心文字，按优先级只显最高优先态：
 *       P1 处理中(进度环+"62%/拆题中") ＞ 完成(✓) ＞ P3 试题栏有货 ＞ P4 试卷篮有货 ＞ idle。
 *       （P2「组卷中」本期无独立态来源，留位不实现。）
 *   - 可拖动：pointer 拖到任意位置，记住到 localStorage。
 *
 *   复用现有 composable 状态，不新造数据源。废弃独立 IngestFab/QuestionBasket FAB/
 *   PaperBasketFab FAB，统一由本组件在 AppLayout 挂一次。
 */
import { ref, reactive, computed, nextTick, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import Sortable from 'sortablejs'
import {
  ShoppingCart, Tickets, Loading, CircleCheck, Right,
  DocumentAdd, Close, ZoomIn, Rank, Delete, Plus, Menu as MenuIcon,
} from '@element-plus/icons-vue'
import { useQuestionBasket } from '@/composables/useQuestionBasket'
import { usePaperBasket } from '@/composables/usePaperBasket'
import { getQuestionDetail, type QuestionItem } from '@/api/question/index'
import { useDictStore, DICT_QUESTION_TYPE } from '@/store/dict'
import { listIngestJobs, type IngestJobRow, type IngestJobStatus } from '@/api/ingest/index'
import QuestionCard from '@/components/business/QuestionCard/index.vue'
import QuestionContent from '@/components/business/QuestionContent/index.vue'

const router = useRouter()
const qBasket = useQuestionBasket()
const pBasket = usePaperBasket()
const dict = useDictStore()
dict.load(DICT_QUESTION_TYPE)

// ── hub 展开 / 当前 tab ────────────────────────────────────────
type TabKey = 'prog' | 'bskt' | 'paper'
const open = ref(false)
const activeTab = ref<TabKey>('prog')

// ── 进行中（拆题作业）：轮询，逻辑搬自原 IngestFab ──────────────
const jobs = ref<IngestJobRow[]>([])
const ACTIVE_STATUS = new Set<IngestJobStatus>(['PENDING', 'EXTRACT_ING', 'SPLIT_ING'])
const activeJobCount = computed(() => jobs.value.filter((j) => ACTIVE_STATUS.has(j.status)).length)
const doneJobCount = computed(() => jobs.value.filter((j) => j.status === 'DONE').length)

let timer: ReturnType<typeof setTimeout> | null = null
let stopped = false

async function refreshJobs() {
  try {
    const rows = await listIngestJobs()
    jobs.value = Array.isArray(rows) ? rows : []
  } catch (e) {
    console.warn('[mf-fab] listIngestJobs failed', e)
  }
}

function scheduleNext() {
  if (stopped) return
  const delay = activeJobCount.value > 0 ? 5_000 : 30_000
  timer = setTimeout(async () => {
    await refreshJobs()
    scheduleNext()
  }, delay)
}

function restartPolling() {
  if (timer) clearTimeout(timer)
  timer = null
  scheduleNext()
}

async function triggerRefresh() {
  await refreshJobs()
  restartPolling()
}

function onIngestJobSubmitted() {
  void triggerRefresh()
}

// ── 进度估算（FP7 球内进度环 / 进行中条目）──────────────────────
//   单作业按 status 粗算进度；hub 球心用「全部活跃作业的平均进度」。
function jobProgress(s: IngestJobStatus): number {
  switch (s) {
    case 'PENDING': return 10
    case 'EXTRACT_ING': return 40
    case 'SPLIT_ING': return 70
    case 'DONE': return 100
    default: return 0
  }
}

const activeAvgProgress = computed(() => {
  const act = jobs.value.filter((j) => ACTIVE_STATUS.has(j.status))
  if (act.length === 0) return 0
  const sum = act.reduce((acc, j) => acc + jobProgress(j.status), 0)
  return Math.round(sum / act.length)
})

function statusLabel(s: IngestJobStatus): string {
  switch (s) {
    case 'PENDING': return '排队中'
    case 'EXTRACT_ING': return '识别中'
    case 'SPLIT_ING': return '拆题中'
    case 'DONE': return '已完成'
    case 'FAILED': return '失败'
    default: return String(s)
  }
}

function statusTagType(s: IngestJobStatus): 'success' | 'danger' | 'warning' | 'info' {
  if (s === 'DONE') return 'success'
  if (s === 'FAILED') return 'danger'
  if (ACTIVE_STATUS.has(s)) return 'warning'
  return 'info'
}

function goReview(job: IngestJobRow) {
  open.value = false
  router.push('/ingest/review/' + job.id)
}

// ── 球内优先级状态（FP7）──────────────────────────────────────
//   P1 处理中 ＞ 完成 ＞ P3 试题栏有货 ＞ P4 试卷篮有货 ＞ idle
type BallMode = 'processing' | 'done' | 'question' | 'paper' | 'idle'
const ballState = computed<{ mode: BallMode; pct: number; label: string; count: number }>(() => {
  if (activeJobCount.value > 0) {
    return { mode: 'processing', pct: activeAvgProgress.value, label: '拆题中', count: activeJobCount.value }
  }
  if (doneJobCount.value > 0) {
    return { mode: 'done', pct: 100, label: '已完成', count: doneJobCount.value }
  }
  if (qBasket.count.value > 0) {
    return { mode: 'question', pct: 0, label: '试题栏', count: qBasket.count.value }
  }
  if (pBasket.count.value > 0) {
    return { mode: 'paper', pct: 0, label: '试卷篮', count: pBasket.count.value }
  }
  return { mode: 'idle', pct: 0, label: '', count: 0 }
})

// 角标总数（试题栏 + 试卷篮 + 活跃作业）
const totalBadge = computed(() => qBasket.count.value + pBasket.count.value + activeJobCount.value)

// 进度环 stroke-dashoffset（半径 28 → 周长 ≈ 175.9）
const RING_CIRC = 2 * Math.PI * 28
const ringOffset = computed(() => RING_CIRC * (1 - ballState.value.pct / 100))

// ── 打开 hub：落到「最高优先有内容」的 tab ──────────────────────
function openHub() {
  open.value = true
  const m = ballState.value.mode
  if (m === 'processing' || m === 'done') activeTab.value = 'prog'
  else if (m === 'question') activeTab.value = 'bskt'
  else if (m === 'paper') activeTab.value = 'paper'
  // idle 保持上次 tab
  void refreshJobs()
  if (activeTab.value === 'bskt') void nextTick(initBasketSortable)
}

function onBallClick() {
  if (dragMoved.value) return // 拖拽刚结束的 click 抑制
  if (open.value) open.value = false
  else openHub()
}

function switchTab(t: TabKey) {
  activeTab.value = t
  if (t === 'bskt') void nextTick(initBasketSortable)
}

function goIngest() {
  open.value = false
  router.push('/ingest/frame')
}

// ── 试题栏 tab：复用 QuestionBasket 的列表 + 拖拽重排 + 解析展开 ──
const listEl = ref<HTMLElement | null>(null)
let sortable: Sortable | null = null

function onBasketDrop() {
  const root = listEl.value
  if (!root) return
  const orderedIds: string[] = []
  root.querySelectorAll<HTMLElement>('[data-item-id]').forEach((el) => {
    const id = el.dataset.itemId
    if (id) orderedIds.push(id)
  })
  qBasket.reorder(orderedIds)
}

function initBasketSortable() {
  if (sortable || !listEl.value) return
  sortable = Sortable.create(listEl.value, {
    handle: '.drag-handle',
    animation: 160,
    ghostClass: 'basket-item-ghost',
    chosenClass: 'basket-item-chosen',
    draggable: '.basket-item',
    onEnd: onBasketDrop,
  })
}

function destroyBasketSortable() {
  sortable?.destroy()
  sortable = null
}

watch([open, activeTab], ([o, t]) => {
  if (o && t === 'bskt') void nextTick(initBasketSortable)
  else destroyBasketSortable()
})

function getQuestionTypeLabel(type: number): string {
  return dict.label(DICT_QUESTION_TYPE, type) || `题型${type}`
}
function getQuestionTypeTag(type: number): 'success' | 'warning' | 'info' | 'primary' | 'danger' {
  const map: Record<number, 'primary' | 'success' | 'warning'> = { 1: 'primary', 4: 'success', 5: 'warning' }
  return map[type] ?? 'info'
}

const explainState = reactive<Record<string, { open: boolean; img: string; text: string; loading: boolean }>>({})
async function toggleExplain(item: QuestionItem) {
  const id = item.id
  if (!explainState[id]) explainState[id] = { open: false, img: '', text: '', loading: false }
  const st = explainState[id]
  st.open = !st.open
  if (st.open && !st.img && !st.text && !st.loading) {
    const own = (item as { explainImg?: string }).explainImg
    const ownText = (item as { explain?: string }).explain
    if (ownText) { st.text = ownText; return }
    if (own) { st.img = own; return }
    st.loading = true
    try {
      const res = await getQuestionDetail(id)
      const d = res as { explainImg?: string; explain?: string }
      st.text = d?.explain ?? ''
      st.img = d?.explainImg ?? ''
    } catch (e) {
      console.warn('[mf-fab] load explain failed', e)
      st.img = ''; st.text = ''
    } finally {
      st.loading = false
    }
  }
}

// 放大预览（复用 QuestionBasket 同款）
const previewVisible = ref(false)
const previewItem = ref<QuestionItem | null>(null)
const previewDetail = reactive<{
  answerImg: string; answerText: string; explainImg: string; explainText: string; loading: boolean
}>({ answerImg: '', answerText: '', explainImg: '', explainText: '', loading: false })

async function openPreview(item: QuestionItem) {
  previewItem.value = item
  previewDetail.answerImg = (item as { answerImg?: string }).answerImg ?? ''
  previewDetail.answerText = (item as { answer?: string }).answer ?? ''
  previewDetail.explainImg = (item as { explainImg?: string }).explainImg ?? ''
  previewDetail.explainText = (item as { explain?: string }).explain ?? ''
  previewVisible.value = true
  const needLoad = (!previewDetail.answerImg && !previewDetail.answerText)
    || (!previewDetail.explainImg && !previewDetail.explainText)
  if (needLoad) {
    previewDetail.loading = true
    try {
      const res = await getQuestionDetail(item.id)
      const d = res as { answerImg?: string; answer?: string; explainImg?: string; explain?: string }
      if (!previewDetail.answerImg) previewDetail.answerImg = d?.answerImg ?? ''
      if (!previewDetail.answerText) previewDetail.answerText = d?.answer ?? ''
      if (!previewDetail.explainImg) previewDetail.explainImg = d?.explainImg ?? ''
      if (!previewDetail.explainText) previewDetail.explainText = d?.explain ?? ''
    } catch (e) {
      console.warn('[mf-fab] load preview detail failed', e)
    } finally {
      previewDetail.loading = false
    }
  }
}

function handleClearQBasket() { qBasket.clear() }
function handleRemoveQ(id: string) { qBasket.remove(id) }
async function handleGoCompose() {
  if (qBasket.count.value === 0) { ElMessage.warning('试题栏为空，请先加题'); return }
  open.value = false
  await router.push('/question/compose')
}

// ── 试卷篮 tab：复用 usePaperBasket ──────────────────────────────
function handleRemoveP(id: string) { pBasket.remove(id) }
function goPaperWorkbench() {
  open.value = false
  router.push('/papers/basket')
}

// ── 可拖动（pointer + localStorage 记忆位置）────────────────────
const LS_POS = 'book-ui:mf-fab-pos'
const pos = reactive<{ right: number; bottom: number }>({ right: 32, bottom: 40 })
const dragging = ref(false)
const dragMoved = ref(false)
let startX = 0, startY = 0, startRight = 0, startBottom = 0

function loadPos() {
  try {
    const raw = localStorage.getItem(LS_POS)
    if (raw) {
      const p = JSON.parse(raw)
      if (typeof p.right === 'number' && typeof p.bottom === 'number') {
        pos.right = clampRight(p.right)
        pos.bottom = clampBottom(p.bottom)
      }
    }
  } catch { /* ignore */ }
}
function savePos() {
  try { localStorage.setItem(LS_POS, JSON.stringify({ right: pos.right, bottom: pos.bottom })) } catch { /* ignore */ }
}
function clampRight(r: number) { return Math.min(Math.max(r, 8), Math.max(window.innerWidth - 80, 8)) }
function clampBottom(b: number) { return Math.min(Math.max(b, 8), Math.max(window.innerHeight - 80, 8)) }

function onPointerDown(e: PointerEvent) {
  // 只允许在球本体上发起拖拽（hub 面板不拖）
  dragging.value = true
  dragMoved.value = false
  startX = e.clientX; startY = e.clientY
  startRight = pos.right; startBottom = pos.bottom
  ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
}
function onPointerMove(e: PointerEvent) {
  if (!dragging.value) return
  const dx = e.clientX - startX
  const dy = e.clientY - startY
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved.value = true
  pos.right = clampRight(startRight - dx)
  pos.bottom = clampBottom(startBottom - dy)
}
function onPointerUp(e: PointerEvent) {
  if (!dragging.value) return
  dragging.value = false
  ;(e.target as HTMLElement).releasePointerCapture?.(e.pointerId)
  if (dragMoved.value) savePos()
  // 抑制本次拖拽尾随的 click：下一帧清掉标志
  if (dragMoved.value) {
    setTimeout(() => { dragMoved.value = false }, 0)
  }
}

function onWindowResize() {
  pos.right = clampRight(pos.right)
  pos.bottom = clampBottom(pos.bottom)
}

// ── 生命周期 ──────────────────────────────────────────────────
onMounted(async () => {
  loadPos()
  window.addEventListener('ingest:job-submitted', onIngestJobSubmitted)
  window.addEventListener('resize', onWindowResize)
  await refreshJobs()
  scheduleNext()
})

onBeforeUnmount(() => {
  stopped = true
  if (timer) clearTimeout(timer)
  window.removeEventListener('ingest:job-submitted', onIngestJobSubmitted)
  window.removeEventListener('resize', onWindowResize)
  destroyBasketSortable()
})
</script>

<template>
  <div
    class="mf-root"
    :style="{ right: pos.right + 'px', bottom: pos.bottom + 'px' }"
  >
    <!-- ── hub 面板（展开态）── -->
    <transition name="mf-hub">
      <div v-if="open" class="mf-hub">
        <!-- 头部：快捷中枢 + ＋录入新题 + 收起 -->
        <div class="mf-hub-head">
          <span class="mf-hub-title">快捷中枢</span>
          <button class="mf-hub-add" @click="goIngest">
            <el-icon><Plus /></el-icon>录入新题
          </button>
          <span class="mf-hub-min" title="收起" @click="open = false">⌄</span>
        </div>

        <!-- 三 tab -->
        <div class="mf-hub-tabs">
          <button :class="{ on: activeTab === 'prog' }" @click="switchTab('prog')">
            进行中<span v-if="jobs.length" class="mf-tab-b">{{ activeJobCount || jobs.length }}</span>
          </button>
          <button :class="{ on: activeTab === 'bskt' }" @click="switchTab('bskt')">
            试题栏<span v-if="qBasket.count.value" class="mf-tab-b">{{ qBasket.count.value }}</span>
          </button>
          <button :class="{ on: activeTab === 'paper' }" @click="switchTab('paper')">
            试卷篮<span v-if="pBasket.count.value" class="mf-tab-b">{{ pBasket.count.value }}</span>
          </button>
        </div>

        <!-- 面板内容 -->
        <div class="mf-hub-body">
          <!-- ① 进行中 -->
          <div v-show="activeTab === 'prog'" class="mf-pane">
            <el-empty
              v-if="jobs.length === 0"
              :image-size="60"
              description="暂无拆题作业，点「＋录入新题」开始"
            />
            <el-scrollbar v-else max-height="360px">
              <div
                v-for="job in jobs"
                :key="job.id"
                class="mf-job"
                :class="{ 'mf-job--failed': job.status === 'FAILED' }"
              >
                <div class="mf-job-head">
                  <el-icon
                    class="mf-job-icon"
                    :class="`mf-job-icon--${statusTagType(job.status)}`"
                  >
                    <Loading v-if="ACTIVE_STATUS.has(job.status)" class="mf-spin" />
                    <CircleCheck v-else-if="job.status === 'DONE'" />
                    <Close v-else-if="job.status === 'FAILED'" />
                    <Tickets v-else />
                  </el-icon>
                  <span class="mf-job-name" :title="job.sourceFileName || ''">
                    {{ job.sourceFileName || '未命名文件' }}
                  </span>
                  <span class="mf-job-pct" :class="{ done: job.status === 'DONE' }">
                    {{ job.status === 'DONE' ? '已完成' : (job.status === 'FAILED' ? '失败' : jobProgress(job.status) + '%') }}
                  </span>
                </div>
                <div class="mf-job-meta">
                  {{ statusLabel(job.status) }} · 已拆 {{ job.questionCount ?? 0 }} 题
                  <span v-if="(job.committedCount ?? 0) > 0"> · 已入库 {{ job.committedCount }}</span>
                </div>
                <div class="mf-job-bar">
                  <i
                    :class="{ done: job.status === 'DONE', failed: job.status === 'FAILED' }"
                    :style="{ width: (job.status === 'FAILED' ? 100 : jobProgress(job.status)) + '%' }"
                  />
                </div>
                <div v-if="job.status === 'FAILED' && job.errorMsg" class="mf-job-err">
                  {{ job.errorMsg }}
                </div>
                <div class="mf-job-foot">
                  <el-button size="small" type="primary" link @click="goReview(job)">
                    去审核<el-icon><Right /></el-icon>
                  </el-button>
                </div>
              </div>
            </el-scrollbar>
          </div>

          <!-- ② 试题栏（复用 QuestionBasket 内容）-->
          <div v-show="activeTab === 'bskt'" class="mf-pane">
            <el-empty
              v-if="qBasket.items.value.length === 0"
              :image-size="60"
              description="试题栏为空，去题库加题"
            />
            <template v-else>
              <el-scrollbar max-height="320px">
                <div ref="listEl" class="mf-basket-list">
                  <div
                    v-for="item in qBasket.items.value"
                    :key="item.id"
                    class="basket-item"
                    :data-item-id="item.id"
                  >
                    <div class="basket-item-header">
                      <span
                        v-if="qBasket.items.value.length > 1"
                        class="drag-handle"
                        title="拖动调整顺序"
                      >
                        <el-icon><Rank /></el-icon>
                      </span>
                      <span class="type-tag" :class="`type-tag--${getQuestionTypeTag(item.questionType)}`">
                        {{ getQuestionTypeLabel(item.questionType) }}
                      </span>
                      <div class="basket-item-ops">
                        <el-button size="small" link type="primary" @click="openPreview(item)">
                          <el-icon><ZoomIn /></el-icon>放大
                        </el-button>
                        <el-button size="small" link @click="toggleExplain(item)">
                          {{ explainState[item.id]?.open ? '收起' : '解析' }}
                        </el-button>
                        <el-button size="small" link type="danger" @click="handleRemoveQ(item.id)">
                          <el-icon><Close /></el-icon>
                        </el-button>
                      </div>
                    </div>
                    <div class="basket-item-stem" style="cursor: zoom-in;" @click="openPreview(item)">
                      <QuestionContent
                        :text="item.stemText"
                        :img-url="item.stemImg"
                        alt="题干（点击放大）"
                        img-max-height="96px"
                      />
                    </div>
                    <div v-if="explainState[item.id]?.open" class="basket-item-explain">
                      <el-skeleton v-if="explainState[item.id]?.loading" :rows="2" animated />
                      <template v-else>
                        <QuestionContent
                          v-if="explainState[item.id]?.img || explainState[item.id]?.text"
                          :text="explainState[item.id]?.text || null"
                          :img-url="explainState[item.id]?.img || null"
                          alt="解析"
                        />
                        <span v-else class="basket-explain-empty">暂无解析</span>
                      </template>
                    </div>
                  </div>
                </div>
              </el-scrollbar>
              <div class="mf-pane-foot">
                <el-button size="small" :disabled="qBasket.items.value.length === 0" @click="handleClearQBasket">
                  <el-icon><Delete /></el-icon>清空
                </el-button>
                <span class="mf-foot-sp" />
                <el-button
                  size="small"
                  type="primary"
                  :disabled="qBasket.items.value.length === 0"
                  class="mf-compose-btn"
                  @click="handleGoCompose"
                >
                  <el-icon><DocumentAdd /></el-icon>组卷（{{ qBasket.items.value.length }} 题）
                </el-button>
              </div>
            </template>
          </div>

          <!-- ③ 试卷篮（复用 PaperBasketFab 的篮 + usePaperBasket）-->
          <div v-show="activeTab === 'paper'" class="mf-pane">
            <el-empty
              v-if="pBasket.items.value.length === 0"
              :image-size="60"
              description="试卷篮为空，去卷库加卷"
            />
            <template v-else>
              <el-scrollbar max-height="320px">
                <div class="mf-paper-list">
                  <div
                    v-for="paper in pBasket.items.value"
                    :key="paper.id"
                    class="mf-paper-item"
                  >
                    <el-icon class="mf-paper-icon"><Tickets /></el-icon>
                    <span class="mf-paper-name" :title="paper.name">{{ paper.name }}</span>
                    <span class="mf-paper-meta">{{ paper.questionCount ?? 0 }} 题</span>
                    <span class="mf-paper-rm" title="移除" @click="handleRemoveP(paper.id)">
                      <el-icon><Close /></el-icon>
                    </span>
                  </div>
                </div>
              </el-scrollbar>
              <div class="mf-pane-foot">
                <span class="mf-foot-sp" />
                <el-button size="small" type="primary" class="mf-compose-btn" @click="goPaperWorkbench">
                  <el-icon><DocumentAdd /></el-icon>去组卷工作台
                </el-button>
              </div>
            </template>
          </div>
        </div>
      </div>
    </transition>

    <!-- ── 多功能球本体 ── -->
    <div class="mf-fab" :class="{ dragging }">
      <el-badge
        :value="totalBadge > 99 ? '99+' : totalBadge"
        :hidden="totalBadge === 0"
        :offset="[-6, 6]"
        type="danger"
      >
        <div
          class="mf-ball"
          :class="`mf-ball--${ballState.mode}`"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @click="onBallClick"
        >
          <!-- 进度环（处理中 / 完成态显示）-->
          <svg
            v-if="ballState.mode === 'processing' || ballState.mode === 'done'"
            class="mf-ring"
            viewBox="0 0 64 64"
          >
            <circle class="mf-ring-bg" cx="32" cy="32" r="28" />
            <circle
              class="mf-ring-fg"
              cx="32" cy="32" r="28"
              :stroke-dasharray="RING_CIRC"
              :stroke-dashoffset="ringOffset"
            />
          </svg>
          <!-- 球心内容（按优先级）-->
          <div class="mf-ball-core">
            <template v-if="ballState.mode === 'processing'">
              <span class="mf-core-pct">{{ ballState.pct }}%</span>
              <span class="mf-core-lbl">{{ ballState.label }}</span>
            </template>
            <template v-else-if="ballState.mode === 'done'">
              <el-icon :size="26"><CircleCheck /></el-icon>
            </template>
            <template v-else-if="ballState.mode === 'question'">
              <el-icon :size="20"><ShoppingCart /></el-icon>
              <span class="mf-core-lbl">试题栏</span>
            </template>
            <template v-else-if="ballState.mode === 'paper'">
              <el-icon :size="20"><Tickets /></el-icon>
              <span class="mf-core-lbl">试卷篮</span>
            </template>
            <template v-else>
              <el-icon :size="24"><MenuIcon /></el-icon>
            </template>
          </div>
        </div>
      </el-badge>
    </div>

    <!-- ── 放大预览 dialog（复用 QuestionCard）── -->
    <el-dialog
      v-model="previewVisible"
      width="760px"
      style="max-width: 94vw"
      :close-on-click-modal="true"
      class="mf-preview-dialog"
      append-to-body
    >
      <template #header>
        <div class="mf-preview-header">
          <el-icon color="#0FB488" :size="18"><ZoomIn /></el-icon>
          <span class="mf-preview-title">题目预览</span>
        </div>
      </template>
      <div v-if="previewItem" class="mf-preview-body">
        <QuestionCard :question="previewItem" :actions="[]" />
        <div class="mf-preview-detail">
          <el-skeleton v-if="previewDetail.loading" :rows="3" animated />
          <template v-else>
            <div v-if="previewDetail.answerImg || previewDetail.answerText" class="mf-preview-block">
              <span class="mf-preview-label">【答案】</span>
              <QuestionContent
                :text="previewDetail.answerText || null"
                :img-url="previewDetail.answerImg || null"
                alt="答案"
              />
            </div>
            <div v-if="previewDetail.explainImg || previewDetail.explainText" class="mf-preview-block">
              <span class="mf-preview-label">【解析】</span>
              <QuestionContent
                :text="previewDetail.explainText || null"
                :img-url="previewDetail.explainImg || null"
                alt="解析"
              />
            </div>
            <span
              v-if="!previewDetail.answerImg && !previewDetail.answerText && !previewDetail.explainImg && !previewDetail.explainText"
              class="mf-preview-empty"
            >暂无答案 / 解析</span>
          </template>
        </div>
      </div>
      <template #footer>
        <el-button @click="previewVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* ── 根容器（fixed，随拖拽改 right/bottom）── */
.mf-root {
  position: fixed;
  z-index: 200;
  line-height: 0;
}

/* ── 多功能球 ── */
.mf-fab {
  position: relative;
}
.mf-fab.dragging {
  cursor: grabbing;
}

.mf-ball {
  position: relative;
  width: 64px;
  height: 64px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  touch-action: none;
  user-select: none;
  /* 薄荷主色（DESIGN.md mint #0FB488） */
  background: linear-gradient(135deg, #19c89a, #0fb488);
  box-shadow: 0 8px 24px rgba(15, 180, 136, 0.4);
  transition: box-shadow 0.25s ease, transform 0.25s ease;
}
.mf-ball:hover {
  transform: translateY(-3px);
  box-shadow: 0 12px 32px rgba(15, 180, 136, 0.5);
}
.mf-ball:active {
  cursor: grabbing;
}

/* 处理中态：脉冲 */
.mf-ball--processing {
  animation: mf-pulse 2s infinite;
}
@keyframes mf-pulse {
  0%, 100% { box-shadow: 0 8px 24px rgba(15, 180, 136, 0.4); }
  50% { box-shadow: 0 8px 30px rgba(15, 180, 136, 0.65); }
}
/* 完成态：琥珀绿 */
.mf-ball--done {
  background: linear-gradient(135deg, #2bb673, #1e9e6e);
}

/* 进度环 */
.mf-ring {
  position: absolute;
  inset: 0;
  width: 64px;
  height: 64px;
  transform: rotate(-90deg);
}
.mf-ring-bg {
  fill: none;
  stroke: rgba(255, 255, 255, 0.25);
  stroke-width: 4;
}
.mf-ring-fg {
  fill: none;
  stroke: #ffffff;
  stroke-width: 4;
  stroke-linecap: round;
  transition: stroke-dashoffset 0.4s ease;
}

/* 球心 */
.mf-ball-core {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  color: #fff;
  z-index: 1;
}
.mf-core-pct {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.2px;
  font-family: 'Space Mono', monospace;
}
.mf-core-lbl {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.3px;
}

/* ── hub 面板 ── */
.mf-hub {
  position: absolute;
  right: 0;
  bottom: 76px;
  width: 340px;
  max-width: 86vw;
  background: #ffffff;
  border: 1px solid #e3ece9;
  border-radius: 14px;
  box-shadow: 0 12px 40px rgba(15, 60, 50, 0.16);
  overflow: hidden;
  line-height: normal;
}

.mf-hub-enter-active, .mf-hub-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
  transform-origin: bottom right;
}
.mf-hub-enter-from, .mf-hub-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.96);
}

.mf-hub-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid #eef3f1;
}
.mf-hub-title {
  font-size: 14px;
  font-weight: 700;
  color: #1d2a2e;
  flex-shrink: 0;
}
.mf-hub-add {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  border-radius: 8px;
  padding: 5px 11px;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  cursor: pointer;
  background: linear-gradient(135deg, #19c89a, #0fb488);
  box-shadow: 0 2px 8px rgba(15, 180, 136, 0.3);
  transition: all 0.2s;
}
.mf-hub-add:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(15, 180, 136, 0.45);
}
.mf-hub-min {
  cursor: pointer;
  font-size: 18px;
  color: #9dafad;
  line-height: 1;
  padding: 0 2px;
  user-select: none;
}
.mf-hub-min:hover { color: #0fb488; }

/* tabs */
.mf-hub-tabs {
  display: flex;
  padding: 8px 10px 0;
  gap: 4px;
  border-bottom: 1px solid #eef3f1;
}
.mf-hub-tabs button {
  flex: 1;
  border: none;
  background: transparent;
  padding: 8px 4px 10px;
  font-size: 13px;
  font-weight: 600;
  color: #6b7b78;
  cursor: pointer;
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  transition: color 0.15s;
}
.mf-hub-tabs button:hover { color: #0fb488; }
.mf-hub-tabs button.on { color: #0fb488; }
.mf-hub-tabs button.on::after {
  content: '';
  position: absolute;
  left: 18%;
  right: 18%;
  bottom: -1px;
  height: 2px;
  border-radius: 2px;
  background: #0fb488;
}
.mf-tab-b {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: #e6f7f1;
  color: #0a8e6a;
  font-size: 11px;
  font-weight: 700;
}
.mf-hub-tabs button.on .mf-tab-b {
  background: #0fb488;
  color: #fff;
}

.mf-hub-body {
  padding: 12px 14px;
}
.mf-pane {
  min-height: 80px;
}

/* ── 进行中作业卡 ── */
.mf-job {
  border: 1px solid #ebf1ef;
  border-radius: 10px;
  padding: 10px 12px;
  background: #fafdfc;
  margin-bottom: 10px;
}
.mf-job:last-child { margin-bottom: 0; }
.mf-job--failed {
  border-color: #fbcccc;
  background: #fff8f8;
}
.mf-job-head {
  display: flex;
  align-items: center;
  gap: 7px;
}
.mf-job-icon { flex-shrink: 0; font-size: 15px; }
.mf-job-icon--success { color: #1e9e6e; }
.mf-job-icon--danger { color: #f56c6c; }
.mf-job-icon--warning { color: #c47d0e; }
.mf-job-icon--info { color: #909399; }
.mf-spin { animation: mf-spin 1.1s linear infinite; }
@keyframes mf-spin { to { transform: rotate(360deg); } }
.mf-job-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: #1d2a2e;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mf-job-pct {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 700;
  color: #c47d0e;
  font-family: 'Space Mono', monospace;
}
.mf-job-pct.done { color: #1e9e6e; }
.mf-job-meta {
  margin-top: 6px;
  font-size: 12px;
  color: #86909c;
}
.mf-job-bar {
  margin-top: 7px;
  height: 5px;
  border-radius: 3px;
  background: #eef3f1;
  overflow: hidden;
}
.mf-job-bar i {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(90deg, #19c89a, #0fb488);
  transition: width 0.4s ease;
}
.mf-job-bar i.done { background: #1e9e6e; }
.mf-job-bar i.failed { background: #f56c6c; }
.mf-job-err {
  margin-top: 7px;
  font-size: 12px;
  color: #f56c6c;
  background: #fff0f0;
  border-radius: 6px;
  padding: 6px 8px;
  word-break: break-word;
}
.mf-job-foot {
  margin-top: 6px;
  display: flex;
  justify-content: flex-end;
}

/* ── 试题栏列表（复刻 QuestionBasket 样式，缩窄）── */
.mf-basket-list { padding: 0 2px; }
.basket-item {
  padding: 9px 0;
  border-bottom: 1px solid #eef3f1;
}
.basket-item:last-child { border-bottom: none; }
.basket-item-header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 5px;
}
.drag-handle {
  display: inline-flex;
  align-items: center;
  color: #9dafad;
  cursor: grab;
  padding: 0 2px;
  flex-shrink: 0;
  touch-action: none;
  user-select: none;
  transition: color 0.15s;
}
.drag-handle:hover { color: #0fb488; }
.drag-handle:active { cursor: grabbing; }
.basket-item-ghost { opacity: 0.4; background: #f2faf7; }
.basket-item-chosen {
  box-shadow: 0 2px 6px rgba(15, 80, 60, 0.05), 0 12px 28px -12px rgba(15, 80, 60, 0.16);
  background: #fff;
}
.basket-item-ops {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
}
.basket-item-stem {
  font-size: 13px;
  color: #303133;
  padding-left: 2px;
}
.basket-item-explain {
  margin-top: 7px;
  padding: 7px 9px;
  background: #f7fbfa;
  border-radius: 6px;
}
.basket-explain-empty { font-size: 12px; color: #c9cdd4; }

.type-tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
}
.type-tag--primary { background: #e6f7f1; color: #0a8e6a; }
.type-tag--success { background: #e6f9f2; color: #1e9e6e; }
.type-tag--warning { background: #fff6e5; color: #c47d0e; }
.type-tag--info { background: #f2f3f5; color: #86909c; }
.type-tag--danger { background: #ffece8; color: #f56c6c; }

/* ── 试卷篮列表 ── */
.mf-paper-list { display: flex; flex-direction: column; gap: 8px; padding: 2px; }
.mf-paper-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 11px;
  border: 1px solid #ebf1ef;
  border-radius: 9px;
  background: #fafdfc;
}
.mf-paper-icon { color: #0fb488; flex-shrink: 0; }
.mf-paper-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: #1d2a2e;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mf-paper-meta { font-size: 12px; color: #86909c; flex-shrink: 0; }
.mf-paper-rm {
  flex-shrink: 0;
  cursor: pointer;
  color: #c0c8c5;
  display: inline-flex;
  transition: color 0.15s;
}
.mf-paper-rm:hover { color: #f56c6c; }

/* ── 面板 footer ── */
.mf-pane-foot {
  display: flex;
  align-items: center;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid #eef3f1;
  gap: 8px;
}
.mf-foot-sp { flex: 1; }
.mf-compose-btn {
  background: linear-gradient(135deg, #19c89a, #0fb488);
  border: none;
  box-shadow: 0 2px 6px rgba(15, 180, 136, 0.3);
}
.mf-compose-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(15, 180, 136, 0.45);
}

/* ── 预览 dialog ── */
.mf-preview-header { display: flex; align-items: center; gap: 8px; }
.mf-preview-title { font-size: 16px; font-weight: 700; color: #1d2a2e; }
.mf-preview-body { max-height: 70vh; overflow-y: auto; }
.mf-preview-detail { margin-top: 8px; }
.mf-preview-block {
  margin-top: 12px;
  padding: 10px 12px;
  background: #f2faf7;
  border-left: 3px solid #0fb488;
  border-radius: 6px;
}
.mf-preview-label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: #1d2a2e;
  margin-bottom: 6px;
}
.mf-preview-empty { font-size: 13px; color: #a6b2b6; }
</style>
