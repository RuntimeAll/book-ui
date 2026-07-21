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
import { ElMessage } from 'element-plus'
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
  createIssue,
  listIssues,
  updateIssueStatus,
  ISSUE_TYPES,
  ISSUE_STATUSES,
  type ReviewPageItem,
  type ReviewIssue,
} from '@/api/review'

const route = useRoute()
const router = useRouter()
const bookId = String(route.params.bookId)

// ── 顶栏状态 ──────────────────────────────────────────────────────────────────
const bookTitle = ref('')
const totalPages = ref(0)
const reviewedPages = ref(0)
const page = ref(clampPage(Number(route.query.page) || 1))

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
}
const displayItems = ref<DisplayItem[]>([])
const questionCount = computed(() => displayItems.value.filter((d) => d.kind === 'question').length)

// ── 问题登记 ──────────────────────────────────────────────────────────────────
const issues = ref<ReviewIssue[]>([])
const issuesOnPage = computed(() => issues.value.filter((i) => i.sourcePage === page.value))

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
      }
    })
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
  if (canPrev.value) goPage(page.value - 1)
}
function nextPage() {
  if (canNext.value) goPage(page.value + 1)
}

// page 变 → 重载左右 + 同步 URL（router.replace 不触发重挂）
watch(page, () => {
  router.replace({ query: { ...route.query, page: String(page.value) } })
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
    await confirmPage(bookId, page.value)
    pageReviewed.value = true
    ElMessage.success(`第 ${page.value} 页已通过`)
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
// 「改」→ 题目详情页（复用 detail.vue；改完 router.back 返回本页自动刷新）
// ═══════════════════════════════════════════════════════════════════════════
function goEdit(d: DisplayItem) {
  if (!d.questionId) {
    ElMessage.warning('该题项无题库题（无法定位详情）')
    return
  }
  router.push(`/question/detail/${d.questionId}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// 「记问题」对话框
// ═══════════════════════════════════════════════════════════════════════════
const issueDialogVisible = ref(false)
const issueSubmitting = ref(false)
const issueForm = ref<{ questionId: string | null; issueType: string; description: string }>({
  questionId: null,
  issueType: ISSUE_TYPES[0],
  description: '',
})

function openIssueDialog(d?: DisplayItem) {
  issueForm.value = {
    questionId: d?.questionId ?? null,
    issueType: ISSUE_TYPES[0],
    description: '',
  }
  issueDialogVisible.value = true
}
function shortId(id: string | null | undefined): string {
  if (!id) return ''
  const s = String(id)
  return s.length > 6 ? `…${s.slice(-6)}` : s
}
async function submitIssue() {
  if (!issueForm.value.issueType) {
    ElMessage.warning('请选择问题类型')
    return
  }
  issueSubmitting.value = true
  try {
    await createIssue({
      bookId,
      questionId: issueForm.value.questionId,
      sourcePage: page.value,
      issueType: issueForm.value.issueType,
      description: issueForm.value.description.trim() || undefined,
    })
    ElMessage.success('已登记问题')
    issueDialogVisible.value = false
    await loadIssues()
    if (issuesDrawerVisible.value) await loadDrawerIssues()
  } catch {
    /* http 拦截器已弹错 */
  } finally {
    issueSubmitting.value = false
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 本书问题清单（抽屉：筛选 + 状态流转）
// ═══════════════════════════════════════════════════════════════════════════
const issuesDrawerVisible = ref(false)
const filterType = ref('')
const filterStatus = ref('')
/** 抽屉表格数据 = 服务端按 type/status 过滤（GET /issues?type&status），与顶栏 issues 全量分开。 */
const drawerIssues = ref<ReviewIssue[]>([])
const drawerLoading = ref(false)
async function loadDrawerIssues() {
  drawerLoading.value = true
  try {
    drawerIssues.value = await listIssues(
      bookId,
      filterType.value || undefined,
      filterStatus.value || undefined,
    )
  } catch {
    drawerIssues.value = []
  } finally {
    drawerLoading.value = false
  }
}
/** 客户端兜底过滤（BE 若忽略 type/status 参数也保证展示正确）。 */
const shownIssues = computed(() =>
  drawerIssues.value.filter(
    (i) =>
      (!filterType.value || i.issueType === filterType.value) &&
      (!filterStatus.value || i.status === filterStatus.value),
  ),
)
// 打开抽屉 / 改筛选 → 服务端重取（?type&status）
watch(issuesDrawerVisible, (open) => {
  if (open) void loadDrawerIssues()
})
watch([filterType, filterStatus], () => {
  if (issuesDrawerVisible.value) void loadDrawerIssues()
})
function issueStatusTag(s: string): 'info' | 'success' | 'warning' {
  if (s === '已改') return 'success'
  if (s === '搁置') return 'info'
  return 'warning'
}
async function changeIssueStatus(row: ReviewIssue, status: string) {
  if (status === row.status) return
  try {
    await updateIssueStatus(row.id, status)
    ElMessage.success('状态已更新')
    await Promise.all([loadIssues(), loadDrawerIssues()])
  } catch {
    /* http 拦截器已弹错 */
  }
}

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
  await Promise.all([loadBook(), loadProgress(), loadIssues()])
  await Promise.all([loadSourcePage(), loadPageItems()])
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
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
          <span class="rv-pane-h-sub">整页比对，不逐题确认</span>
        </div>

        <div v-loading="itemsLoading" class="rv-items">
          <template v-if="displayItems.length">
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
                <div class="rv-qacts">
                  <el-button size="small" type="primary" plain @click="goEdit(d)">改</el-button>
                  <el-button size="small" class="rv-issue-mini" @click="openIssueDialog(d)">记问题</el-button>
                </div>
              </div>
            </template>
          </template>
          <el-empty v-else-if="!itemsLoading" description="该页暂无系统题目（source_page 未回填或本页无题）" />
        </div>

        <!-- ══ 页级审核栏 ══ -->
        <div class="rv-pagereview" :class="{ done: pageReviewed }">
          <div class="rv-pr-txt">
            <template v-if="pageReviewed">本页已通过 ✓</template>
            <template v-else>整页看过没问题？</template>
            <em v-if="issuesOnPage.length">本页已记 {{ issuesOnPage.length }} 个问题</em>
          </div>
          <el-button text class="rv-pr-issue" @click="openIssueDialog()">记整页问题</el-button>
          <el-button
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

    <!-- ══ 记问题对话框 ══ -->
    <el-dialog v-model="issueDialogVisible" title="记一条问题" width="480px" append-to-body>
      <el-form label-width="72px">
        <el-form-item label="源页">
          <el-tag type="info" effect="plain">P.{{ page }}</el-tag>
          <span class="rv-form-hint">（当前页自动带入）</span>
        </el-form-item>
        <el-form-item label="关联题">
          <template v-if="issueForm.questionId">
            <span class="rv-linked-q">题 {{ shortId(issueForm.questionId) }}</span>
            <el-button link type="primary" size="small" @click="issueForm.questionId = null">改为整页问题</el-button>
          </template>
          <span v-else class="rv-form-hint">整页问题（不关联具体题）</span>
        </el-form-item>
        <el-form-item label="问题类型">
          <el-select v-model="issueForm.issueType" style="width: 100%">
            <el-option v-for="t in ISSUE_TYPES" :key="t" :label="t" :value="t" />
          </el-select>
        </el-form-item>
        <el-form-item label="描述">
          <el-input
            v-model="issueForm.description"
            type="textarea"
            :rows="4"
            placeholder="如：看图列式的小鸡图未渲染，学生无法作答…"
            maxlength="500"
            show-word-limit
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="issueDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="issueSubmitting" @click="submitIssue">登记</el-button>
      </template>
    </el-dialog>

    <!-- ══ 本书问题清单抽屉 ══ -->
    <el-drawer v-model="issuesDrawerVisible" title="本书问题清单" size="480px" append-to-body>
      <div class="rv-issue-filters">
        <el-select v-model="filterType" placeholder="全部类型" clearable size="small" style="width: 132px">
          <el-option v-for="t in ISSUE_TYPES" :key="t" :label="t" :value="t" />
        </el-select>
        <el-select v-model="filterStatus" placeholder="全部状态" clearable size="small" style="width: 108px">
          <el-option v-for="s in ISSUE_STATUSES" :key="s" :label="s" :value="s" />
        </el-select>
        <el-button size="small" class="rv-export-btn" :disabled="!shownIssues.length" @click="exportIssues">
          导出 CSV
        </el-button>
        <span class="rv-issue-count">共 {{ shownIssues.length }} 条</span>
      </div>
      <el-table
        v-loading="drawerLoading"
        :data="shownIssues"
        size="small"
        style="width: 100%"
        empty-text="暂无登记问题"
      >
        <el-table-column label="页" width="52" align="center">
          <template #default="{ row }">{{ row.sourcePage ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="类型" width="92">
          <template #default="{ row }">{{ row.issueType }}</template>
        </el-table-column>
        <el-table-column label="描述" min-width="120">
          <template #default="{ row }">
            <span class="rv-issue-desc" :title="row.description || ''">{{ row.description || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-dropdown trigger="click" @command="(s: string) => changeIssueStatus(row, s)">
              <el-tag :type="issueStatusTag(row.status)" effect="light" size="small" class="rv-status-tag">
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
