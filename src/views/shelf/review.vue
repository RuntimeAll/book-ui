<script setup lang="ts">
/**
 * PRD-006 批2 — 录题比对审核页（按页人工比对源书原版 → 逐页确认）。
 *
 * 左 = 源书第 N 页原图（BE 渲染 DPI144 PNG base64）；右 = 系统 source_page=N 的全部题项
 *   （question 用共享 QuestionCard 真机渲染 = 所见即系统；explain 渲染「方法点拨」块），按 seq 排。
 * 每题：「改」→ 题目详情页（复用 detail.vue，改完返回本页自动刷新该页）；「记问题」→ 登记表 POST issue。
 * 底部页级审核栏：「本页通过 · 翻下一页」→ PUT confirm-page → 自动翻下一页（D7 页级，不逐题打勾）。
 * 翻页 ‹ ›（键盘 ←→ 亦可），进度「已审 X / N 页」。
 *
 * 设计稿正本 = codeplace-A/prd/PRD-006/artifacts/设计稿/审核页设计稿.html。
 * 数据地基（source_page 回填 / 源 PDF 渲染）= 批1（BE 已上线 8 端点）。
 */
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Picture } from '@element-plus/icons-vue'
import QuestionCard from '@/components/business/QuestionCard/index.vue'
import QuestionContent from '@/components/business/QuestionContent/index.vue'
import { getBook } from '@/api/shelf'
import { questionListByIds, type QuestionDetail, type QuestionItem } from '@/api/question'
import {
  getProgress,
  getSourcePage,
  getPageItems,
  confirmPage,
  confirmPages,
  createIssue,
  listIssues,
  getPageMap,
  updateIssueStatus,
  ISSUE_TYPES,
  ISSUE_STATUSES,
  ISSUE_SOURCES,
  QUICK_ISSUE_GROUPS,
  type ReviewPageItem,
  type ReviewIssue,
  type PageMapEntry,
} from '@/api/review'

const route = useRoute()
const router = useRouter()
const bookId = String(route.params.bookId)

// ── 顶栏状态 ──────────────────────────────────────────────────────────────────
const bookTitle = ref('')
const totalPages = ref(0)
const reviewedPages = ref(0)
/** 断点续审（2026-07-21 用户拍板）：每次翻页记 localStorage，重进还原上次审核位置；URL query 优先。 */
const POS_KEY = `rv-pos-${bookId}`
const page = ref(
  clampPage(Number(route.query.page) || Number(localStorage.getItem(POS_KEY)) || 1),
)

function clampPage(p: number): number {
  if (!Number.isFinite(p) || p < 1) return 1
  return Math.floor(p)
}
const progressPct = computed(() =>
  totalPages.value > 0 ? Math.min(100, Math.round((reviewedPages.value / totalPages.value) * 100)) : 0,
)
/** 录入确认完成语义（D4/AC5）：全书页审完 = reviewedPages ≥ totalPages（前端计算，MVP 不落库）。 */
const reviewDone = computed(
  () => totalPages.value > 0 && reviewedPages.value >= totalPages.value,
)
/** 当前页是否已确认（据 reviewedPages 无法逐页判定，改由 confirm 后本地标记 + 进度回读）。 */
const pageReviewed = ref(false)

// ── 源页图 ────────────────────────────────────────────────────────────────────
const srcLoading = ref(false)
const srcImage = ref('')
const srcError = ref('')

// ── 右侧题项 ──────────────────────────────────────────────────────────────────
const itemsLoading = ref(false)
/** 展示项：question（带真机渲染用的 QuestionItem）/ explain（方法点拨块）。 */
interface DisplayItem {
  itemId: string
  seq: number | null
  kind: 'question' | 'explain'
  questionId?: string | null
  q?: QuestionItem
  explainTitle?: string
  explainText?: string | null
  /** 审核置信度（>=90 可速过 / 60-89 常规 / <60 重点审） */
  confidence?: number | null
}
const displayItems = ref<DisplayItem[]>([])
const questionCount = computed(() => displayItems.value.filter((d) => d.kind === 'question').length)

// ── 页级置信度地图（速审跳页，2026-07-23）──────────────────────────────────────
/** 全书页级地图：tier hi=页内全部题项置信度>=90（可闭眼速过）/ mid / lo=重点审。 */
const pageMapEntries = ref<PageMapEntry[]>([])
const pageMapByPage = computed<Record<number, PageMapEntry>>(() => {
  const m: Record<number, PageMapEntry> = {}
  for (const e of pageMapEntries.value) m[e.page] = e
  return m
})
async function loadPageMap() {
  try {
    const r = await getPageMap(bookId)
    pageMapEntries.value = r?.pages ?? []
  } catch {
    pageMapEntries.value = []
  }
}
/** 一页可速过 = 有地图条目、hi 档、无未闭环问题、未审。无条目页（无题页）在跳段里也一并通过。 */
function pageSkippable(p: number): boolean {
  const e = pageMapByPage.value[p]
  if (!e) return true // 无题页
  return e.tier === 'hi' && e.issues === 0
}
/** 当前页往后可连续速过的页数（到下一个重点页为止）。 */
const speedSkipInfo = computed(() => {
  if (!totalPages.value || !pageMapEntries.value.length) return { count: 0, stop: 0 }
  let count = 0
  let p = page.value
  while (p <= totalPages.value && pageSkippable(p)) {
    count += 1
    p += 1
  }
  return { count, stop: p > totalPages.value ? 0 : p }
})
const speedSkipping = ref(false)
/**
 * ⚡ 速审：从当前页起把连续的「高置信且无问题」页批量通过，停在下一个重点页。
 * 高置信语义 = 录入管线置信度全部 >=90（人工审过金标准判例回灌后的机器闸口径）。
 */
async function speedSkip() {
  const info = speedSkipInfo.value
  if (!info.count) {
    ElMessage.info('当前页就是重点页，先审这页')
    return
  }
  speedSkipping.value = true
  try {
    const pages: number[] = []
    for (let p = page.value; p < page.value + info.count; p += 1) pages.push(p)
    await confirmPages(bookId, pages)
    await Promise.all([loadProgress(), loadPageMap()])
    if (info.stop) {
      suppressAutoSkip.value = true
      goPage(info.stop)
      ElMessage.success(`已速过 ${pages.length} 页（高置信），停在重点页 P.${info.stop}`)
    } else {
      ElMessage.success(`已速过 ${pages.length} 页（高置信），全书审核完成 🎉`)
      pageReviewed.value = true
    }
  } catch {
    /* http 拦截器已弹错 */
  } finally {
    speedSkipping.value = false
  }
}

// ── 问题登记 ──────────────────────────────────────────────────────────────────
const issues = ref<ReviewIssue[]>([])
const issuesOnPage = computed(() => issues.value.filter((i) => i.sourcePage === page.value))
/** 本页是否有「待处理」问题（刚记完 bug）→ 底栏切成「直接下一页」不强迫通过。 */
const pageHasPending = computed(() => issuesOnPage.value.some((i) => i.status === '待处理'))
/** 本页问题按题分组（2026-07-21 用户拍板：问题直接挂对应题卡上就地确认，不藏抽屉）；'__page__' = 整页问题。 */
const issuesByQuestion = computed(() => {
  const m: Record<string, ReviewIssue[]> = {}
  for (const i of issuesOnPage.value) {
    const k = i.questionId ? String(i.questionId) : '__page__'
    ;(m[k] ||= []).push(i)
  }
  return m
})

// ═══════════════════════════════════════════════════════════════════════════
// 加载
// ═══════════════════════════════════════════════════════════════════════════
async function loadBook() {
  try {
    const b = await getBook(bookId)
    bookTitle.value = b?.title ?? ''
  } catch {
    /* 标题非关键，静默 */
  }
}

async function loadProgress() {
  try {
    const p = await getProgress(bookId)
    totalPages.value = Number(p?.totalPages ?? 0)
    reviewedPages.value = Number(p?.reviewedPages ?? 0)
    // 越界纠偏：进度回读后若 page 超出总页数，夹回末页
    if (totalPages.value > 0 && page.value > totalPages.value) {
      page.value = totalPages.value
    }
  } catch {
    /* http 拦截器已弹错 */
  }
}

async function loadIssues() {
  try {
    issues.value = await listIssues(bookId)
  } catch {
    issues.value = []
  }
}

async function loadSourcePage() {
  srcLoading.value = true
  srcError.value = ''
  srcImage.value = ''
  const cur = page.value
  try {
    const res = await getSourcePage(bookId, cur)
    if (cur !== page.value) return // 竞态：翻页已变，丢弃过期结果
    srcImage.value = res?.image || (res?.base64 ? `data:image/png;base64,${res.base64}` : '')
    if (res?.totalPages) totalPages.value = Number(res.totalPages)
    if (!srcImage.value) srcError.value = '源页图为空'
  } catch (e: unknown) {
    if (cur !== page.value) return
    const msg = (e as { message?: string })?.message || '源页渲染失败'
    srcError.value = msg
  } finally {
    if (cur === page.value) srcLoading.value = false
  }
}

/** 把页项 + 题库富数据装配成渲染模型（question 走真机渲染 QuestionItem；explain 取标题+正文）。 */
async function loadPageItems() {
  itemsLoading.value = true
  const cur = page.value
  try {
    const res = await getPageItems(bookId, cur)
    if (cur !== page.value) return
    const raw: ReviewPageItem[] = res?.items ?? []

    // 收集 question 的 questionId → 批量拉题库完整题（含 questionType/难度/知识点/blockJson，真机渲染口径）
    const qids = raw
      .filter((it) => it.kind === 'question' && it.questionId)
      .map((it) => String(it.questionId))
    let enriched: Record<string, QuestionDetail> = {}
    if (qids.length) {
      try {
        const list = await questionListByIds(qids)
        for (const q of list ?? []) enriched[String(q.id)] = q
      } catch {
        enriched = {}
      }
    }
    if (cur !== page.value) return

    displayItems.value = raw.map((it) => {
      if (it.kind === 'explain') {
        const ej = typeof it.explainJson === 'object' && it.explainJson ? it.explainJson : null
        return {
          itemId: it.itemId,
          seq: it.seq,
          kind: 'explain' as const,
          explainTitle: (ej?.title as string) || '方法点拨',
          explainText: (ej?.text as string) ?? (typeof it.explainJson === 'string' ? it.explainJson : null),
        }
      }
      const qid = it.questionId ? String(it.questionId) : null
      const full = qid ? enriched[qid] : undefined
      return {
        itemId: it.itemId,
        seq: it.seq,
        kind: 'question' as const,
        questionId: qid,
        q: full ?? fallbackQuestion(it),
        confidence: it.confidence ?? null,
      }
    })
    // 🔴 无题页自动跳过（2026-07-21 用户拍板"不要默认停目录，直接全部跳过"）：
    //    前进方向遇无题页 → 自动标通过并跳到下一个有题页；往回翻(prevPage)不劫持。
    if (!displayItems.value.length && !skippingEmpty.value && !suppressAutoSkip.value) {
      void skipEmptyPages()
    }
    suppressAutoSkip.value = false
  } catch {
    if (cur === page.value) displayItems.value = []
  } finally {
    if (cur === page.value) itemsLoading.value = false
  }
}

/** 题库未回填时的兜底 QuestionItem（仅用页项自带 stem/blockJson，元数据缺省）。 */
function fallbackQuestion(it: ReviewPageItem): QuestionItem {
  let blockJson: string | null = null
  if (it.blockJson != null) {
    blockJson = typeof it.blockJson === 'string' ? it.blockJson : JSON.stringify(it.blockJson)
  }
  return {
    id: String(it.questionId ?? it.itemId),
    questionType: 0,
    difficult: null,
    stemImg: null,
    stemText: it.stem ?? null,
    blockJson,
  }
}

/** 翻页统一入口：夹取边界 + 同步 query。 */
function goPage(p: number) {
  const np = totalPages.value > 0 ? Math.min(Math.max(1, p), totalPages.value) : Math.max(1, p)
  if (np === page.value) return
  page.value = np
}
const canPrev = computed(() => page.value > 1)
const canNext = computed(() => totalPages.value === 0 || page.value < totalPages.value)
function prevPage() {
  if (canPrev.value) {
    suppressAutoSkip.value = true // 往回翻允许停在无题页（不被自动跳过劫持）
    goPage(page.value - 1)
  }
}
function nextPage() {
  if (canNext.value) goPage(page.value + 1)
}

// page 变 → 重载左右 + 同步 URL（router.replace 不触发重挂）+ 记断点续审位置
watch(page, () => {
  router.replace({ query: { ...route.query, page: String(page.value) } })
  localStorage.setItem(POS_KEY, String(page.value))
  pageReviewed.value = false
  void loadSourcePage()
  void loadPageItems()
})

// ═══════════════════════════════════════════════════════════════════════════
// 页级确认
// ═══════════════════════════════════════════════════════════════════════════
const confirming = ref(false)
async function onConfirmPage() {
  confirming.value = true
  try {
    // 🔴 2026-07-21 用户拍板：页级通过 = 本页所有「待确认」问题一并确认闭环（不留尾巴）；
    //    「待处理」保留——那是还没修的，通过页不代表问题已解决。
    const pend = issuesOnPage.value.filter((i) => i.status === '待确认')
    for (const i of pend) {
      try {
        await updateIssueStatus(i.id, '已确认')
        i.status = '已确认'
      } catch {
        /* 单条失败不阻塞页通过；http 拦截器已弹错 */
      }
    }
    await confirmPage(bookId, page.value)
    pageReviewed.value = true
    ElMessage.success(pend.length ? `第 ${page.value} 页已通过，${pend.length} 条待确认问题一并确认` : `第 ${page.value} 页已通过`)
    await loadProgress()
    // 自动翻下一页（末页则停留并提示）
    if (canNext.value) {
      nextPage()
    } else {
      ElMessage.info('已到最后一页')
    }
  } catch {
    /* http 拦截器已弹错 */
  } finally {
    confirming.value = false
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 跳过无题页（2026-07-21 用户反馈：封面/目录页拦着进不了正题，一页页点太磨人）
//   从当前无题页起：逐页标通过 → 探下一页，直到遇到有题页停下（该页留给用户审）。
// ═══════════════════════════════════════════════════════════════════════════
const skippingEmpty = ref(false)
/** 置 true 时抑制下一次 loadPageItems 的自动跳过（往回翻/跳过刚结束的场景）。 */
const suppressAutoSkip = ref(false)
async function skipEmptyPages() {
  skippingEmpty.value = true
  try {
    let p = page.value
    const max = totalPages.value || p + 60 // 防呆上限（totalPages 未知时最多探 60 页）
    for (;;) {
      await confirmPage(bookId, p) // 无题页直接标通过
      if (p >= max) break
      const next = p + 1
      const res = await getPageItems(bookId, next)
      p = next
      if ((res?.items ?? []).length > 0) break // 下一页有题 → 停在那页交给用户审
    }
    suppressAutoSkip.value = true // 停点若仍无题（末页情形）不再连环触发
    goPage(p)
    await loadProgress()
    ElMessage.success(`无题页已自动通过，跳到第 ${p} 页`)
  } catch {
    /* http 拦截器已弹错 */
  } finally {
    skippingEmpty.value = false
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 「改」→ 题目详情页（复用 detail.vue；改完 router.back 返回本页自动刷新）
// ═══════════════════════════════════════════════════════════════════════════
function goEdit(d: DisplayItem) {
  if (!d.questionId) {
    ElMessage.warning('该题项无题库题（无法定位详情）')
    return
  }
  // 🔴 2026-07-21 bug 修：原 router.push 跳详情，返回时历史栈落回编辑页死循环。
  //    改为新页签打开——审核页原地不动，改完关页签切回来自动刷新（见 visibilitychange）。
  window.open(router.resolve(`/question/detail/${d.questionId}`).href, '_blank')
}
// 切回本页签（改题回来）→ 自动重载当前页题目，立即看到改后效果
function onVisibleRefresh() {
  if (document.visibilityState === 'visible') void loadPageItems()
}

// ═══════════════════════════════════════════════════════════════════════════
// 「记问题」对话框 —— 草稿暂存 → 点「完成录入」才落库（2026-07-21 用户拍板改版）
//   点标签 = 本地选中（再点取消），不直接进库；补充说明同样先入草稿；
//   底部「完成录入 (N)」一次性批量 POST；关闭弹窗不点完成 = 丢弃草稿（有草稿时先确认）。
// ═══════════════════════════════════════════════════════════════════════════
const issueDialogVisible = ref(false)
/** 本次记录目标（某题 questionId / 整页 null）。 */
const issueTarget = ref<{ questionId: string | null }>({ questionId: null })

/** 草稿条目：kind=tag(标签) / text(补充说明)。落库前只存在本地。 */
interface DraftIssue {
  kind: 'tag' | 'text'
  category: string
  description: string
}
const draftIssues = ref<DraftIssue[]>([])
const finishSubmitting = ref(false)
/** 标签是否已选（胶囊高亮由草稿派生）。 */
const tagSelected = computed<Record<string, boolean>>(() => {
  const m: Record<string, boolean> = {}
  for (const d of draftIssues.value) if (d.kind === 'tag') m[d.description] = true
  return m
})

// 补充说明（默认收起，仅特殊问题需打字时展开）
const supplementOpen = ref(false)
const supplementType = ref('')
const supplementText = ref('')
/** 补充说明归类可选项 = 三大类 + 其它。 */
const supplementTypeOptions = [...QUICK_ISSUE_GROUPS.map((g) => g.category), '其它']

/** 问题清单筛选类型可选项 = 快捷大类 + 历史类型（去重，兼容旧数据）。 */
const typeFilterOptions = Array.from(
  new Set([...QUICK_ISSUE_GROUPS.map((g) => g.category), ...ISSUE_TYPES]),
)

function openIssueDialog(d?: DisplayItem) {
  issueTarget.value = { questionId: d?.questionId ?? null }
  draftIssues.value = []
  supplementOpen.value = false
  supplementType.value = ''
  supplementText.value = ''
  issueDialogVisible.value = true
}
function shortId(id: string | null | undefined): string {
  if (!id) return ''
  const s = String(id)
  return s.length > 6 ? `…${s.slice(-6)}` : s
}

/** 点标签 = 草稿里 toggle 这条（选中/取消），不落库。 */
function toggleDraftTag(category: string, tag: string) {
  const idx = draftIssues.value.findIndex((d) => d.kind === 'tag' && d.description === tag)
  if (idx >= 0) draftIssues.value.splice(idx, 1)
  else draftIssues.value.push({ kind: 'tag', category, description: tag })
}

/** 补充说明：加入草稿（不落库），可加多条。 */
function addSupplementDraft() {
  const text = supplementText.value.trim()
  if (!text) {
    ElMessage.warning('请填写补充说明')
    return
  }
  draftIssues.value.push({ kind: 'text', category: supplementType.value || '其它', description: text })
  supplementText.value = ''
}
function removeDraft(idx: number) {
  draftIssues.value.splice(idx, 1)
}

/** 🔴「完成录入」= 唯一落库动作：批量 POST 草稿；失败的留在草稿里可重试。 */
async function finishRecord() {
  if (!draftIssues.value.length) {
    issueDialogVisible.value = false
    return
  }
  finishSubmitting.value = true
  const failed: DraftIssue[] = []
  let okCount = 0
  for (const d of draftIssues.value) {
    try {
      const res = await createIssue({
        bookId,
        questionId: issueTarget.value.questionId,
        sourcePage: page.value,
        issueType: d.category,
        description: d.description,
      })
      okCount += 1
      issues.value.push({
        id: res?.id ? String(res.id) : `tmp-${Date.now()}-${okCount}`,
        bookId,
        questionId: issueTarget.value.questionId ?? null,
        sourcePage: page.value,
        issueType: d.category,
        description: d.description,
        status: ISSUE_STATUSES[0],
      })
    } catch {
      failed.push(d) // http 拦截器已弹错；失败条目保留草稿可重试
    }
  }
  finishSubmitting.value = false
  draftIssues.value = failed
  if (okCount) {
    ElMessage.success(`已录入 ${okCount} 条`)
    if (issuesDrawerVisible.value) void loadDrawerIssues()
  }
  if (!failed.length) issueDialogVisible.value = false
  else ElMessage.warning(`${failed.length} 条录入失败，已保留可重试`)
}

/** 关闭弹窗（不点完成录入）：有草稿先确认丢弃，防误关丢记录。 */
function beforeCloseIssueDialog(done: () => void) {
  if (!draftIssues.value.length || finishSubmitting.value) {
    done()
    return
  }
  ElMessageBox.confirm(`还有 ${draftIssues.value.length} 条未录入，关闭将丢弃。确认？`, '未完成录入', {
    confirmButtonText: '丢弃并关闭',
    cancelButtonText: '继续记录',
    type: 'warning',
  })
    .then(() => {
      draftIssues.value = []
      done()
    })
    .catch(() => {})
}

// ═══════════════════════════════════════════════════════════════════════════
// 本书问题清单（抽屉：筛选 + 状态流转）
// ═══════════════════════════════════════════════════════════════════════════
const issuesDrawerVisible = ref(false)
const filterType = ref('')
const filterStatus = ref('')
/** 来源筛选：human=人工（金标准）/ agent=自查（线索级）。 */
const filterSource = ref('')
/** 抽屉表格数据 = 服务端按 type/status/source 过滤，与顶栏 issues 全量分开。 */
const drawerIssues = ref<ReviewIssue[]>([])
const drawerLoading = ref(false)
async function loadDrawerIssues() {
  drawerLoading.value = true
  try {
    drawerIssues.value = await listIssues(
      bookId,
      filterType.value || undefined,
      filterStatus.value || undefined,
      filterSource.value || undefined,
    )
  } catch {
    drawerIssues.value = []
  } finally {
    drawerLoading.value = false
  }
}
/** 客户端兜底过滤（BE 若忽略参数也保证展示正确）。 */
const shownIssues = computed(() =>
  drawerIssues.value.filter(
    (i) =>
      (!filterType.value || i.issueType === filterType.value) &&
      (!filterStatus.value || i.status === filterStatus.value) &&
      (!filterSource.value || (i.source ?? 'human') === filterSource.value),
  ),
)
// 打开抽屉 / 改筛选 → 服务端重取（?type&status&source）
watch(issuesDrawerVisible, (open) => {
  if (open) void loadDrawerIssues()
})
watch([filterType, filterStatus, filterSource], () => {
  if (issuesDrawerVisible.value) void loadDrawerIssues()
})
/** 来源徽标：人工=金标准（amber 醒目）/ 自查=agent 线索（灰）。 */
function sourceLabel(s?: string): string {
  return (s ?? 'human') === 'human' ? '人工' : '自查'
}
function sourceTagType(s?: string): 'warning' | 'info' {
  return (s ?? 'human') === 'human' ? 'warning' : 'info'
}
function issueStatusTag(s: string): 'info' | 'success' | 'warning' | 'primary' {
  if (s === '已确认') return 'success' // 老师已确认 = 闭环
  if (s === '待确认') return 'primary' // Claude 已改、待老师确认（醒目=你要动的）
  if (s === '搁置') return 'info'
  return 'warning' // 待处理
}
async function changeIssueStatus(row: ReviewIssue, status: string) {
  if (status === row.status) return
  try {
    await updateIssueStatus(row.id, status)
    ElMessage.success(status === '已确认' ? '已确认修改完成 ✓' : '状态已更新')
    await Promise.all([loadIssues(), loadDrawerIssues()])
  } catch {
    /* http 拦截器已弹错 */
  }
}
/** 置信度分档（评审效率）：>=90 可速过 / 60-89 常规 / <60 重点审。 */
function confClass(c: number): string {
  return c >= 90 ? 'hi' : c >= 60 ? 'mid' : 'lo'
}
function confLabel(c: number): string {
  return c >= 90 ? `可速过 ${c}` : c >= 60 ? `常规 ${c}` : `重点审 ${c}`
}
/** 老师一键确认：待确认 → 已确认（协同闭环的老师侧动作）。 */
function confirmIssueFixed(row: ReviewIssue) {
  void changeIssueStatus(row, '已确认')
}
/** 点问题行 → 跳到该问题所在源页复看（关抽屉）；sourcePage=0 的全书性批量条目不跳。 */
function gotoIssuePage(row: ReviewIssue) {
  const p = Number(row.sourcePage)
  if (!p || p < 1) {
    ElMessage.info('该条是全书性批量问题，无固定页；直接翻看任意受影响页即可')
    return
  }
  suppressAutoSkip.value = true // 定点跳页不被自动跳过劫持
  issuesDrawerVisible.value = false
  goPage(p)
}
/** 全书问题进度统计（顶栏角标 issues 全量算，抽屉筛选不影响）。 */
const issueStat = computed(() => {
  const s = { 待处理: 0, 待确认: 0, 已确认: 0, 搁置: 0, total: 0 } as Record<string, number>
  for (const i of issues.value) {
    s.total += 1
    if (i.status in s) s[i.status] += 1
  }
  return s
})
/** 全书问题是否已全部闭环（有登记问题、且无 待处理/待确认 剩余）。 */
const allIssuesCleared = computed(
  () => issueStat.value.total > 0 && issueStat.value['待处理'] === 0 && issueStat.value['待确认'] === 0,
)

// ── 导出问题清单 CSV（前端生成；含 页/题/类型/描述/状态；BOM 让 Excel 认中文）──
function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
function exportIssues() {
  const rows = shownIssues.value
  if (!rows.length) {
    ElMessage.warning('当前筛选下无可导出的问题')
    return
  }
  const header = ['页', '题', '类型', '描述', '状态']
  const body = rows.map((it) =>
    [
      csvCell(it.sourcePage ?? ''),
      csvCell(it.questionId ? String(it.questionId) : '整页'),
      csvCell(it.issueType),
      csvCell(it.description ?? ''),
      csvCell(it.status),
    ].join(','),
  )
  // 前缀 UTF-8 BOM（U+FEFF），Excel 打开中文 CSV 不乱码
  const csv = String.fromCharCode(0xfeff) + [header.join(','), ...body].join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `问题清单-${bookTitle.value || bookId}-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(a.href)
  ElMessage.success(`已导出 ${rows.length} 条`)
}

// ═══════════════════════════════════════════════════════════════════════════
// 键盘翻页（←/→）；输入框/对话框内不拦截
// ═══════════════════════════════════════════════════════════════════════════
function onKeydown(e: KeyboardEvent) {
  if (issueDialogVisible.value || issuesDrawerVisible.value) return
  const t = e.target as HTMLElement | null
  const tag = t?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return
  if (e.key === 'ArrowLeft') {
    e.preventDefault()
    prevPage()
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    nextPage()
  }
}

function goShelf() {
  router.push('/bookshelf')
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  document.addEventListener('visibilitychange', onVisibleRefresh)
  await Promise.all([loadBook(), loadProgress(), loadIssues(), loadPageMap()])
  await Promise.all([loadSourcePage(), loadPageItems()])
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  document.removeEventListener('visibilitychange', onVisibleRefresh)
})
</script>

<template>
  <div class="review-page">
    <!-- ══ 顶栏：书名 + 进度 + 翻页 ══ -->
    <div class="rv-top">
      <span class="rv-back" @click="goShelf">← 书架</span>
      <span class="rv-title">📖 {{ bookTitle || '录入审核' }}</span>
      <div class="rv-prog">
        <span v-if="reviewDone" class="rv-done-badge">✓ 录入确认完成</span>
        <span class="rv-prog-num">已审 {{ reviewedPages }} / {{ totalPages || '?' }} 页</span>
        <div class="rv-prog-bar"><i :style="{ width: progressPct + '%' }"></i></div>
      </div>
      <el-button size="small" class="rv-issues-btn" @click="issuesDrawerVisible = true">
        问题登记 <b v-if="issues.length">({{ issues.length }})</b>
        <el-badge
          v-if="issueStat['待确认'] > 0"
          :value="issueStat['待确认']"
          class="rv-confirm-badge"
          type="primary"
        >
          <span class="rv-confirm-hint">待你确认</span>
        </el-badge>
      </el-button>
      <!-- ⚡ 速审：连续高置信页（录入置信度全部>=90 且无问题）一键通过，直达下一重点页 -->
      <el-button
        v-if="speedSkipInfo.count > 0"
        type="success"
        size="small"
        class="rv-speed-btn"
        :loading="speedSkipping"
        @click="speedSkip"
      >
        ⚡ 速过 {{ speedSkipInfo.count }} 页高置信
      </el-button>
      <div class="rv-pager">
        <button class="rv-pgbtn" :disabled="!canPrev" aria-label="上一页" @click="prevPage">‹</button>
        <span class="rv-pgnum">P. {{ page }}</span>
        <button class="rv-pgbtn" :disabled="!canNext" aria-label="下一页" @click="nextPage">›</button>
      </div>
    </div>

    <!-- ══ 左源右系统 ══ -->
    <div class="rv-split">
      <!-- 左：源书原版页 -->
      <div class="rv-pane rv-left">
        <div class="rv-pane-h">源书原版 · 第 {{ page }} 页</div>
        <div v-loading="srcLoading" class="rv-src-wrap">
          <el-image
            v-if="srcImage"
            :src="srcImage"
            :preview-src-list="[srcImage]"
            :initial-index="0"
            fit="contain"
            preview-teleported
            hide-on-click-modal
            class="rv-src-img"
          />
          <div v-else-if="srcError && !srcLoading" class="rv-src-empty">
            <el-icon :size="26"><Picture /></el-icon>
            <p>{{ srcError }}</p>
            <el-button size="small" @click="loadSourcePage">重试</el-button>
          </div>
          <div v-else-if="!srcLoading" class="rv-src-empty">
            <p>暂无源页图</p>
          </div>
        </div>
      </div>

      <!-- 右：系统该页题目 -->
      <div class="rv-pane rv-right">
        <div class="rv-pane-h">
          系统 · 第 {{ page }} 页 · 共 {{ questionCount }} 题
          <span
            v-if="pageMapByPage[page]?.tier"
            class="rv-page-tier"
            :class="pageMapByPage[page]!.tier"
          >
            {{ pageMapByPage[page]!.tier === 'hi' ? '高置信页' : pageMapByPage[page]!.tier === 'lo' ? '重点审' : '常规' }}
          </span>
          <span class="rv-pane-h-sub">整页比对，不逐题确认</span>
        </div>

        <div v-loading="itemsLoading" class="rv-items">
          <template v-if="displayItems.length">
            <!-- 整页问题（不关联具体题）：挂在页顶就地闭环 -->
            <div v-if="issuesByQuestion['__page__']?.length" class="rv-qissues rv-pageissues">
              <div v-for="iss in issuesByQuestion['__page__']" :key="iss.id" class="rv-qissue">
                <el-tag :type="sourceTagType(iss.source)" size="small" effect="plain">{{ sourceLabel(iss.source) }}</el-tag>
                <el-tag :type="issueStatusTag(iss.status)" size="small" effect="light">{{ iss.status }}</el-tag>
                <span class="rv-qissue-desc">{{ iss.issueType }} · {{ iss.description }}</span>
                <el-button v-if="iss.status === '待确认'" type="success" size="small" @click="confirmIssueFixed(iss)">
                  ✓ 确认修改完成
                </el-button>
              </div>
            </div>

            <template v-for="d in displayItems" :key="d.itemId">
              <!-- explain：方法点拨块 -->
              <div v-if="d.kind === 'explain'" class="rv-explain">
                <div class="rv-explain-hd">{{ d.explainTitle }}</div>
                <div class="rv-explain-body">
                  <QuestionContent :text="d.explainText ?? null" />
                </div>
              </div>

              <!-- question：QuestionCard 真机渲染 + 审核动作条 -->
              <div v-else class="rv-qwrap">
                <QuestionCard v-if="d.q" :question="d.q" :actions="[]" />
                <!-- 该题已记的问题：直接展示在题卡下，待确认可就地点确认（问题生命周期终点） -->
                <div v-if="d.questionId && issuesByQuestion[d.questionId]?.length" class="rv-qissues">
                  <div v-for="iss in issuesByQuestion[d.questionId]" :key="iss.id" class="rv-qissue">
                    <el-tag :type="sourceTagType(iss.source)" size="small" effect="plain">{{ sourceLabel(iss.source) }}</el-tag>
                    <el-tag :type="issueStatusTag(iss.status)" size="small" effect="light">{{ iss.status }}</el-tag>
                    <span class="rv-qissue-desc">{{ iss.issueType }} · {{ iss.description }}</span>
                    <el-button v-if="iss.status === '待确认'" type="success" size="small" @click="confirmIssueFixed(iss)">
                      ✓ 确认修改完成
                    </el-button>
                  </div>
                </div>
                <div class="rv-qacts">
                  <el-button size="small" type="primary" plain @click="goEdit(d)">改</el-button>
                  <el-button size="small" class="rv-issue-mini" @click="openIssueDialog(d)">记问题</el-button>
                  <!-- 审核置信度（评审效率）：高=可速过 / 低=重点审 -->
                  <span v-if="d.confidence != null" class="rv-conf" :class="confClass(d.confidence)">
                    {{ confLabel(d.confidence) }}
                  </span>
                </div>
              </div>
            </template>
          </template>
          <el-empty v-else-if="!itemsLoading" description="该页暂无系统题目（封面/目录/无题页）">
            <el-button type="primary" :loading="skippingEmpty" @click="skipEmptyPages">
              ⏩ 跳过无题页（自动通过，停在下一个有题页）
            </el-button>
          </el-empty>
        </div>

        <!-- ══ 页级审核栏 ══ -->
        <div class="rv-pagereview" :class="{ done: pageReviewed }">
          <div class="rv-pr-txt">
            <template v-if="pageReviewed">本页已通过 ✓</template>
            <template v-else>整页看过没问题？</template>
            <em v-if="issuesOnPage.length">本页已记 {{ issuesOnPage.length }} 个问题</em>
          </div>
          <el-button text class="rv-pr-issue" @click="openIssueDialog()">记整页问题</el-button>
          <!-- 本页有「待处理」问题（刚记完 bug）→ 主按钮=直接下一页（不通过）；无待处理才显示「本页通过」 -->
          <el-button
            v-if="pageHasPending"
            type="warning"
            class="rv-pr-btn"
            @click="nextPage"
          >
            已记问题 · 直接下一页 ›
          </el-button>
          <el-button
            v-else
            type="primary"
            class="rv-pr-btn"
            :loading="confirming"
            @click="onConfirmPage"
          >
            🖊 本页通过　翻下一页 ›
          </el-button>
        </div>
      </div>
    </div>

    <!-- ══ 记问题对话框：先选标签暂存，点「完成录入」才落库 ══ -->
    <el-dialog
      v-model="issueDialogVisible"
      title="记问题 · 选好后点「完成录入」"
      width="560px"
      append-to-body
      class="rv-issue-dialog"
      :before-close="beforeCloseIssueDialog"
    >
      <!-- 目标信息条 -->
      <div class="rv-iss-meta">
        <el-tag type="info" effect="plain" size="small">源页 P.{{ page }}</el-tag>
        <template v-if="issueTarget.questionId">
          <el-tag effect="plain" size="small" class="rv-iss-qtag">题 {{ shortId(issueTarget.questionId) }}</el-tag>
          <el-button link type="primary" size="small" @click="issueTarget.questionId = null">改为整页问题</el-button>
        </template>
        <span v-else class="rv-form-hint">整页问题（不关联具体题）</span>
        <span v-if="draftIssues.length" class="rv-iss-count">待录 {{ draftIssues.length }} 条（未保存）</span>
      </div>

      <!-- 快捷标签区：点选中/再点取消，仅暂存 -->
      <div class="rv-tag-groups">
        <div v-for="g in QUICK_ISSUE_GROUPS" :key="g.category" class="rv-tag-group">
          <div class="rv-tag-cat">{{ g.category }}</div>
          <div class="rv-tag-chips">
            <button
              v-for="t in g.tags"
              :key="t"
              type="button"
              class="rv-chip"
              :class="{ hit: tagSelected[t] }"
              @click="toggleDraftTag(g.category, t)"
            >
              <span class="rv-chip-txt">{{ t }}</span>
              <span v-if="tagSelected[t]" class="rv-chip-hit">✓</span>
            </button>
          </div>
        </div>
      </div>
      <p class="rv-tag-tip">点标签选中（再点取消）；🔴 只有点底部「完成录入」才会保存进系统。</p>

      <!-- 补充说明（默认收起，特殊问题需打字时展开） -->
      <div class="rv-supp">
        <el-button link type="primary" class="rv-supp-toggle" @click="supplementOpen = !supplementOpen">
          {{ supplementOpen ? '收起补充说明 ▴' : '＋ 补充说明（特殊问题需打字时展开）' }}
        </el-button>
        <div v-if="supplementOpen" class="rv-supp-body">
          <div class="rv-supp-row">
            <el-select v-model="supplementType" placeholder="归类（可选）" size="small" clearable style="width: 140px">
              <el-option v-for="c in supplementTypeOptions" :key="c" :label="c" :value="c" />
            </el-select>
            <el-button type="primary" size="small" @click="addSupplementDraft">加入待录</el-button>
          </div>
          <el-input
            v-model="supplementText"
            type="textarea"
            :rows="3"
            placeholder="如：看图列式的小鸡图未渲染，学生无法作答…"
            maxlength="500"
            show-word-limit
          />
        </div>
        <!-- 已加入草稿的补充说明条目（可删） -->
        <div v-if="draftIssues.some((d) => d.kind === 'text')" class="rv-draft-texts">
          <template v-for="(d, di) in draftIssues" :key="di">
            <el-tag
              v-if="d.kind === 'text'"
              closable
              type="info"
              effect="plain"
              size="small"
              class="rv-draft-tag"
              @close="removeDraft(di)"
            >
              {{ d.category }}：{{ d.description.length > 24 ? d.description.slice(0, 24) + '…' : d.description }}
            </el-tag>
          </template>
        </div>
      </div>

      <template #footer>
        <el-button @click="beforeCloseIssueDialog(() => (issueDialogVisible = false))">取消</el-button>
        <el-button
          type="primary"
          :loading="finishSubmitting"
          :disabled="!draftIssues.length"
          @click="finishRecord"
        >
          完成录入{{ draftIssues.length ? `（${draftIssues.length} 条）` : '' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- ══ 本书问题清单抽屉 ══ -->
    <el-drawer v-model="issuesDrawerVisible" title="本书问题清单" size="480px" append-to-body>
      <div class="rv-issue-filters">
        <el-select v-model="filterType" placeholder="全部类型" clearable size="small" style="width: 132px">
          <el-option v-for="t in typeFilterOptions" :key="t" :label="t" :value="t" />
        </el-select>
        <el-select v-model="filterStatus" placeholder="全部状态" clearable size="small" style="width: 108px">
          <el-option v-for="s in ISSUE_STATUSES" :key="s" :label="s" :value="s" />
        </el-select>
        <el-select v-model="filterSource" placeholder="全部来源" clearable size="small" style="width: 96px">
          <el-option v-for="s in ISSUE_SOURCES" :key="s.value" :label="s.label" :value="s.value" />
        </el-select>
        <el-button size="small" class="rv-export-btn" :disabled="!shownIssues.length" @click="exportIssues">
          导出 CSV
        </el-button>
        <span class="rv-issue-count">共 {{ shownIssues.length }} 条</span>
      </div>

      <!-- 协同闭环进度条：待处理 → 待确认(点确认) → 已确认 -->
      <div class="rv-issue-flow">
        <span class="rv-flow-seg rv-flow-todo">待处理 {{ issueStat['待处理'] }}</span>
        <span class="rv-flow-arrow">→</span>
        <span class="rv-flow-seg rv-flow-confirm">待你确认 {{ issueStat['待确认'] }}</span>
        <span class="rv-flow-arrow">→</span>
        <span class="rv-flow-seg rv-flow-done">已确认 {{ issueStat['已确认'] }}</span>
        <span v-if="allIssuesCleared" class="rv-flow-cleared">✓ 全部闭环</span>
      </div>
      <p class="rv-flow-tip">
        问题生命周期：你标问题 → Claude 修改（待你确认）→ <b>点问题行跳到那一页</b>复看 → 点「确认修改完成」即结束。
      </p>

      <el-table
        v-loading="drawerLoading"
        :data="shownIssues"
        size="small"
        style="width: 100%"
        empty-text="暂无登记问题"
        :row-class-name="({ row }) => (row.status === '待确认' ? 'rv-row-confirm rv-row-click' : 'rv-row-click')"
        @row-click="gotoIssuePage"
      >
        <el-table-column label="页" width="46" align="center">
          <template #default="{ row }">{{ row.sourcePage ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="来源" width="58" align="center">
          <template #default="{ row }">
            <el-tag :type="sourceTagType(row.source)" size="small" effect="plain">{{ sourceLabel(row.source) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="80">
          <template #default="{ row }">{{ row.issueType }}</template>
        </el-table-column>
        <el-table-column label="描述" min-width="110">
          <template #default="{ row }">
            <span class="rv-issue-desc" :title="row.description || ''">{{ row.description || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态 / 操作" width="128">
          <template #default="{ row }">
            <!-- 待确认：一键「确认修改完成」= 老师侧闭环动作（.stop 防触发行点击跳页） -->
            <el-button
              v-if="row.status === '待确认'"
              type="success"
              size="small"
              class="rv-confirm-btn"
              @click.stop="confirmIssueFixed(row)"
            >
              ✓ 确认修改完成
            </el-button>
            <!-- 其余状态：下拉手动流转 -->
            <el-dropdown v-else trigger="click" @command="(s: string) => changeIssueStatus(row, s)">
              <el-tag
                :type="issueStatusTag(row.status)"
                effect="light"
                size="small"
                class="rv-status-tag"
                @click.stop
              >
                {{ row.status }} ▾
              </el-tag>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item v-for="s in ISSUE_STATUSES" :key="s" :command="s">{{ s }}</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
        </el-table-column>
      </el-table>
    </el-drawer>
  </div>
</template>

<style scoped>
.review-page {
  max-width: 1180px;
  margin: 0 auto;
  padding: 14px 24px 40px;
}

/* ── 顶栏 ── */
.rv-top {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 16px;
  background: #fff;
  border: 1px solid var(--bk-line);
  border-radius: 12px 12px 0 0;
  flex-wrap: wrap;
}
.rv-back {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  transition: color 0.15s;
}
.rv-back:hover {
  color: var(--bk-teal);
}
.rv-title {
  font-size: 15px;
  font-weight: 800;
  color: var(--bk-ink);
}
.rv-prog {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
}
.rv-prog-num {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}
.rv-prog-bar {
  width: 130px;
  height: 7px;
  border-radius: 6px;
  background: var(--bg-100, #edf2f2);
  overflow: hidden;
}
.rv-prog-bar > i {
  display: block;
  height: 100%;
  background: var(--bk-teal);
  transition: width 0.25s ease;
}
.rv-done-badge {
  font-size: 12px;
  font-weight: 800;
  color: var(--bk-red-pen, #e0526b);
  background: #fdecef;
  border: 1px solid #f4c6d0;
  border-radius: 999px;
  padding: 1px 11px;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.rv-issues-btn b {
  color: var(--bk-teal-deep);
  margin-left: 2px;
}
.rv-pager {
  display: flex;
  align-items: center;
  gap: 6px;
}
/* ⚡ 速审按钮（高置信连续页一键通过） */
.rv-speed-btn {
  font-weight: 700;
}
/* 页级置信档位（pane 头）：hi 绿可速过 / mid 灰常规 / lo 红重点审 */
.rv-page-tier {
  text-transform: none;
  letter-spacing: 0;
  font-size: 11px;
  font-weight: 700;
  padding: 1px 8px;
  border-radius: 999px;
}
.rv-page-tier.hi {
  color: #237804;
  background: #e6f4e0;
}
.rv-page-tier.mid {
  color: #6b7671;
  background: #eef1f0;
}
.rv-page-tier.lo {
  color: #c02b3d;
  background: #fbe9ec;
}
.rv-pgbtn {
  width: 29px;
  height: 29px;
  border-radius: 6px;
  border: 1px solid var(--el-border-color, #e3e9e9);
  background: #fff;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  font-size: 16px;
  display: grid;
  place-items: center;
  transition: 0.15s;
}
.rv-pgbtn:hover:not(:disabled) {
  color: var(--bk-teal);
  border-color: var(--bk-teal);
}
.rv-pgbtn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.rv-pgnum {
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  min-width: 44px;
  text-align: center;
}

/* ── 左右分栏 ── */
.rv-split {
  display: grid;
  grid-template-columns: 1fr 1fr;
  min-height: 540px;
  border: 1px solid var(--bk-line);
  border-top: none;
  border-radius: 0 0 12px 12px;
  overflow: hidden;
  background: #fff;
}
.rv-pane {
  padding: 14px 16px;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.rv-left {
  border-right: 1px solid var(--bk-line);
  background: var(--bg-50, #f5f8f8);
}
.rv-pane-h {
  font-size: 11.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--el-text-color-secondary);
  font-weight: 700;
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.rv-pane-h-sub {
  text-transform: none;
  letter-spacing: 0;
  color: var(--bk-amber, #d97706);
  font-weight: 600;
  font-size: 11px;
}

/* 源页图 */
.rv-src-wrap {
  flex: 1;
  min-height: 480px;
  display: flex;
  align-items: flex-start;
  justify-content: center;
}
.rv-src-img {
  width: 100%;
  border: 1px solid var(--bk-line);
  border-radius: 6px;
  background: #fff;
  box-shadow: var(--shadow, 0 1px 4px rgba(19, 49, 43, 0.06));
}
.rv-src-img :deep(img) {
  border-radius: 6px;
}
.rv-src-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  color: var(--el-text-color-secondary);
  padding-top: 80px;
  font-size: 13px;
}

/* 右侧题项 */
.rv-items {
  flex: 1;
  min-height: 200px;
}
.rv-qwrap {
  margin-bottom: 12px;
}
.rv-qacts {
  display: flex;
  gap: 8px;
  margin-top: -2px;
  padding: 0 2px 2px;
}
.rv-issue-mini {
  color: var(--bk-amber, #d97706);
  border-color: #f0d9a8;
}
.rv-issue-mini:hover {
  color: #b45f06;
  border-color: var(--bk-amber, #d97706);
  background: #fdf6ea;
}

/* explain 方法点拨块 */
.rv-explain {
  margin: 4px 0 14px;
  padding: 12px 16px;
  background: #fbf9f3;
  border: 1px solid #efe7d4;
  border-left: 3px solid #e2c893;
  border-radius: 0 8px 8px 0;
}
.rv-explain-hd {
  font-size: 13px;
  font-weight: 800;
  color: #9a6a12;
  margin-bottom: 6px;
}
.rv-explain-body {
  color: #33322c;
  font-size: 14px;
  line-height: 1.7;
}

/* ── 页级审核栏 ── */
.rv-pagereview {
  position: sticky;
  bottom: 0;
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  background: var(--bk-teal-soft, #e6f3f1);
  border: 1px solid #cfe4e2;
  border-left: 3px solid var(--bk-red-pen, #e0526b);
  border-radius: 8px;
  padding: 12px 14px;
}
.rv-pagereview.done {
  border-left-color: var(--success, #0e9f6e);
  background: #eafaf3;
}
.rv-pr-txt {
  font-size: 13px;
  color: var(--bk-ink);
  font-weight: 600;
}
.rv-pr-txt em {
  font-style: normal;
  color: var(--bk-amber, #d97706);
  font-weight: 600;
  margin-left: 8px;
  font-size: 12px;
}
.rv-pr-issue {
  margin-left: auto;
  color: var(--el-text-color-secondary);
}
.rv-pr-btn {
  font-size: 13.5px;
}

/* 记问题对话框 */
.rv-form-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-left: 8px;
}
.rv-linked-q {
  font-size: 13px;
  font-weight: 600;
  color: var(--bk-teal-deep);
  margin-right: 8px;
}

/* ── 记问题弹窗：快捷标签 ── */
.rv-iss-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding-bottom: 12px;
  margin-bottom: 4px;
  border-bottom: 1px dashed var(--bk-line);
}
.rv-iss-qtag {
  color: var(--bk-teal-deep);
  font-weight: 600;
}
.rv-iss-count {
  margin-left: auto;
  font-size: 12px;
  font-weight: 700;
  color: var(--bk-teal-deep);
  background: var(--bk-teal-soft, #e6f3f1);
  border-radius: 999px;
  padding: 2px 10px;
}
.rv-tag-groups {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 12px;
}
.rv-tag-group {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.rv-tag-cat {
  flex: 0 0 44px;
  font-size: 12.5px;
  font-weight: 800;
  color: var(--el-text-color-secondary);
  padding-top: 6px;
  text-align: right;
}
.rv-tag-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  flex: 1;
  min-width: 0;
}
.rv-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 13px;
  border-radius: 999px;
  border: 1px solid var(--bk-line, #d9e4e2);
  background: #fff;
  color: var(--bk-ink);
  font-size: 13px;
  line-height: 1.4;
  cursor: pointer;
  transition: all 0.14s ease;
  user-select: none;
}
.rv-chip:hover {
  border-color: var(--bk-teal, #2fa39a);
  color: var(--bk-teal-deep, #1f7a72);
  background: var(--bk-teal-soft, #e6f3f1);
}
.rv-chip:active {
  transform: scale(0.94);
}
.rv-chip.hit {
  border-color: var(--bk-teal, #2fa39a);
  background: var(--bk-teal, #2fa39a);
  color: #fff;
  font-weight: 600;
}
.rv-chip.hit:hover {
  background: var(--bk-teal-deep, #1f7a72);
  color: #fff;
}
.rv-chip-hit {
  font-size: 11px;
  font-weight: 700;
}
.rv-tag-tip {
  margin: 12px 0 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* ── 补充说明（默认收起） ── */
.rv-supp {
  margin-top: 8px;
  padding-top: 10px;
  border-top: 1px dashed var(--bk-line);
}
.rv-supp-toggle {
  font-size: 12.5px;
}
.rv-supp-body {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.rv-supp-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.rv-iss-foot-hint {
  font-size: 12px;
  color: var(--bk-teal-deep);
  font-weight: 600;
  margin-right: 8px;
}

/* 问题清单抽屉 */
.rv-issue-filters {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.rv-export-btn {
  color: var(--bk-teal-deep);
}
.rv-export-btn:hover:not(:disabled) {
  color: #fff;
  background: var(--bk-teal);
  border-color: var(--bk-teal);
}
.rv-issue-count {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-left: auto;
}
.rv-issue-desc {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
}
.rv-status-tag {
  cursor: pointer;
}

/* ── 协同闭环进度条 ── */
.rv-issue-flow {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 10px;
  margin-bottom: 10px;
  border-radius: 6px;
  background: var(--bk-teal-soft, #e6f3f1);
  font-size: 12.5px;
}
.rv-flow-seg {
  padding: 2px 8px;
  border-radius: 4px;
  font-weight: 600;
}
.rv-flow-todo {
  color: #b76a00;
  background: #fdf3e6;
}
.rv-flow-confirm {
  color: #0f766e;
  background: #d6ece9;
}
.rv-flow-done {
  color: #237804;
  background: #e6f4e0;
}
.rv-flow-arrow {
  color: var(--el-text-color-secondary);
}
.rv-flow-cleared {
  margin-left: auto;
  color: var(--bk-teal-deep, #0b5d56);
  font-weight: 700;
}
/* 待确认行高亮：老师这轮要动的 */
:deep(.rv-row-confirm) {
  background: var(--bk-teal-soft, #eef8f6);
}
/* 问题行可点跳页 */
:deep(.rv-row-click) {
  cursor: pointer;
}
/* 题卡下挂的问题条（就地闭环） */
.rv-qissues {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 6px 0 2px;
  padding: 8px 10px;
  border-radius: 6px;
  background: #fdf9ef;
  border: 1px dashed #e5c580;
}
.rv-pageissues {
  background: var(--bk-teal-soft, #e6f3f1);
  border-color: var(--bk-teal, #0f766e);
}
.rv-qissue {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.rv-qissue-desc {
  font-size: 12.5px;
  color: var(--el-text-color-primary);
  flex: 1;
  min-width: 0;
}
/* 置信度徽标（评审效率）：高绿可速过 / 中灰常规 / 低红重点审 */
.rv-conf {
  margin-left: auto;
  font-size: 11.5px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
}
.rv-conf.hi {
  color: #237804;
  background: #e6f4e0;
}
.rv-conf.mid {
  color: #6b7671;
  background: #eef1f0;
}
.rv-conf.lo {
  color: #c02b3d;
  background: #fbe9ec;
}
.rv-flow-tip {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin: 0 0 10px;
  line-height: 1.6;
}
/* 记问题草稿：已加入的补充说明条目 */
.rv-draft-texts {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.rv-draft-tag {
  max-width: 100%;
}
.rv-confirm-btn {
  --el-button-size: 26px;
  padding: 4px 8px;
  font-weight: 600;
}
.rv-confirm-badge {
  margin-left: 8px;
}
.rv-confirm-hint {
  font-size: 12px;
  color: var(--bk-teal-deep, #0b5d56);
  font-weight: 600;
}

/* 响应式：窄屏上下堆叠 */
@media (max-width: 860px) {
  .rv-split {
    grid-template-columns: 1fr;
  }
  .rv-left {
    border-right: none;
    border-bottom: 1px solid var(--bk-line);
  }
  .rv-src-wrap {
    min-height: 320px;
  }
}
</style>
