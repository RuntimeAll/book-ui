<script setup lang="ts">
/**
 * PRD-013 批2 — 每日打卡书「阅读 + 人眼审核」页。
 *
 * 打卡内容 = 一本有结构的书（book_type=daily_punch，天=节点，模块=item）。本页 = 审核壳包纸：
 *   左  目录：第 N 天 + 审核角标（✓通过 / ⚠N个问题 / ○未审）+ 题量（FP2）
 *   顶  书名 + 每日打卡 tag + 「已审 N/M 天」进度 + 问题清单 + 导出本书（FP1/FP3/FP9/FP10）
 *       —— 导出本书 = 一次 POST /teacher/punch/exportBook（BE 整书合并端点），每种卷出
 *          **一份全册 PDF**；逐天串行出 N×2 个散链接的老做法已下线（「导出本天」仍在）。
 *   条  第 N 天 + 状态 chip + 题目卷⇄解析卷 + 通过本天 / 记问题 / 修改本天 / 导出本天（FP6′/FP8）
 *   中  纸面 = iframe srcdoc 吃 BE /teacher/punch/preview 的 HTML（punch-v1 主题，与导出 PDF
 *       同 theme 同 data）——🔴 FE 零渲染器：所见即所得（D3/G9），没有第二套渲染。
 *
 * 改字分级（D10/D11）：
 *   FP11a 计算题（content_json，本书私有）→「修改本天」面板题面/答案成对输入 → 原样 upsertDay 整天重灌 → 重渲
 *   FP11b 题库题（block_json，全库共享）→ 本页**只读**，只给「在题库中修改」跳题目编辑态 + 影响面提示
 *   🔴 禁 contenteditable 改 iframe 内容（纸面是 BE 渲的，改屏不改数据 = 假绿）
 *
 * 设计稿正本 = prd/PRD-013/artifacts/设计稿/打卡书审核页-v4题块复用.html（布局/配色）
 *              + 打卡书审核页-v1.html（FP1-FP4/FP8-FP10 交互标注）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { getBook } from '@/api/shelf'
import {
  getPunchDays,
  getPunchDay,
  previewPunchDay,
  exportPunchDay,
  exportPunchBook,
  getPunchBookExportStatus,
  upsertPunchDay,
  submitPunchReview,
  stripModuleItemIds,
  punchModuleLabel,
  PUNCH_ISSUE_KINDS,
  type PunchBookExportState,
  type PunchDayBrief,
  type PunchDayDetail,
  type PunchIssue,
  type PunchModule,
  type PunchPaper,
  type PunchReview,
} from '@/api/teacher/punch'

const route = useRoute()
const router = useRouter()
const bookId = String(route.params.bookId)

/** A4 纸宽（96dpi 下 210mm ≈ 794px）—— punch-v1 主题 html/body 固定 210mm。 */
const PAPER_W = 794
const PAPER_H_DEFAULT = 1123

// ═══════════════════════════════════════════════════════════════════════════
// 一、书 + 目录
// ═══════════════════════════════════════════════════════════════════════════
const bookTitle = ref('')
/**
 * 书级审定标记（style_meta.punchReview.passed，BE 每次 review 后重算）。
 * 展示以目录「各天全 passed」实时判定为准（bookAudited），这里留 BE 侧真值做交叉校验/排障。
 */
const bookPunchPassed = ref(false)
const days = ref<PunchDayBrief[]>([])
const daysLoading = ref(false)
/** 当前天（URL query 同步，刷新/回退不丢位置）。 */
const curDay = ref<number>(Number(route.query.day) || 0)
/** 卷种：题目卷 / 解析卷（FP6′）。 */
const paper = ref<PunchPaper>(route.query.paper === 'answer' ? 'answer' : 'question')

const passedCount = computed(() => days.value.filter((d) => d.review?.status === 'passed').length)
/**
 * 全书审定 = 各天全 passed（目录到手后前端实时判定）；
 * 目录未就绪时回落 BE 落库的书级标记 style_meta.punchReview.passed。
 */
const bookAudited = computed(() =>
  days.value.length > 0 ? passedCount.value === days.value.length : bookPunchPassed.value,
)
const curDayBrief = computed(() => days.value.find((d) => d.day === curDay.value) ?? null)
const curStatus = computed(() => String(curDayBrief.value?.review?.status ?? 'pending'))

const STATUS_LABEL: Record<string, string> = {
  pending: '未审核',
  passed: '已通过',
  issue: '有问题',
}
function statusLabel(s: string | undefined): string {
  return STATUS_LABEL[String(s ?? 'pending')] ?? String(s)
}

async function loadBook() {
  try {
    const b = await getBook(bookId)
    bookTitle.value = b?.title ?? ''
    const pr = (b?.styleMeta as Record<string, unknown> | null)?.punchReview as
      | { passed?: boolean }
      | undefined
    bookPunchPassed.value = !!pr?.passed
  } catch {
    /* 标题非关键，静默（http 拦截器已弹错） */
  }
}

async function loadDays(keepDay = true) {
  daysLoading.value = true
  try {
    const res = await getPunchDays(bookId)
    days.value = (res?.days ?? []).map((d) => ({
      ...d,
      day: Number(d.day),
      itemCount: Number(d.itemCount ?? 0),
      review: { status: String(d.review?.status ?? 'pending'), issueCount: Number(d.review?.issueCount ?? 0) },
    }))
    // 首进 / 当前天已不存在 → 落到第一天
    if (!keepDay || !days.value.some((d) => d.day === curDay.value)) {
      curDay.value = days.value.length ? days.value[0].day : 0
    }
  } catch {
    days.value = []
  } finally {
    daysLoading.value = false
  }
}

function pickDay(d: number) {
  if (d === curDay.value) return
  curDay.value = d
}

// ═══════════════════════════════════════════════════════════════════════════
// 二、纸面（iframe srcdoc = BE preview HTML；切天/切卷种重新拉）
// ═══════════════════════════════════════════════════════════════════════════
const previewHtml = ref('')
const previewLoading = ref(false)
const previewError = ref('')
/** 竞态令牌：切天/切卷种快点时丢弃过期响应。 */
let previewToken = 0

async function loadPreview() {
  if (!curDay.value) {
    previewHtml.value = ''
    return
  }
  const token = ++previewToken
  previewLoading.value = true
  previewError.value = ''
  try {
    const res = await previewPunchDay(bookId, curDay.value, paper.value)
    if (token !== previewToken) return
    previewHtml.value = res?.html ?? ''
    if (!previewHtml.value) previewError.value = '纸面 HTML 为空'
    paperH.value = PAPER_H_DEFAULT
  } catch (e: unknown) {
    if (token !== previewToken) return
    previewHtml.value = ''
    previewError.value = (e as { message?: string })?.message || '纸面渲染失败'
  } finally {
    if (token === previewToken) previewLoading.value = false
  }
}

// —— 等比缩放适配容器宽（画布灰底 + 纸面居中，对齐 v4 设计稿）——
const canvasRef = ref<HTMLElement | null>(null)
const frameRef = ref<HTMLIFrameElement | null>(null)
const canvasW = ref(0)
const paperH = ref(PAPER_H_DEFAULT)
/** 不放大只缩小（纸面 1:1 是上限，放大会糊）。 */
const scale = computed(() => {
  if (!canvasW.value) return 1
  return Math.min(1, canvasW.value / PAPER_W)
})
const boxW = computed(() => Math.round(PAPER_W * scale.value))
const boxH = computed(() => Math.round(paperH.value * scale.value))

let ro: ResizeObserver | null = null
function observeCanvas() {
  if (!canvasRef.value || typeof ResizeObserver === 'undefined') return
  ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      // 画布左右各留 30px 余白（对齐设计稿 canvas padding）
      canvasW.value = Math.max(0, e.contentRect.width - 60)
    }
  })
  ro.observe(canvasRef.value)
}

/** iframe 载入后按真实内容高度校正纸高（多页纸不被截断）。 */
function onFrameLoad() {
  try {
    const doc = frameRef.value?.contentDocument
    if (!doc) return
    const h = Math.max(
      doc.documentElement?.scrollHeight ?? 0,
      doc.body?.scrollHeight ?? 0,
      PAPER_H_DEFAULT,
    )
    paperH.value = h
  } catch {
    /* 跨域理论上不会发生（srcdoc 同源），兜底保持默认高度 */
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 三、天详情缓存（问题清单聚合 / 修改本天 / 销账回写都要原文）
// ═══════════════════════════════════════════════════════════════════════════
const dayCache = ref<Record<number, PunchDayDetail>>({})

async function fetchDayDetail(day: number, force = false): Promise<PunchDayDetail | null> {
  if (!force && dayCache.value[day]) return dayCache.value[day]
  try {
    const d = await getPunchDay(bookId, day)
    if (d) {
      dayCache.value = { ...dayCache.value, [day]: d }
      return d
    }
  } catch {
    /* http 拦截器已弹错 */
  }
  return null
}

/** 当前天目标（今日目标条 FP4，纸面里也有；壳里再列一份方便审核时对照）。 */
const curGoals = computed<string[]>(() => dayCache.value[curDay.value]?.goals ?? [])

// ═══════════════════════════════════════════════════════════════════════════
// 四、审核：通过本天 / 记问题 / 重审
// ═══════════════════════════════════════════════════════════════════════════
const reviewing = ref(false)

/** 局部刷新目录角标（不重拉整页）。 */
function patchDayBrief(day: number, status: string, issueCount: number) {
  days.value = days.value.map((d) =>
    d.day === day ? { ...d, review: { status, issueCount } } : d,
  )
}
function openIssueCountOf(review: { issues?: PunchIssue[] } | null | undefined): number {
  return (review?.issues ?? []).filter((i) => !i.resolved).length
}
/** 审核动作回包里的最新 review 写回天详情缓存（缓存没这天就跳过，别造半截对象）。 */
function patchDayCacheReview(day: number, review: PunchReview | undefined) {
  const cached = dayCache.value[day]
  if (!cached || !review) return
  dayCache.value = { ...dayCache.value, [day]: { ...cached, review } }
}

async function onPassDay() {
  if (!curDay.value) return
  reviewing.value = true
  try {
    const res = await submitPunchReview(bookId, curDay.value, 'pass')
    patchDayBrief(curDay.value, 'passed', openIssueCountOf(res?.review))
    patchDayCacheReview(curDay.value, res?.review)
    bookPunchPassed.value = !!res?.bookPassed
    ElMessage.success(
      res?.bookPassed ? `第 ${curDay.value} 天已通过 —— 全书已审定 🎉` : `第 ${curDay.value} 天已通过`,
    )
    // 自动翻下一未审天（连审顺手）
    const next = days.value.find((d) => d.day > curDay.value && d.review.status !== 'passed')
    if (next) pickDay(next.day)
  } catch {
    /* http 拦截器已弹错 */
  } finally {
    reviewing.value = false
  }
}

async function onReopenDay(day: number) {
  reviewing.value = true
  try {
    const res = await submitPunchReview(bookId, day, 'reopen')
    patchDayBrief(day, 'pending', openIssueCountOf(res?.review))
    bookPunchPassed.value = !!res?.bookPassed
    ElMessage.success(`第 ${day} 天已置为待审`)
  } catch {
    /* http 拦截器已弹错 */
  } finally {
    reviewing.value = false
  }
}

// —— 记问题面板（FP8）——
const issueDialogVisible = ref(false)
const issueSubmitting = ref(false)
const issueForm = ref<{ module: string; seq: number | null; kind: string; note: string }>({
  module: 'oral',
  seq: null,
  kind: PUNCH_ISSUE_KINDS[0],
  note: '',
})
/** 模块下拉选项 = 当天真有的模块（无详情时回落四类全集）。 */
const moduleOptions = computed<{ value: string; label: string }[]>(() => {
  const mods = dayCache.value[curDay.value]?.modules ?? []
  const list = mods.length
    ? mods.map((m) => String(m.type))
    : ['oral', 'vertical', 'stepwise', 'rotating']
  return [...new Set(list)].map((t) => ({ value: t, label: punchModuleLabel(t) }))
})

async function openIssueDialog() {
  if (!curDay.value) return
  await fetchDayDetail(curDay.value)
  const first = moduleOptions.value[0]?.value ?? 'oral'
  issueForm.value = { module: first, seq: null, kind: PUNCH_ISSUE_KINDS[0], note: '' }
  issueDialogVisible.value = true
}

async function submitIssue() {
  const f = issueForm.value
  if (!f.module) {
    ElMessage.warning('请选择模块')
    return
  }
  if (!f.note.trim()) {
    ElMessage.warning('请填写问题描述')
    return
  }
  issueSubmitting.value = true
  try {
    const res = await submitPunchReview(bookId, curDay.value, 'issue', [
      { module: f.module, seq: f.seq ?? null, kind: f.kind, note: f.note.trim(), resolved: false },
    ])
    patchDayBrief(curDay.value, 'issue', openIssueCountOf(res?.review))
    patchDayCacheReview(curDay.value, res?.review)
    bookPunchPassed.value = !!res?.bookPassed
    issueDialogVisible.value = false
    ElMessage.success('已记录问题')
    if (issuesDrawerVisible.value) void loadAllIssues()
  } catch {
    /* http 拦截器已弹错 */
  } finally {
    issueSubmitting.value = false
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 五、问题清单抽屉（FP9）—— 全书各天 issues 汇总（days + day 接口聚合）
// ═══════════════════════════════════════════════════════════════════════════
const issuesDrawerVisible = ref(false)
const issuesLoading = ref(false)
interface FlatIssue extends PunchIssue {
  day: number
  idx: number
}
const allIssues = ref<FlatIssue[]>([])
/** 顶栏角标：目录接口已带各天未销账数，免整页聚合即可显示。 */
const openIssueTotal = computed(() =>
  days.value.reduce((s, d) => s + Number(d.review?.issueCount ?? 0), 0),
)
const showResolved = ref(true)
const shownIssues = computed(() =>
  showResolved.value ? allIssues.value : allIssues.value.filter((i) => !i.resolved),
)

/** 只拉「目录说有问题」的天（issueCount>0 或 status=issue，或已 resolved 过的天需回看 → 全量兜底）。 */
async function loadAllIssues() {
  issuesLoading.value = true
  try {
    const targets = days.value.map((d) => d.day)
    const out: FlatIssue[] = []
    // 限并发 4，逐天取原文聚合
    let i = 0
    const worker = async () => {
      while (i < targets.length) {
        const day = targets[i++]
        const detail = await fetchDayDetail(day, true)
        const list = detail?.review?.issues ?? []
        list.forEach((it, idx) => out.push({ ...it, day, idx }))
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker))
    allIssues.value = out.sort((a, b) => a.day - b.day || a.idx - b.idx)
  } finally {
    issuesLoading.value = false
  }
}

async function openIssuesDrawer() {
  issuesDrawerVisible.value = true
  await loadAllIssues()
}

/**
 * 销账（G6）：把该天问题清单里这一条置 resolved=true 后整体回写。
 * 🔴 走 action=reopen —— 修完销账语义就是「重新待审」，天状态回 pending 等复审
 *    （BE review 只有 pass/issue/reopen 三动作，reopen 是唯一"改清单但不判通过"的口子）。
 */
const resolvingKey = ref('')
async function toggleResolved(it: FlatIssue) {
  const detail = dayCache.value[it.day]
  if (!detail) {
    ElMessage.warning('该天原文未就绪，请重开清单')
    return
  }
  const key = `${it.day}-${it.idx}`
  resolvingKey.value = key
  try {
    const next = (detail.review?.issues ?? []).map((x, idx) =>
      idx === it.idx ? { ...x, resolved: !it.resolved } : x,
    )
    const res = await submitPunchReview(bookId, it.day, 'reopen', next)
    patchDayBrief(it.day, 'pending', openIssueCountOf(res?.review))
    dayCache.value = {
      ...dayCache.value,
      [it.day]: { ...detail, review: res?.review ?? { ...detail.review, issues: next } },
    }
    bookPunchPassed.value = !!res?.bookPassed
    await loadAllIssues()
    ElMessage.success(it.resolved ? '已取消销账（该天待重审）' : '已销账（该天待重审）')
  } catch {
    /* http 拦截器已弹错 */
  } finally {
    resolvingKey.value = ''
  }
}

function gotoIssueDay(it: FlatIssue) {
  pickDay(it.day)
  issuesDrawerVisible.value = false
}

// ═══════════════════════════════════════════════════════════════════════════
// 六、修改本天（FP11a 计算题就地改 / FP11b 题库题只读跳详情）
// ═══════════════════════════════════════════════════════════════════════════
const editDrawerVisible = ref(false)
const editLoading = ref(false)
const editSaving = ref(false)
/** 编辑草稿：直接改 modules 的深拷贝，保存 = 原样 upsertDay 整天重灌。 */
const editGoals = ref<string[]>([])
const editModules = ref<PunchModule[]>([])

/** 计算模块（可改）与轮换位（只读）分栏。 */
const editCalcModules = computed(() => editModules.value.filter((m) => m.type !== 'rotating'))
const editRotating = computed(() => editModules.value.find((m) => m.type === 'rotating') ?? null)

async function openEditDrawer() {
  if (!curDay.value) return
  editDrawerVisible.value = true
  editLoading.value = true
  try {
    const detail = await fetchDayDetail(curDay.value, true)
    editGoals.value = [...(detail?.goals ?? [])]
    editModules.value = JSON.parse(JSON.stringify(detail?.modules ?? [])) as PunchModule[]
  } finally {
    editLoading.value = false
  }
}

function addGoal() {
  editGoals.value = [...editGoals.value, '']
}
function removeGoal(idx: number) {
  editGoals.value = editGoals.value.filter((_, i) => i !== idx)
}

/** FP11b：题库题跳题目编辑态（正式编辑流程，带确认与留痕）——新页签开，本页不丢位置。 */
function gotoQuestionEditor(qid: string) {
  window.open(router.resolve(`/question/editor/${qid}`).href, '_blank')
}

async function saveEdit() {
  if (!curDay.value) return
  const goals = editGoals.value.map((g) => g.trim()).filter(Boolean)
  // 🔴 itemId 是 BE 组数据时挂的定位键，回传前剔除（BE 也会剔，两头都净）
  const modules = stripModuleItemIds(editModules.value)
  editSaving.value = true
  try {
    await upsertPunchDay(bookId, curDay.value, goals, modules)
    // 内容变了 → BE 把该天 review 重置 pending；目录与纸面一并刷新
    await Promise.all([fetchDayDetail(curDay.value, true), loadDays()])
    patchDayBrief(curDay.value, 'pending', openIssueCountOf(dayCache.value[curDay.value]?.review))
    await loadPreview()
    editDrawerVisible.value = false
    ElMessage.success('已保存并重新渲染（本天审核状态已重置为待审）')
  } catch {
    /* http 拦截器已弹错 */
  } finally {
    editSaving.value = false
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 七、导出（FP10）
// ═══════════════════════════════════════════════════════════════════════════
const exporting = ref(false)
const exportDialogVisible = ref(false)
const exportPapers = ref<PunchPaper[]>(['question', 'answer'])
/**
 * 整册导出状态（BE style_meta.punchExport 持久化态镜像）：
 * null=从未导过 / running=后台渲染中（轮询跟进）/ done=有全册链接 / failed=可重试。
 * 🔴 换页/重开弹窗都从 BE 拉真态，不靠本地内存——异步导出的进度在服务端。
 */
const exportState = ref<PunchBookExportState | null>(null)
const exportErr = ref('')
let exportPollTimer: ReturnType<typeof setInterval> | null = null

const exportRunning = computed(() => exportState.value?.status === 'running')
const exportDone = computed(() => exportState.value?.status === 'done')

async function onExportDay() {
  if (!curDay.value) return
  exporting.value = true
  try {
    const res = await exportPunchDay(bookId, curDay.value)
    const urls = [res?.questionUrl, res?.answerUrl].filter(Boolean) as string[]
    if (!urls.length) {
      ElMessage.warning('导出未返回文件地址')
      return
    }
    for (const u of urls) window.open(u, '_blank')
    ElMessage.success(`第 ${curDay.value} 天已导出（${urls.length} 份 PDF）`)
  } catch {
    /* http 拦截器已弹错 */
  } finally {
    exporting.value = false
  }
}

async function openExportBook() {
  if (!days.value.length) {
    ElMessage.warning('本书还没有内容')
    return
  }
  exportPapers.value = ['question', 'answer']
  exportErr.value = ''
  exportDialogVisible.value = true
  // 打开即拉服务端真态：上次导好的全册直接可下；后台在跑则接上轮询
  try {
    const res = await getPunchBookExportStatus(bookId)
    exportState.value = res?.export ?? null
    if (exportRunning.value) startExportPoll()
  } catch {
    /* http 拦截器已弹错 */
  }
}

/**
 * 整册导出 v2 = 异步提交 + 轮询（BE worker 后台逐天渲染合并，结果覆盖写
 * style_meta.punchExport 持久化）。提交立即返回 running，本页每 5s 轮询到 done/failed；
 * 中途关弹窗/换页不影响后台任务，回来重开弹窗即见结果。
 */
async function runExportBook() {
  if (!exportPapers.value.length) {
    ElMessage.warning('请至少选一种卷')
    return
  }
  exportErr.value = ''
  try {
    const res = await exportPunchBook(bookId, exportPapers.value)
    exportState.value = res?.export ?? { status: 'running' }
    ElMessage.success('整册导出已开始（后台渲染约 2-5 分钟，可关闭弹窗继续审核）')
    startExportPoll()
  } catch (e: unknown) {
    exportErr.value = (e as { message?: string })?.message || '整册导出提交失败'
  }
}

/** 轮询整册导出状态：5s 一拍，done/failed 停；页面卸载清定时器（后台任务不受影响）。 */
function startExportPoll() {
  stopExportPoll()
  exportPollTimer = setInterval(async () => {
    try {
      const res = await getPunchBookExportStatus(bookId)
      const st = res?.export ?? null
      exportState.value = st
      if (!st || st.status === 'done' || st.status === 'failed') {
        stopExportPoll()
        if (st?.status === 'done') {
          ElMessage.success(`整册已合并（${st.days ?? days.value.length} 天）——弹窗内可下载`)
        } else if (st?.status === 'failed') {
          exportErr.value = st.error || '整册导出失败'
        }
      }
    } catch {
      /* 单拍失败不停轮询（网络抖动）；http 拦截器已弹错 */
    }
  }, 5_000)
}

function stopExportPoll() {
  if (exportPollTimer != null) {
    clearInterval(exportPollTimer)
    exportPollTimer = null
  }
}

/** 打开导出好的全册 PDF（新页签，本页不丢审核位置）。 */
function openExportFile(url: string | undefined) {
  if (!url) return
  window.open(url, '_blank')
}

// ═══════════════════════════════════════════════════════════════════════════
// 八、生命周期与联动
// ═══════════════════════════════════════════════════════════════════════════
watch([curDay, paper], () => {
  router.replace({
    query: { ...route.query, day: curDay.value ? String(curDay.value) : undefined, paper: paper.value },
  })
  void loadPreview()
  if (curDay.value) void fetchDayDetail(curDay.value)
})

function goBack() {
  router.push('/bookshelf')
}

onMounted(async () => {
  await Promise.all([loadBook(), loadDays()])
  await nextTick()
  observeCanvas()
  if (canvasRef.value) canvasW.value = Math.max(0, canvasRef.value.clientWidth - 60)
  if (curDay.value) {
    void loadPreview()
    void fetchDayDetail(curDay.value)
  }
})

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
  stopExportPoll()   // 只清本页定时器；后台导出任务照跑，回来重开弹窗即见结果
})
</script>

<template>
  <div class="punch-page">
    <!-- ══ 顶栏（FP1 返回 / FP3 进度 / FP9 问题清单 / FP10 导出本书）══ -->
    <div class="crumb">
      <span class="back" @click="goBack">← 书架</span>
      <h1 class="bk-title">{{ bookTitle || '每日打卡书' }}</h1>
      <span class="tag">每日打卡</span>
      <span v-if="bookAudited" class="tag audited">✓ 已审定</span>
      <div class="right">
        <span class="prog">已审 {{ passedCount }} / {{ days.length }} 天</span>
        <el-badge :value="openIssueTotal" :hidden="openIssueTotal === 0" type="warning">
          <el-button @click="openIssuesDrawer">问题清单</el-button>
        </el-badge>
        <el-button type="primary" @click="openExportBook">导出本书</el-button>
      </div>
    </div>

    <div class="main">
      <!-- ══ 左：目录（FP2）══ -->
      <aside v-loading="daysLoading" class="toc">
        <h3>目录</h3>
        <div
          v-for="d in days"
          :key="d.day"
          class="day"
          :class="{ cur: d.day === curDay }"
          @click="pickDay(d.day)"
        >
          <span
            class="st"
            :class="{
              ok: d.review.status === 'passed',
              warn: d.review.status === 'issue' || d.review.issueCount > 0,
              todo: d.review.status === 'pending' && d.review.issueCount === 0,
            }"
          >{{
            d.review.status === 'passed'
              ? '✓'
              : d.review.issueCount > 0
                ? d.review.issueCount
                : '○'
          }}</span>
          <span class="nm">第{{ d.day }}天</span>
          <span class="n">{{ d.itemCount }} 项</span>
        </div>
        <el-empty v-if="!daysLoading && !days.length" description="本书还没有天节点" :image-size="60" />
      </aside>

      <!-- ══ 右：审核条 + 纸面 ══ -->
      <section class="stage">
        <div class="bar">
          <h2>第 {{ curDay || '-' }} 天</h2>
          <span class="chip" :class="curStatus">{{ statusLabel(curStatus) }}</span>
          <span v-if="curDayBrief && curDayBrief.review.issueCount > 0" class="chip warn">
            {{ curDayBrief.review.issueCount }} 个问题待处理
          </span>
          <!-- FP6′ 题目卷 ⇄ 解析卷（与导出双卷 1:1）-->
          <div class="seg">
            <span :class="{ on: paper === 'question' }" @click="paper = 'question'">题目卷</span>
            <span :class="{ on: paper === 'answer' }" @click="paper = 'answer'">解析卷</span>
          </div>
          <div class="right">
            <el-button
              class="btn-pass"
              type="primary"
              :loading="reviewing"
              :disabled="!curDay"
              @click="onPassDay"
            >✓ 通过本天</el-button>
            <el-button class="btn-issue" :disabled="!curDay" @click="openIssueDialog">！记问题</el-button>
            <el-button
              v-if="curStatus === 'passed'"
              :loading="reviewing"
              @click="onReopenDay(curDay)"
            >重审</el-button>
            <el-button :disabled="!curDay" @click="openEditDrawer">修改本天</el-button>
            <el-button :loading="exporting" :disabled="!curDay" @click="onExportDay">导出本天</el-button>
          </div>
        </div>

        <!-- FP4 今日目标条（纸面里也印；壳里再列一份便于对照） -->
        <div v-if="curGoals.length" class="goal">
          <b>今日目标</b>
          <span v-for="(g, i) in curGoals" :key="i">{{ ['①', '②', '③', '④', '⑤'][i] ?? '·' }} {{ g }}</span>
        </div>

        <!-- FP5′ 纸面 = punch-v1 主题真渲染（与导出 PDF 同 theme 同 data）-->
        <div ref="canvasRef" v-loading="previewLoading" class="canvas">
          <div class="note">
            纸面 = 与导出 PDF <b>同一模板同一数据</b>（punch-v1），所见即所得
          </div>
          <div v-if="previewError" class="err">{{ previewError }}</div>
          <div v-else-if="previewHtml" class="paperbox" :style="{ width: boxW + 'px', height: boxH + 'px' }">
            <iframe
              ref="frameRef"
              class="paper-frame"
              :srcdoc="previewHtml"
              :style="{
                width: PAPER_W + 'px',
                height: paperH + 'px',
                transform: `scale(${scale})`,
              }"
              @load="onFrameLoad"
            ></iframe>
          </div>
          <div v-else-if="!previewLoading" class="err">选一天开始审核</div>
        </div>
      </section>
    </div>

    <!-- ══ 记问题（FP8）══ -->
    <el-dialog v-model="issueDialogVisible" :title="`记问题 · 第 ${curDay} 天`" width="480px">
      <el-form label-width="60px">
        <el-form-item label="模块">
          <el-select v-model="issueForm.module" style="width: 200px">
            <el-option v-for="m in moduleOptions" :key="m.value" :label="m.label" :value="m.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="题号">
          <el-input-number v-model="issueForm.seq" :min="1" :max="999" controls-position="right" />
          <span class="hint">模块内第几题（整模块问题可留空）</span>
        </el-form-item>
        <el-form-item label="类型">
          <div class="kinds">
            <span
              v-for="k in PUNCH_ISSUE_KINDS"
              :key="k"
              class="kind"
              :class="{ on: issueForm.kind === k }"
              @click="issueForm.kind = k"
            >{{ k }}</span>
          </div>
        </el-form-item>
        <el-form-item label="描述">
          <el-input
            v-model="issueForm.note"
            type="textarea"
            :rows="3"
            maxlength="300"
            show-word-limit
            placeholder="如：×10 太送分，换成两位数乘整十数"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="issueDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="issueSubmitting" @click="submitIssue">提交</el-button>
      </template>
    </el-dialog>

    <!-- ══ 问题清单（FP9）══ -->
    <el-drawer v-model="issuesDrawerVisible" title="问题清单 · 全书" size="480px">
      <div class="drawer-head">
        <el-checkbox v-model="showResolved">显示已销账</el-checkbox>
        <span class="hint">共 {{ shownIssues.length }} 条 · 待处理 {{ openIssueTotal }} 条</span>
      </div>
      <div v-loading="issuesLoading" class="issue-list">
        <div v-for="it in shownIssues" :key="`${it.day}-${it.idx}`" class="issue" :class="{ done: it.resolved }">
          <div class="ln1">
            <span class="d" @click="gotoIssueDay(it)">第 {{ it.day }} 天</span>
            <span class="m">{{ punchModuleLabel(it.module) }}</span>
            <span v-if="it.seq" class="q">第 {{ it.seq }} 题</span>
            <span class="k">{{ it.kind || '其他' }}</span>
            <span v-if="it.resolved" class="ok">已销账</span>
          </div>
          <div class="note">{{ it.note }}</div>
          <div class="ops">
            <el-button size="small" text @click="gotoIssueDay(it)">定位</el-button>
            <el-button
              size="small"
              text
              :loading="resolvingKey === `${it.day}-${it.idx}`"
              @click="toggleResolved(it)"
            >{{ it.resolved ? '取消销账' : '销账（重审）' }}</el-button>
          </div>
        </div>
        <el-empty v-if="!issuesLoading && !shownIssues.length" description="没有问题记录" :image-size="70" />
      </div>
    </el-drawer>

    <!-- ══ 修改本天（FP11a 计算题就地改 / FP11b 题库题只读）══ -->
    <el-drawer v-model="editDrawerVisible" :title="`修改本天 · 第 ${curDay} 天`" size="620px">
      <div v-loading="editLoading" class="edit-body">
        <div class="tip">
          改后保存 = 整天重灌（覆盖本天内容），<b>本天审核状态会重置为待审</b>；
          换题 / 调难度这类大改仍走「记问题 → 重产 → 重灌」。
        </div>

        <!-- 今日目标 -->
        <h4 class="sec">今日目标</h4>
        <div v-for="(g, i) in editGoals" :key="`g-${i}`" class="goal-row">
          <el-input v-model="editGoals[i]" maxlength="40" placeholder="如：乘法连续进位" />
          <el-button text type="danger" @click="removeGoal(i)">删除</el-button>
        </div>
        <el-button size="small" text type="primary" @click="addGoal">＋ 添加目标</el-button>

        <!-- FP11a 计算题（本书私有，可就地改）-->
        <template v-for="(m, mi) in editCalcModules" :key="`m-${mi}`">
          <h4 class="sec">
            {{ m.title || punchModuleLabel(String(m.type)) }}
            <small>{{ punchModuleLabel(String(m.type)) }} · 本书私有，改这里只影响本书</small>
          </h4>
          <div class="calc-grid">
            <div v-for="(it, ii) in (m.items ?? [])" :key="`i-${mi}-${ii}`" class="calc-row">
              <span class="no">{{ ii + 1 }}</span>
              <el-input v-model="it.q" class="q" placeholder="题面，如 357＋276＝" />
              <el-input v-model="it.a" class="a" placeholder="答案" />
            </div>
            <div v-if="!(m.items ?? []).length" class="empty-hint">该模块没有题目</div>
          </div>
        </template>

        <!-- FP11b 题库题（全库共享，本页只读）-->
        <template v-if="editRotating">
          <h4 class="sec">
            {{ editRotating.title || '解决问题' }}
            <small>题库共享题 · 本页只读</small>
          </h4>
          <div class="ro-tip">
            🔴 此模块是题库题引用（题面唯一源 = 题库 block_json）。
            <b>修改会对引用该题的全部载体生效</b>（其他书 / 试卷 / 专项），
            因此打卡页不提供就地改，请进题目编辑态改。
          </div>
          <div class="qid-list">
            <div v-for="(qid, qi) in (editRotating.qids ?? [])" :key="qid" class="qid-row">
              <span class="no">{{ qi + 1 }}</span>
              <code class="qid">{{ qid }}</code>
              <el-button size="small" text type="primary" @click="gotoQuestionEditor(String(qid))">
                在题库中修改 ↗
              </el-button>
            </div>
            <div v-if="!(editRotating.qids ?? []).length" class="empty-hint">该模块没有题</div>
          </div>
        </template>
      </div>
      <template #footer>
        <el-button @click="editDrawerVisible = false">取消</el-button>
        <el-button type="primary" :loading="editSaving" @click="saveEdit">保存并重新渲染</el-button>
      </template>
    </el-drawer>

    <!-- ══ 导出本书（FP10 整册异步：后台渲染合并，结果持久化可续看/重导覆盖）══ -->
    <el-dialog v-model="exportDialogVisible" title="导出本书" width="520px" :close-on-click-modal="false">
      <div class="exp-head">
        <span>卷种</span>
        <el-checkbox-group v-model="exportPapers" :disabled="exportRunning">
          <el-checkbox value="question">题目卷</el-checkbox>
          <el-checkbox value="answer">解析卷</el-checkbox>
        </el-checkbox-group>
      </div>
      <div class="exp-body">
        <!-- 跑中：异步后台任务——明说可以关窗，回来重开即见结果 -->
        <div v-if="exportRunning" class="exp-wait">
          全册 {{ exportState?.days ?? days.length }} 天正在后台合并渲染（约 2-5 分钟）…<br />
          可关闭本窗口继续审核，完成后重开「导出本书」即可下载。
        </div>
        <!-- 出结果：每种卷一份全册合并 PDF（持久化——上次导好的直接可下）-->
        <template v-else-if="exportDone">
          <div class="exp-done">
            ✓ 全册已合并（{{ exportState?.days ?? days.length }} 天）
            <span v-if="exportState?.exportedAt" class="exp-time">{{ String(exportState.exportedAt).slice(0, 16).replace('T', ' ') }}</span>
          </div>
          <div class="exp-files">
            <el-button
              v-if="exportState?.questionUrl"
              type="primary"
              plain
              @click="openExportFile(exportState?.questionUrl)"
            >题目全册 PDF ↗</el-button>
            <el-button
              v-if="exportState?.answerUrl"
              plain
              @click="openExportFile(exportState?.answerUrl)"
            >解析全册 PDF ↗</el-button>
          </div>
        </template>
        <div v-else-if="exportErr" class="exp-err">{{ exportErr }}</div>
        <div v-else class="hint exp-tip">
          选好卷种后点「开始导出」：后台把全书各天合并成一份 PDF（每种卷一份，约 2-5 分钟），
          期间可关窗继续审核；导好的全册长期可下，重新导出会覆盖上一次。
        </div>
      </div>
      <template #footer>
        <el-button @click="exportDialogVisible = false">关闭</el-button>
        <el-button type="primary" :loading="exportRunning" :disabled="exportRunning" @click="runExportBook">
          {{ exportRunning ? '后台导出中…' : exportDone ? '重新导出（覆盖）' : '开始导出' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.punch-page {
  padding: 12px 24px 40px;
  min-height: calc(100vh - 60px);
}

/* ── 顶栏 ── */
.crumb {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 0 12px;
}
.crumb .back {
  color: var(--el-text-color-secondary);
  font-size: 14px;
  cursor: pointer;
}
.crumb .back:hover {
  color: var(--bk-teal);
}
.bk-title {
  font-size: 19px;
  font-weight: 800;
  color: var(--bk-ink);
}
.tag {
  background: var(--bk-teal-soft);
  color: var(--bk-teal);
  font-size: 12px;
  font-weight: 700;
  padding: 3px 10px;
  border-radius: 6px;
}
.tag.audited {
  background: #fdecef;
  color: var(--bk-red-pen, #e0526b);
  border: 1px solid #f4c6d0;
}
.crumb .right {
  margin-left: auto;
  display: flex;
  gap: 10px;
  align-items: center;
}
.prog {
  background: #fff;
  border: 1px solid #d1e7dd;
  color: var(--bk-teal);
  font-size: 13px;
  font-weight: 600;
  padding: 7px 14px;
  border-radius: 8px;
  font-variant-numeric: tabular-nums;
}

/* ── 主体两栏 ── */
.main {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}
.toc {
  width: 240px;
  flex: none;
  background: #fff;
  border: 1px solid var(--bk-line);
  border-radius: 12px;
  padding: 14px 0;
  position: sticky;
  top: 12px;
}
.toc h3 {
  font-size: 14px;
  font-weight: 700;
  padding: 0 18px 10px;
  color: #374151;
}
.day {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 18px;
  font-size: 14px;
  color: #374151;
  cursor: pointer;
  transition: background 0.15s;
}
.day:hover {
  background: #f6faf9;
}
.day .st {
  width: 18px;
  height: 18px;
  flex: none;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}
.st.ok {
  background: #d1fae5;
  color: #059669;
}
.st.warn {
  background: #fef3c7;
  color: #d97706;
}
.st.todo {
  border: 1.5px solid #d1d5db;
  color: #d1d5db;
  font-size: 9px;
}
.day .nm {
  font-weight: 500;
}
.day.cur {
  background: var(--bk-teal-soft);
  border-right: 3px solid var(--bk-teal);
  font-weight: 700;
  color: var(--bk-ink);
}
.day .n {
  margin-left: auto;
  font-size: 11px;
  color: #9ca3af;
  font-variant-numeric: tabular-nums;
}

.stage {
  flex: 1;
  min-width: 0;
}

/* ── 审核条 ── */
.bar {
  background: #fff;
  border: 1px solid var(--bk-line);
  border-radius: 12px;
  padding: 10px 16px;
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.bar h2 {
  font-size: 17px;
  font-weight: 800;
  color: var(--bk-ink);
}
.chip {
  font-size: 12px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 6px;
  background: #f3f4f6;
  color: #6b7280;
}
.chip.passed {
  background: #d1fae5;
  color: #059669;
}
.chip.issue,
.chip.warn {
  background: #fef3c7;
  color: #d97706;
}
.seg {
  display: flex;
  border: 1px solid var(--bk-teal);
  border-radius: 8px;
  overflow: hidden;
  font-size: 13px;
  margin-left: 6px;
}
.seg span {
  padding: 6px 14px;
  color: var(--bk-teal);
  cursor: pointer;
  user-select: none;
}
.seg span.on {
  background: var(--bk-teal);
  color: #fff;
}
.bar .right {
  margin-left: auto;
  display: flex;
  gap: 8px;
}
.btn-issue {
  border-color: #f59e0b;
  color: #d97706;
  background: #fffbeb;
}
.btn-issue:hover {
  border-color: #d97706;
  color: #b45309;
  background: #fef3c7;
}

/* ── 今日目标条 ── */
.goal {
  background: #fdf9ee;
  border-left: 3px solid #d7a94b;
  padding: 9px 16px;
  margin-bottom: 12px;
  font-size: 13.5px;
  border-radius: 0 8px 8px 0;
  color: #4b3d1c;
}
.goal b {
  color: #9a6b1a;
  margin-right: 12px;
}
.goal span {
  margin-right: 20px;
}

/* ── 纸面画布 ── */
.canvas {
  background: #dfe5e0;
  border-radius: 12px;
  padding: 34px 30px 26px;
  display: flex;
  justify-content: center;
  position: relative;
  min-height: 320px;
}
.canvas .note {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 12px;
  color: #374151;
  background: #fff;
  padding: 4px 14px;
  border-radius: 14px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  white-space: nowrap;
}
.canvas .note b {
  color: var(--bk-teal);
}
.canvas .err {
  align-self: center;
  color: #6b7280;
  font-size: 13px;
  padding: 40px 0;
}
.paperbox {
  overflow: hidden;
  background: #fff;
  box-shadow: 0 10px 34px rgba(30, 50, 40, 0.25);
}
.paper-frame {
  border: 0;
  transform-origin: top left;
  display: block;
}

/* ── 记问题弹窗 ── */
.kinds {
  display: flex;
  gap: 8px;
}
.kind {
  font-size: 12.5px;
  padding: 4px 12px;
  border-radius: 6px;
  background: #f3f4f6;
  color: #6b7280;
  cursor: pointer;
  user-select: none;
  border: 1px solid transparent;
}
.kind.on {
  background: #fffbeb;
  border-color: #f59e0b;
  color: #b45309;
  font-weight: 700;
}
.hint {
  font-size: 11.5px;
  color: var(--el-text-color-secondary);
  margin-left: 10px;
}

/* ── 问题清单抽屉 ── */
.drawer-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 10px;
  border-bottom: 1px dashed var(--bk-line);
}
.issue-list {
  min-height: 120px;
  padding-top: 8px;
}
.issue {
  border: 1px solid var(--bk-line);
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 10px;
  background: #fff;
}
.issue.done {
  opacity: 0.62;
  background: #f8faf9;
}
.issue .ln1 {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  flex-wrap: wrap;
}
.issue .d {
  font-weight: 700;
  color: var(--bk-teal);
  cursor: pointer;
}
.issue .m,
.issue .q {
  background: #f3f4f6;
  color: #4b5563;
  padding: 1px 8px;
  border-radius: 5px;
}
.issue .k {
  background: #fffbeb;
  color: #b45309;
  padding: 1px 8px;
  border-radius: 5px;
  font-weight: 600;
}
.issue .ok {
  background: #d1fae5;
  color: #059669;
  padding: 1px 8px;
  border-radius: 5px;
  font-weight: 600;
}
.issue .note {
  font-size: 13px;
  color: #374151;
  margin-top: 6px;
  line-height: 1.6;
  word-break: break-all;
}
.issue .ops {
  display: flex;
  justify-content: flex-end;
  gap: 4px;
  margin-top: 2px;
}

/* ── 修改本天抽屉 ── */
.edit-body {
  padding-bottom: 12px;
}
.edit-body .tip {
  background: #fffbeb;
  border: 1px solid #fde68a;
  color: #92400e;
  font-size: 12.5px;
  line-height: 1.7;
  border-radius: 8px;
  padding: 9px 12px;
  margin-bottom: 14px;
}
.sec {
  font-size: 14.5px;
  font-weight: 700;
  color: var(--bk-ink);
  margin: 16px 0 9px;
  padding-left: 9px;
  border-left: 4px solid var(--bk-teal);
}
.sec small {
  font-weight: 400;
  color: #8a938e;
  font-size: 11.5px;
  margin-left: 8px;
}
.goal-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.calc-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.calc-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.calc-row .no {
  width: 22px;
  flex: none;
  text-align: right;
  font-size: 12px;
  color: #9ca3af;
  font-variant-numeric: tabular-nums;
}
.calc-row .q {
  flex: 3;
}
.calc-row .a {
  flex: 2;
}
.empty-hint {
  font-size: 12.5px;
  color: var(--el-text-color-secondary);
  padding: 6px 0;
}
.ro-tip {
  background: #eef2ff;
  border: 1px solid #c7d2fe;
  color: #3730a3;
  font-size: 12.5px;
  line-height: 1.7;
  border-radius: 8px;
  padding: 9px 12px;
  margin-bottom: 10px;
}
.qid-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.qid-row {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--bk-line);
  border-radius: 8px;
  padding: 7px 10px;
}
.qid-row .no {
  width: 22px;
  text-align: right;
  font-size: 12px;
  color: #9ca3af;
}
.qid-row .qid {
  font-size: 12px;
  color: #4b5563;
  background: #f3f4f6;
  padding: 2px 8px;
  border-radius: 5px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.qid-row .el-button {
  margin-left: auto;
}

/* ── 导出本书弹窗（整书合并：每种卷一份全册 PDF）── */
.exp-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding-bottom: 10px;
  border-bottom: 1px dashed var(--bk-line);
  font-size: 13px;
}
.exp-body {
  min-height: 92px;
  padding-top: 12px;
}
.exp-tip {
  margin-left: 0;
  line-height: 1.7;
}
.exp-wait {
  font-size: 13px;
  color: #6b7280;
  text-align: center;
  padding: 30px 10px 22px;
  line-height: 1.7;
}
.exp-time {
  margin-left: 8px;
  font-weight: 400;
  font-size: 12px;
  color: #9ca3af;
}
.exp-done {
  font-size: 13px;
  font-weight: 700;
  color: #059669;
  margin-bottom: 12px;
}
.exp-files {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.exp-err {
  color: var(--el-color-danger);
  font-size: 13px;
  line-height: 1.7;
  padding: 8px 0;
}
</style>
