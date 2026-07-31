<script setup lang="ts">
/**
 * 书架页（2026-07-31 真书架分层改版）。
 * 陈列逻辑对齐真书架：一级分层 = 书的类型（每日打卡 / PDF 成品 / 专项 / 讲义 / 练习册 / 课本），
 * 层内按「年级 · 册」聚成一块块层板（cluster），书立在层板上；无年级书归「未分类」放层尾。
 * 筛选收敛为一行工具栏（搜索 + 学科 + 年级[按学段分组下拉] + 册），类型改为带数量的分层导航。
 * 数据源 = /teacher/shelf/book/page（owner 过滤）一次全量拉回、纯前端过滤分组。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  pageBooks,
  createBook,
  deleteBook,
  exportBook,
  readBookPdfMeta,
  readBookPunchExport,
  BOOK_TYPE_LABEL,
  type BookType,
  type BookNetdisk,
  type BookPromo,
  type ShelfBookVO,
} from '@/api/shelf'
import { exportPunchBook, getPunchBookExportStatus } from '@/api/teacher/punch'
import {
  useDictStore,
  DICT_EDU_SUBJECT, DICT_EDU_STAGE, DICT_EDU_GRADE, DICT_EDU_VOLUME,
} from '@/store/dict'
import { getProgress, type ReviewProgress } from '@/api/review'
import LineIcon from '@/components/LineIcon.vue'
import BookCard from './components/BookCard.vue'
import NetdiskDialog from './components/NetdiskDialog.vue'
import PromoDialog from './components/PromoDialog.vue'
import ImportPdfDialog from './components/ImportPdfDialog.vue'

const router = useRouter()
const dict = useDictStore()

// ══ 筛选状态（'' = 全部）══════════════════════════════════════════
type NumOrAll = number | ''
const typeFilter = ref<'' | BookType>('')
const subjectFilter = ref<NumOrAll>('')
const gradeFilter = ref<NumOrAll>('')
const volumeFilter = ref<NumOrAll>('')
const keyword = ref('')

const GRADE_NUM: Record<number, string> = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八', 9: '九', 10: '高一', 11: '高二', 12: '高三' }
const STAGE_GRADES: { label: string; grades: number[] }[] = [
  { label: '小学', grades: [1, 2, 3, 4, 5, 6] },
  { label: '初中', grades: [7, 8, 9] },
  { label: '高中', grades: [10, 11, 12] },
]

// 分层顺序 = 商业优先级：打卡 SKU → PDF 成品 → 专项 → 讲义 → 练习册 → 电子课本。
// special=备课栏工作集被 BE 剔出书架列表，不设层。
const TYPE_ORDER: BookType[] = ['daily_punch', 'pdf_pending', 'variant_special', 'lecture', 'workbook', 'textbook']

const loading = ref(false)
const books = ref<ShelfBookVO[]>([])

// 🔴 PRD-006 AC5 — 每本书的录入审核进度（角标）。bookId → 进度。
// 不阻塞列表渲染：load() 只等书列表，进度角标 fire-and-forget、限并发池逐本回填。
const progressMap = ref<Record<string, ReviewProgress>>({})

async function load() {
  loading.value = true
  try {
    const res = await pageBooks({})
    books.value = res?.rows ?? []
    void loadProgressBadges(books.value)
  } catch (e) {
    console.warn('[shelf] 加载书架失败:', e)
    ElMessage.error('加载书架失败')
    books.value = []
  } finally {
    loading.value = false
  }
}

/** 限并发（5）逐本拉审核进度回填 progressMap；单本失败静默（角标非关键，不打断列表）。 */
async function loadProgressBadges(list: ShelfBookVO[]) {
  progressMap.value = {}
  // 待解析书没有页级录入审核，不必拉进度
  const ids = list.filter((b) => String(b.bookType) !== 'pdf_pending').map((b) => b.id)
  let idx = 0
  const worker = async () => {
    while (idx < ids.length) {
      const id = ids[idx++]
      try {
        const p = await getProgress(id)
        if (p) progressMap.value = { ...progressMap.value, [id]: p }
      } catch {
        /* 角标失败静默 */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, ids.length) }, worker))
}

/** 书卡审核角标：totalPages>0 才展示；done = 全书页审完。 */
const reviewInfoMap = computed(() => {
  const m: Record<string, { reviewed: number; total: number; pct: number; done: boolean }> = {}
  for (const [id, p] of Object.entries(progressMap.value)) {
    const total = Number(p?.totalPages ?? 0)
    if (total <= 0) continue
    const reviewed = Math.max(0, Math.min(Number(p?.reviewedPages ?? 0), total))
    m[id] = { reviewed, total, pct: Math.round((reviewed / total) * 100), done: reviewed >= total }
  }
  return m
})

// ── 维度可用集（缺该维度数据的选项置灰）──
const subjectsAvail = computed(() => new Set(books.value.map((b) => b.subjectCode).filter((v): v is number => v != null)))
const volumesAvail = computed(() => new Set(books.value.map((b) => b.volumeCode).filter((v): v is number => v != null)))
// 年级：受选中学科收窄，只亮真有书的年级
const gradesAvail = computed(() => {
  const s = new Set<number>()
  for (const b of books.value) {
    if (b.gradeCode == null) continue
    if (subjectFilter.value !== '' && b.subjectCode !== subjectFilter.value) continue
    s.add(b.gradeCode)
  }
  return s
})
// 年级下拉分组：按学段（小学/初中/高中）挂组，只列有书的年级
const gradeGroups = computed(() => {
  const all = new Set(books.value.map((b) => b.gradeCode).filter((v): v is number => v != null))
  return STAGE_GRADES
    .map((st) => ({ label: st.label, grades: st.grades.filter((g) => all.has(g)) }))
    .filter((st) => st.grades.length > 0)
})

const subjectList = computed(() => dict.list(DICT_EDU_SUBJECT))

/** 年级文案：优先字典中文名，字典未到货回落 GRADE_NUM（一年级…高三）。 */
function gradeLabel(g: number): string {
  const l = dict.label(DICT_EDU_GRADE, g)
  if (l && l !== String(g)) return l
  const n = GRADE_NUM[g]
  if (!n) return String(g)
  return g >= 10 ? n : `${n}年级`
}

function pickSubject(v: NumOrAll) { subjectFilter.value = subjectFilter.value === v ? '' : v }
function pickVolume(v: NumOrAll) { volumeFilter.value = volumeFilter.value === v ? '' : v }
function pickType(v: '' | BookType) { typeFilter.value = v }

const hasActiveFilter = computed(() =>
  typeFilter.value !== '' || subjectFilter.value !== '' ||
  gradeFilter.value !== '' || volumeFilter.value !== '' || keyword.value.trim() !== '',
)
function resetFilters() {
  typeFilter.value = ''
  subjectFilter.value = ''
  gradeFilter.value = ''
  volumeFilter.value = ''
  keyword.value = ''
}

// ── 过滤（类型除外——类型是分层导航，单独套在 sections 上）──
const dimFiltered = computed<ShelfBookVO[]>(() => {
  const kw = keyword.value.trim().toLowerCase()
  return books.value.filter((b) => {
    if (subjectFilter.value !== '' && b.subjectCode !== subjectFilter.value) return false
    if (gradeFilter.value !== '' && b.gradeCode !== gradeFilter.value) return false
    if (volumeFilter.value !== '' && b.volumeCode !== volumeFilter.value) return false
    if (kw) {
      const hay = [b.title, b.subjectId, b.grade, b.edition].filter(Boolean).map((s) => String(s).toLowerCase())
      if (!hay.some((s) => s.includes(kw))) return false
    }
    return true
  })
})

// ── 分层导航（带数量；数量按维度过滤后的集合算，随筛选联动）──
const typeTabs = computed(() => {
  const cnt: Record<string, number> = {}
  for (const b of dimFiltered.value) cnt[String(b.bookType)] = (cnt[String(b.bookType)] ?? 0) + 1
  const tabs: { key: '' | BookType; label: string; n: number }[] = [
    { key: '', label: '全部', n: dimFiltered.value.length },
  ]
  for (const t of TYPE_ORDER) {
    if (cnt[t]) tabs.push({ key: t, label: BOOK_TYPE_LABEL[t], n: cnt[t] })
  }
  return tabs
})

// ── 真书架分组：类型层（section）→ 年级·册层板（cluster）──
interface ShelfCluster { key: string; label: string; books: ShelfBookVO[] }
interface ShelfSection { type: BookType; label: string; count: number; clusters: ShelfCluster[] }

/** 书 → 所属层板（有结构码按年级·册；无码有年级文本按文本；全无归未分类）。 */
function clusterOf(b: ShelfBookVO): { key: string; label: string; ord: number } {
  if (b.gradeCode != null) {
    const vol = b.volumeCode
    const volLab = vol === 1 ? ' · 上册' : vol === 2 ? ' · 下册' : ''
    return { key: `g${b.gradeCode}v${vol ?? 0}`, label: gradeLabel(b.gradeCode) + volLab, ord: b.gradeCode * 10 + (vol ?? 0) }
  }
  const txt = (b.grade ?? '').trim()
  if (txt) return { key: `t:${txt}`, label: txt, ord: 900 }
  return { key: 'none', label: '未分类', ord: 999 }
}

const sections = computed<ShelfSection[]>(() => {
  const byType = new Map<string, ShelfBookVO[]>()
  for (const b of dimFiltered.value) {
    if (typeFilter.value !== '' && String(b.bookType) !== typeFilter.value) continue
    const t = String(b.bookType)
    if (!byType.has(t)) byType.set(t, [])
    byType.get(t)!.push(b)
  }
  // 类型顺序：TYPE_ORDER 优先，未知类型（将来新增）尾随
  const order = [...TYPE_ORDER, ...[...byType.keys()].filter((t) => !TYPE_ORDER.includes(t as BookType))]
  const out: ShelfSection[] = []
  for (const t of order) {
    const list = byType.get(t)
    if (!list?.length) continue
    // 聚层板
    const cm = new Map<string, { label: string; ord: number; books: ShelfBookVO[] }>()
    for (const b of list) {
      const c = clusterOf(b)
      if (!cm.has(c.key)) cm.set(c.key, { label: c.label, ord: c.ord, books: [] })
      cm.get(c.key)!.books.push(b)
    }
    const clusters = [...cm.entries()]
      .sort((a, x) => a[1].ord - x[1].ord || a[1].label.localeCompare(x[1].label, 'zh-Hans-CN'))
      .map(([key, v]) => ({
        key,
        label: v.label,
        books: v.books.sort((a, x) => a.title.localeCompare(x.title, 'zh-Hans-CN')),
      }))
    out.push({ type: t as BookType, label: BOOK_TYPE_LABEL[t as BookType] ?? t, count: list.length, clusters })
  }
  return out
})

const shownCount = computed(() => sections.value.reduce((s, x) => s + x.count, 0))

// 层收放（默认全展开）
const collapsed = ref<Record<string, boolean>>({})
function toggleSection(t: string) {
  collapsed.value = { ...collapsed.value, [t]: !collapsed.value[t] }
}

/** 层头小色点：与封面同色系，一眼对上层与书。 */
function typeDotClass(t: string): string {
  if (t === 'lecture') return 'd1'
  if (t === 'special' || t === 'variant_special') return 'd3'
  if (t === 'daily_punch') return 'd4'
  if (t === 'pdf_pending') return 'd5'
  return 'd2'
}

/** 每日打卡书 = 独立阅读/审核页（PRD-013），与常规书浏览页分流。 */
function isPunchBook(b: ShelfBookVO): boolean {
  return String(b.bookType) === 'daily_punch'
}
function isPdfPendingBook(b: ShelfBookVO): boolean {
  return String(b.bookType) === 'pdf_pending'
}
function isTextbookBook(b: ShelfBookVO): boolean {
  return String(b.bookType) === 'textbook'
}

/**
 * 打开书 —— 按 bookType 分流（PRD-013 FP1 + 2026-07-30 阅读态改版）：
 *   daily_punch → 打卡阅读页 / textbook → 电子课本阅读页 /
 *   pdf_pending → 新窗打开 PDF 本体 / 其他 → 书浏览页
 */
function openBook(b: ShelfBookVO) {
  if (isPunchBook(b)) {
    router.push(`/bookshelf/punch-read/${b.id}`)
    return
  }
  if (isTextbookBook(b)) {
    router.push(`/bookshelf/textbook/${b.id}`)
    return
  }
  if (isPdfPendingBook(b)) {
    const { pdfUrl } = readBookPdfMeta(b)
    if (!pdfUrl) {
      ElMessage.warning('这本书还没有 PDF 文件地址')
      return
    }
    window.open(pdfUrl, '_blank')
    return
  }
  router.push(`/bookshelf/book/${b.id}`)
}

// 🔴 PRD-006 — 录入审核入口（按页比对源书原版 → 逐页确认）
function openReview(b: ShelfBookVO) {
  router.push(`/bookshelf/review/${b.id}`)
}

// 🔴 2026-07-30 拆分 — 打卡书审核入口（独立页，与「打开」的阅读态分离）
function openPunchReview(b: ShelfBookVO) {
  router.push(`/bookshelf/punch/${b.id}`)
}

// ── 卡片「⋯」菜单与导出（逻辑与旧版一致）─────────────────────────
/** 本地触发中的打卡书整册导出（行 styleMeta 还没刷出 running 前先把菜单置灰） */
const punchExporting = ref<Record<string, boolean>>({})
const punchPollTimers: Record<string, ReturnType<typeof setInterval>> = {}

/** 打卡书：提交整册异步导出（题目+解析双卷）→ 轮询到 done 后刷新列表，菜单出现下载项。 */
async function onExportPunch(b: ShelfBookVO) {
  try {
    await exportPunchBook(b.id)
    punchExporting.value[b.id] = true
    ElMessage.success(`「${b.title}」整册导出已开始（后台约 2-5 分钟），完成后在「⋯」菜单下载`)
    startPunchPoll(b.id)
  } catch {
    /* http 拦截器已弹错（含 running 撞并发闸的 409） */
  }
}

function startPunchPoll(bookId: string) {
  stopPunchPoll(bookId)
  punchPollTimers[bookId] = setInterval(async () => {
    try {
      const res = await getPunchBookExportStatus(bookId)
      const st = res?.export
      if (!st || st.status !== 'running') {
        stopPunchPoll(bookId)
        punchExporting.value[bookId] = false
        if (st?.status === 'done') ElMessage.success('整册 PDF 已导好——「⋯」菜单可下载')
        else if (st?.status === 'failed') ElMessage.error(st.error || '整册导出失败，可重试')
        void load()   // 刷行上 styleMeta，让下载项亮出来
      }
    } catch {
      /* 单拍失败不停轮询（网络抖动） */
    }
  }, 5_000)
}

function stopPunchPoll(bookId: string) {
  const t = punchPollTimers[bookId]
  if (t != null) {
    clearInterval(t)
    delete punchPollTimers[bookId]
  }
}

onUnmounted(() => {
  for (const id of Object.keys(punchPollTimers)) stopPunchPoll(id)
})

/** 普通书：BE 同步整书导出（大书 1-3 分钟）→ 新窗打开。 */
const exportingBookId = ref('')
async function onExportGeneric(b: ShelfBookVO) {
  if (exportingBookId.value) {
    ElMessage.info('已有整书导出在跑，请稍候')
    return
  }
  exportingBookId.value = b.id
  ElMessage.info(`正在生成「${b.title}」整书 PDF（大书约 1-3 分钟），完成后自动打开…`)
  try {
    const res = await exportBook(b.id)
    if (res?.url) window.open(res.url, '_blank')
    else ElMessage.warning('导出未返回文件地址')
  } catch {
    /* http 拦截器已弹错 */
  } finally {
    exportingBookId.value = ''
  }
}

/** 菜单统一分发。 */
function onCardMenu(cmd: string, b: ShelfBookVO) {
  const pe = readBookPunchExport(b)
  switch (cmd) {
    case 'del': void onDelete(b); break
    case 'netdisk': openNetdisk(b); break
    case 'promo': openPromo(b); break
    case 'dl-q': if (pe?.questionUrl) window.open(pe.questionUrl, '_blank'); break
    case 'dl-a': if (pe?.answerUrl) window.open(pe.answerUrl, '_blank'); break
    case 'export':
      if (isPunchBook(b)) void onExportPunch(b)
      else if (isPdfPendingBook(b)) openBook(b)   // 待解析书：导出 = 取 PDF 原件
      else void onExportGeneric(b)
      break
  }
}

/** 打卡书菜单置灰判定：本地刚触发 或 行上持久化态就是 running。 */
function isPunchExportRunning(b: ShelfBookVO): boolean {
  return Boolean(punchExporting.value[b.id]) || readBookPunchExport(b)?.status === 'running'
}

async function onDelete(b: ShelfBookVO) {
  try {
    await ElMessageBox.confirm(`确认删除「${b.title}」？该书的目录与内容项将一并删除（题库原题不受影响）。`, '删除书', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await deleteBook(b.id)
    ElMessage.success('已删除')
    load()
  } catch (e) {
    console.warn('[shelf] 删除失败:', e)
    ElMessage.error('删除失败')
  }
}

// ── 新建书对话框 ──
const createVisible = ref(false)
const creating = ref(false)
const form = ref<{ title: string; bookType: BookType }>({ title: '', bookType: 'workbook' })

function openCreate() {
  form.value = { title: '', bookType: 'workbook' }
  createVisible.value = true
}

async function submitCreate() {
  const title = form.value.title.trim()
  if (!title) {
    ElMessage.warning('请填写书名')
    return
  }
  creating.value = true
  try {
    const res = await createBook({ title, bookType: form.value.bookType })
    ElMessage.success('已创建')
    createVisible.value = false
    if (res?.id) router.push(`/bookshelf/book/${res.id}`)
    else load()
  } catch (e) {
    console.warn('[shelf] 创建失败:', e)
    ElMessage.error('创建失败')
  } finally {
    creating.value = false
  }
}

// ── 网盘链接弹窗（所有书型通用）──
const netdiskVisible = ref(false)
const netdiskBook = ref<ShelfBookVO | null>(null)

function openNetdisk(b: ShelfBookVO) {
  netdiskBook.value = b
  netdiskVisible.value = true
}

/** 保存成功就地回填该行，卡片小标立刻跟上，不整页重拉。 */
function onNetdiskSaved(p: { bookId: string; netdisks: BookNetdisk[] }) {
  books.value = books.value.map((b) =>
    b.id === p.bookId
      ? { ...b, styleMeta: { ...(b.styleMeta ?? {}), netdisks: p.netdisks }, netdiskCount: p.netdisks.length }
      : b,
  )
}

// ── 宣发文案弹窗（所有书型通用）──
const promoVisible = ref(false)
const promoBook = ref<ShelfBookVO | null>(null)

function openPromo(b: ShelfBookVO) {
  promoBook.value = b
  promoVisible.value = true
}

function onPromoSaved(p: { bookId: string; promo: BookPromo | null }) {
  books.value = books.value.map((b) =>
    b.id === p.bookId ? { ...b, styleMeta: { ...(b.styleMeta ?? {}), promo: p.promo } } : b,
  )
}

// ── 导入 PDF 弹窗（直录待解析书）──
const importVisible = ref(false)

function openImportPdf() {
  importVisible.value = true
}

function onPdfImported() {
  load()
}

onMounted(() => {
  void dict.load(DICT_EDU_SUBJECT)
  void dict.load(DICT_EDU_STAGE)
  void dict.load(DICT_EDU_GRADE)
  void dict.load(DICT_EDU_VOLUME)
  load()
})
</script>

<template>
  <div class="shelf-page">
    <div class="page-head">
      <div class="title-wrap">
        <LineIcon name="shelf" :size="22" class="head-ico" />
        <h1>书架</h1>
      </div>
      <p class="sub">讲义、练习册、专项——我的书统一入口</p>
    </div>

    <!-- ══ 工具栏（一行收齐：搜索 + 学科 + 年级 + 册 + 重置 | 新建/导入）══ -->
    <div class="toolbar">
      <el-input
        v-model="keyword"
        class="search"
        placeholder="搜书名 / 年级 / 版本"
        clearable
      />
      <div class="seg">
        <button :class="{ on: subjectFilter === '' }" @click="pickSubject('')">全学科</button>
        <button
          v-for="s in subjectList"
          :key="s.dictValue"
          :class="{ on: subjectFilter === Number(s.dictValue) }"
          :disabled="!subjectsAvail.has(Number(s.dictValue))"
          @click="pickSubject(Number(s.dictValue))"
        >{{ s.dictLabel }}</button>
      </div>
      <el-select v-model="gradeFilter" class="sel-grade" placeholder="全部年级">
        <el-option label="全部年级" :value="''" />
        <el-option-group v-for="g in gradeGroups" :key="g.label" :label="g.label">
          <el-option
            v-for="gr in g.grades"
            :key="gr"
            :label="gradeLabel(gr)"
            :value="gr"
            :disabled="!gradesAvail.has(gr)"
          />
        </el-option-group>
      </el-select>
      <div class="seg">
        <button :class="{ on: volumeFilter === '' }" @click="pickVolume('')">全册</button>
        <button :class="{ on: volumeFilter === 1 }" :disabled="!volumesAvail.has(1)" @click="pickVolume(1)">上册</button>
        <button :class="{ on: volumeFilter === 2 }" :disabled="!volumesAvail.has(2)" @click="pickVolume(2)">下册</button>
      </div>
      <el-button v-if="hasActiveFilter" text class="reset-btn" @click="resetFilters">重置</el-button>
      <span class="count">共 {{ shownCount }} 本</span>
      <span class="spacer" />
      <el-button type="primary" plain class="new-btn" @click="openCreate">＋ 新建书</el-button>
      <!-- PDF 直录：整本 PDF 先原样入架占位（待解析），后续再走管线拆书 -->
      <el-button plain class="import-btn" @click="openImportPdf">导入 PDF</el-button>
    </div>

    <!-- ══ 分层导航（类型 = 书架大层，带数量随筛选联动）══ -->
    <div class="layer-nav">
      <button
        v-for="t in typeTabs"
        :key="t.key || 'all'"
        :class="['layer-tab', { on: typeFilter === t.key }]"
        @click="pickType(t.key)"
      >
        <span v-if="t.key" :class="['dot', typeDotClass(t.key)]" />
        {{ t.label }}<span class="n">{{ t.n }}</span>
      </button>
    </div>

    <!-- ══ 书架本体：类型层 → 年级·册层板 → 书 ══ -->
    <div v-loading="loading" class="case-wrap">
      <section v-for="sec in sections" :key="sec.type" class="case-section">
        <header class="sec-head" @click="toggleSection(sec.type)">
          <span :class="['dot', typeDotClass(sec.type)]" />
          <h2>{{ sec.label }}</h2>
          <span class="sec-n">{{ sec.count }} 本</span>
          <span class="sec-toggle">{{ collapsed[sec.type] ? '展开 ▾' : '收起 ▴' }}</span>
        </header>
        <div v-show="!collapsed[sec.type]" class="clusters">
          <div v-for="cl in sec.clusters" :key="cl.key" class="cluster">
            <div class="cluster-lab">{{ cl.label }}</div>
            <div class="cluster-row">
              <BookCard
                v-for="b in cl.books"
                :key="b.id"
                :book="b"
                :review-info="reviewInfoMap[b.id]"
                :punch-export-running="isPunchExportRunning(b)"
                :exporting="exportingBookId === b.id"
                @open="openBook(b)"
                @review="openReview(b)"
                @punch-review="openPunchReview(b)"
                @menu="(c: string) => onCardMenu(c, b)"
              />
            </div>
            <div class="board" />
          </div>
        </div>
      </section>

      <el-empty v-if="!sections.length && !loading" :description="hasActiveFilter ? '没有符合筛选的书' : '书架还没有书'">
        <el-button v-if="hasActiveFilter" @click="resetFilters">清空筛选</el-button>
        <el-button v-else type="primary" @click="openCreate">＋ 新建第一本书</el-button>
      </el-empty>
    </div>

    <el-dialog v-model="createVisible" title="新建书" width="420px">
      <el-form label-width="64px">
        <el-form-item label="书名">
          <el-input v-model="form.title" placeholder="如：暑假计算册 · 七上" maxlength="80" />
        </el-form-item>
        <el-form-item label="类型">
          <el-radio-group v-model="form.bookType">
            <el-radio-button value="lecture">讲义</el-radio-button>
            <el-radio-button value="workbook">练习册</el-radio-button>
            <el-radio-button value="variant_special">举一反三专项</el-radio-button>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="submitCreate">创建并打开</el-button>
      </template>
    </el-dialog>

    <!-- 网盘链接管理（所有书型通用） -->
    <NetdiskDialog v-model:visible="netdiskVisible" :book="netdiskBook" @saved="onNetdiskSaved" />
    <!-- 宣发文案（所有书型通用） -->
    <PromoDialog v-model:visible="promoVisible" :book="promoBook" @saved="onPromoSaved" />
    <!-- PDF 直录待解析书 -->
    <ImportPdfDialog v-model:visible="importVisible" @imported="onPdfImported" />
  </div>
</template>

<style scoped>
.shelf-page {
  max-width: 1180px;
  margin: 0 auto;
  padding: 20px 24px 60px;
}
.page-head {
  margin-bottom: 8px;
}
.title-wrap {
  display: flex;
  align-items: center;
  gap: 9px;
}
.head-ico {
  color: var(--bk-teal);
}
.page-head h1 {
  font-size: 22px;
  font-weight: 800;
  color: var(--bk-ink);
}
.page-head .sub {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  margin-top: 3px;
}

/* ── 工具栏：单行收齐全部维度 ── */
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  padding: 10px 14px;
  background: #fff;
  border: 1px solid var(--bk-line);
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(19, 49, 43, 0.05);
}
.search {
  width: 220px;
}
.sel-grade {
  width: 130px;
}
.seg {
  display: inline-flex;
  background: #eef2f2;
  border-radius: 8px;
  padding: 2px;
  gap: 2px;
}
.seg button {
  border: 0;
  background: transparent;
  font-size: 12.5px;
  font-weight: 600;
  color: #536268;
  padding: 6px 13px;
  border-radius: 6px;
  cursor: pointer;
  transition: 0.15s;
}
.seg button.on {
  background: #fff;
  color: var(--bk-teal);
  box-shadow: 0 1px 3px rgba(19, 49, 43, 0.05);
}
.seg button:disabled {
  color: #b7c0c4;
  cursor: not-allowed;
  opacity: 0.55;
}
.reset-btn {
  color: var(--el-text-color-secondary);
  padding: 6px 8px;
}
.count {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
.spacer {
  flex: 1;
}
.import-btn {
  color: var(--bk-teal-deep);
  border-color: var(--el-color-primary-light-7);
}

/* ── 分层导航 ── */
.layer-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.layer-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--bk-line);
  background: #fff;
  border-radius: 999px;
  padding: 6px 14px;
  font-size: 12.5px;
  font-weight: 700;
  color: #536268;
  cursor: pointer;
  transition: 0.15s;
}
.layer-tab:hover {
  border-color: var(--bk-teal);
  color: var(--bk-teal-deep);
}
.layer-tab.on {
  background: var(--bk-teal);
  border-color: var(--bk-teal);
  color: #fff;
}
.layer-tab .n {
  font-size: 11px;
  font-weight: 800;
  opacity: 0.75;
  margin-left: 1px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}
.dot.d1 { background: #1268b3; }
.dot.d2 { background: #0f766e; }
.dot.d3 { background: #7a4fc0; }
.dot.d4 { background: #c2701a; }
.dot.d5 { background: #77909d; }
.layer-tab.on .dot {
  background: #fff;
}

/* ── 书架本体 ── */
.case-wrap {
  min-height: 200px;
  margin-top: 6px;
}
.case-section {
  margin-top: 22px;
}
.sec-head {
  display: flex;
  align-items: center;
  gap: 9px;
  cursor: pointer;
  user-select: none;
  padding: 2px 2px 8px;
  border-bottom: 1px solid #eef2f2;
}
.sec-head .dot {
  width: 10px;
  height: 10px;
}
.sec-head h2 {
  font-size: 16px;
  font-weight: 800;
  color: var(--bk-ink);
}
.sec-n {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
}
.sec-toggle {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--el-text-color-secondary);
}
.sec-head:hover .sec-toggle {
  color: var(--bk-teal-deep);
}

/* ── 层板（cluster）：书立板上，多块层板按行流式排布 ── */
.clusters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 20px 32px;
  padding: 16px 2px 4px;
}
.cluster {
  display: flex;
  flex-direction: column;
  max-width: 100%;
}
.cluster-lab {
  align-self: flex-start;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.06em;
  color: var(--bk-teal-deep);
  background: var(--bk-teal-soft, #e6f3f1);
  border-radius: 6px 6px 0 0;
  padding: 3px 12px;
  margin-left: 8px;
}
.cluster-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 14px;
  padding: 10px 14px 8px;
}
/* 层板：浅木色横板 + 板下投影，书「立」在上面 */
.board {
  height: 9px;
  border-radius: 2px 2px 4px 4px;
  background: linear-gradient(to bottom, #e9ddc6, #cdbb96);
  box-shadow: 0 3px 6px rgba(120, 100, 60, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.55);
}
</style>
