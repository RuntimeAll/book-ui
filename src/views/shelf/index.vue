<script setup lang="ts">
/**
 * PRD-002 P1 — 书架页。
 * 讲义/练习册/专项的唯一入口：类型筛选 + 书卡片（结构统计一眼看厚度）。
 * 数据源 = /teacher/shelf/book/page（owner 过滤）；「新建书」走 createBook 建空书起步。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  pageBooks,
  createBook,
  deleteBook,
  exportBook,
  readBookNetdiskCount,
  readBookPdfMeta,
  readBookPunchExport,
  BOOK_TYPE_LABEL,
  type BookType,
  type BookNetdisk,
  type ShelfBookVO,
} from '@/api/shelf'
import { exportPunchBook, getPunchBookExportStatus } from '@/api/teacher/punch'
import {
  useDictStore,
  DICT_EDU_SUBJECT, DICT_EDU_STAGE, DICT_EDU_GRADE, DICT_EDU_VOLUME,
} from '@/store/dict'
import { getProgress, type ReviewProgress } from '@/api/review'
import LineIcon from '@/components/LineIcon.vue'
import { proxyImage } from '@/utils/image-proxy'
import NetdiskDialog from './components/NetdiskDialog.vue'
import ImportPdfDialog from './components/ImportPdfDialog.vue'

const router = useRouter()
const dict = useDictStore()

// ══ 筛选状态（对齐卷库：类型 / 学科 / 学段 / 年级 / 册 + 书名）════
// '' = 全部。书量小（按 owner 归属，通常十几本），一次全量拉回、纯前端过滤：
// 点选即时联动、无逐维度往返，交互与卷库分层收放同构；无需 BE 分页/多参。
type NumOrAll = number | ''
const typeFilter = ref<'' | BookType>('')
const subjectFilter = ref<NumOrAll>('')
const stageFilter = ref<NumOrAll>('')
const gradeFilter = ref<NumOrAll>('')
const volumeFilter = ref<NumOrAll>('')
const keyword = ref('')

const GRADE_NUM: Record<number, string> = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八', 9: '九', 10: '高一', 11: '高二', 12: '高三' }
const STAGE_GRADES: Record<number, number[]> = { 1: [1, 2, 3, 4, 5, 6], 2: [7, 8, 9], 3: [10, 11, 12] }

// 类型选项：随 BOOK_TYPE_LABEL 注册表自动生成（新增书类型只改 api/shelf 的 label 表一处）；
// special=备课栏工作集被 BE 剔出书架列表，过滤段排除。
// 🔴 类型 / 年级两维已改下拉（el-select）——维度多了按钮行会换行挤爆，下拉更紧凑；
//    选项与原按钮 1:1（含「全部」缺省项），无书的类型仍保留但 disabled。
// 🔴 PRD-013 — daily_punch 打卡书也是书架书（天=节点的有结构书），入口即本页卡片
const typeSegs: { key: '' | BookType; label: string }[] = [
  { key: '', label: '全部' },
  ...(Object.entries(BOOK_TYPE_LABEL) as [BookType, string][])
    .filter(([k]) => k !== 'special')
    .map(([k, l]) => ({ key: k, label: l })),
]

const loading = ref(false)
const books = ref<ShelfBookVO[]>([])

// 🔴 PRD-006 AC5 — 每本书的录入审核进度（角标）。bookId → 进度。
// 不阻塞列表渲染：load() 只等书列表，进度角标 fire-and-forget、限并发池逐本回填。
const progressMap = ref<Record<string, ReviewProgress>>({})

async function load() {
  loading.value = true
  try {
    // 一次全量拉本人书（不传 bookType：全部类型都要，前端再分维度过滤）
    const res = await pageBooks({})
    books.value = res?.rows ?? []
    // 列表已就位即渲染；进度角标异步补（不 await，不挡首屏）
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
  // 待解析书没有页级录入审核（不给「录入审核」入口），不必拉进度
  const ids = list.filter((b) => !isPdfPendingBook(b)).map((b) => b.id)
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

/** 书卡审核角标：totalPages>0 才展示；done = 全书页审完（AC5 录入确认完成语义，前端计算）。 */
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

// —— 维度可用集（据已加载书集算，缺该维度数据的选项置灰，对齐卷库 dim 逻辑）——
const subjectsAvail = computed(() => new Set(books.value.map((b) => b.subjectCode).filter((v): v is number => v != null)))
const stagesAvail = computed(() => new Set(books.value.map((b) => b.stageCode).filter((v): v is number => v != null)))
const volumesAvail = computed(() => new Set(books.value.map((b) => b.volumeCode).filter((v): v is number => v != null)))
const typesAvail = computed(() => new Set(books.value.map((b) => String(b.bookType))))
// 年级卡：受选中学科/学段收窄（未选则全集），只亮真有书的年级
const gradesAvail = computed(() => {
  const s = new Set<number>()
  for (const b of books.value) {
    if (b.gradeCode == null) continue
    if (subjectFilter.value !== '' && b.subjectCode !== subjectFilter.value) continue
    if (stageFilter.value !== '' && b.stageCode !== stageFilter.value) continue
    s.add(b.gradeCode)
  }
  return s
})
// 年级卡网格：选了学段 → 该学段年级；否则 → 有书的年级并集升序
const gradeCells = computed<number[]>(() => {
  if (stageFilter.value !== '') return STAGE_GRADES[stageFilter.value as number] ?? []
  return [...new Set(books.value.map((b) => b.gradeCode).filter((v): v is number => v != null))].sort((a, b) => a - b)
})

const subjectList = computed(() => dict.list(DICT_EDU_SUBJECT))
const stageList = computed(() => dict.list(DICT_EDU_STAGE))

/** 年级下拉文案：优先字典中文名，字典未到货回落 GRADE_NUM（一年级…高三）。 */
function gradeLabel(g: number): string {
  const l = dict.label(DICT_EDU_GRADE, g)
  if (l && l !== String(g)) return l
  const n = GRADE_NUM[g]
  if (!n) return String(g)
  return g >= 10 ? n : `${n}年级`
}

// —— 交互（类型 / 年级走 el-select 直接 v-model，其余维度按钮组保持 toggle）——
function pickSubject(v: NumOrAll) { subjectFilter.value = subjectFilter.value === v ? '' : v }
function pickStage(v: NumOrAll) {
  stageFilter.value = stageFilter.value === v ? '' : v
  // 换学段：若当前年级不在新学段可选年级内则清空
  if (stageFilter.value !== '' && gradeFilter.value !== '' && !(STAGE_GRADES[stageFilter.value as number] ?? []).includes(gradeFilter.value as number)) {
    gradeFilter.value = ''
  }
}
function pickVolume(v: NumOrAll) { volumeFilter.value = volumeFilter.value === v ? '' : v }

const hasActiveFilter = computed(() =>
  typeFilter.value !== '' || subjectFilter.value !== '' || stageFilter.value !== '' ||
  gradeFilter.value !== '' || volumeFilter.value !== '' || keyword.value.trim() !== '',
)
function resetFilters() {
  typeFilter.value = ''
  subjectFilter.value = ''
  stageFilter.value = ''
  gradeFilter.value = ''
  volumeFilter.value = ''
  keyword.value = ''
}

// —— 过滤（AND 跨维度 + 书名/学科/年级关键词）——
const shownBooks = computed<ShelfBookVO[]>(() => {
  const kw = keyword.value.trim().toLowerCase()
  return books.value.filter((b) => {
    if (typeFilter.value !== '' && String(b.bookType) !== typeFilter.value) return false
    if (subjectFilter.value !== '' && b.subjectCode !== subjectFilter.value) return false
    if (stageFilter.value !== '' && b.stageCode !== stageFilter.value) return false
    if (gradeFilter.value !== '' && b.gradeCode !== gradeFilter.value) return false
    if (volumeFilter.value !== '' && b.volumeCode !== volumeFilter.value) return false
    if (kw) {
      const hay = [b.title, b.subjectId, b.grade, b.edition].filter(Boolean).map((s) => String(s).toLowerCase())
      if (!hay.some((s) => s.includes(kw))) return false
    }
    return true
  })
})

function coverClass(t: string): string {
  if (t === 'lecture') return 'cover c1'
  if (t === 'special' || t === 'variant_special') return 'cover c3'
  if (t === 'daily_punch') return 'cover c4'
  if (t === 'pdf_pending') return 'cover c5'
  return 'cover c2'
}
function tagClass(t: string): string {
  if (t === 'lecture') return 'tag lec'
  if (t === 'special' || t === 'variant_special') return 'tag sp'
  if (t === 'daily_punch') return 'tag punch'
  if (t === 'pdf_pending') return 'tag pdf'
  return 'tag wb'
}
/** 每日打卡书 = 独立阅读/审核页（PRD-013），与常规书浏览页分流。 */
function isPunchBook(b: ShelfBookVO): boolean {
  return String(b.bookType) === 'daily_punch'
}
/** PDF 直录待解析书：只有 PDF 本体 + 封面，尚未拆成节点/题 —— 打开即看 PDF，不进书浏览页。 */
function isPdfPendingBook(b: ShelfBookVO): boolean {
  return String(b.bookType) === 'pdf_pending'
}
/** 电子课本：整页图书 —— 打开进阅读页（章目录+翻页），不进题块浏览页（2026-07-30 改版）。 */
function isTextbookBook(b: ShelfBookVO): boolean {
  return String(b.bookType) === 'textbook'
}
/** 待解析书封面缩略图（OSS 图走 BE proxy 防 Content-Disposition 拒渲）。 */
function coverStyle(b: ShelfBookVO): Record<string, string> {
  if (!isPdfPendingBook(b)) return {}
  const url = proxyImage(readBookPdfMeta(b).coverUrl)
  return url ? { backgroundImage: `url("${url}")` } : {}
}
/** 已绑网盘条数小标（0 条不显示）：明细 / netdiskCount 两口径兼容读。 */
function netdiskCountOf(b: ShelfBookVO): number {
  return readBookNetdiskCount(b)
}
function typeLabel(t: string): string {
  return BOOK_TYPE_LABEL[t as BookType] ?? t
}

/** 结构统计串（讲/节 + 题；卷面无内部词）。 */
function statLine(b: ShelfBookVO): string {
  // 打卡书：天=节点、计算题在 content_json 不计入 questionCount——按天数口径显示，
  // 防「10 节 · 20 题」误导（实际 31 题/天，verifier S12）
  if (isPunchBook(b)) return b.nodeCount != null ? `${b.nodeCount} 天 · 每天一练` : '空书'
  // 电子课本：页=题引用（一页一题）——按「章·页」口径显示，别用「节·题」误导（阅读态改版）
  if (isTextbookBook(b)) {
    return b.nodeCount != null ? `${b.nodeCount} 章 · ${b.questionCount ?? 0} 页` : '空书'
  }
  // 待解析书：没有节点/题，厚度口径 = PDF 页数；年级册+章节（styleMeta.unit）挂前面
  if (isPdfPendingBook(b)) {
    const parts: string[] = []
    if (b.grade) parts.push(String(b.grade))
    const unit = (b.styleMeta as Record<string, unknown> | undefined)?.unit
    if (typeof unit === 'string' && unit) parts.push(unit)
    const pages = readBookPdfMeta(b).pdfPages
    parts.push(pages > 0 ? `${pages} 页 · 待解析` : '待解析')
    return parts.join(' · ')
  }
  const parts: string[] = []
  if (b.nodeCount != null) parts.push(`${b.nodeCount} 节`)
  if (b.questionCount != null) parts.push(`${b.questionCount} 题`)
  else if (b.itemCount != null) parts.push(`${b.itemCount} 项`)
  return parts.join(' · ') || '空书'
}

/**
 * 打开书 —— 按 bookType 分流（PRD-013 FP1 + 2026-07-30 阅读态改版）：
 *   daily_punch → 打卡阅读页（干净展示态；审核独立走「审核」按钮）
 *   textbook    → 电子课本阅读页（章目录+页码跳转+单页整页图翻书，不再进题块浏览页）
 *   pdf_pending → 新窗打开 PDF 本体（在线预览/下载），书内无结构不进浏览页
 *   其他类型     → 原书浏览页（讲义/练习册题块形态），行为不变
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

// 🔴 PRD-006 — 录入审核入口（按页比对源书原版 → 逐页确认；普通用户可见）
function openReview(b: ShelfBookVO) {
  router.push(`/bookshelf/review/${b.id}`)
}

// 🔴 2026-07-30 拆分 — 打卡书审核入口（审核是功能不是展示：独立页，与「打开」的阅读态分离）
function openPunchReview(b: ShelfBookVO) {
  router.push(`/bookshelf/punch/${b.id}`)
}

// ── 卡片「⋯」菜单：导出接真（2026-07-30 用户点单——此前是 PRD-003 占位 toast）──
// 三分流：打卡书=整册异步导出（BE worker + style_meta.punchExport 持久化，菜单直下）；
//         待解析书=取 PDF 原件；其余（讲义/练习册/课本）=BE 同步整书导出后新窗打开。

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

/** 普通书：BE 同步整书导出（讲义分讲渲染/课本整页图拼 A4，大书 1-3 分钟）→ 新窗打开。 */
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

/** 菜单统一分发（模板里箭头函数三元套娃会失控，收进一个函数）。 */
function onCardMenu(cmd: string, b: ShelfBookVO) {
  const pe = readBookPunchExport(b)
  switch (cmd) {
    case 'del': void onDelete(b); break
    case 'netdisk': openNetdisk(b); break
    case 'dl-q': if (pe?.questionUrl) window.open(pe.questionUrl, '_blank'); break
    case 'dl-a': if (pe?.answerUrl) window.open(pe.answerUrl, '_blank'); break
    case 'export':
      if (isPunchBook(b)) void onExportPunch(b)
      else if (isPdfPendingBook(b)) openBook(b)   // 待解析书：导出 = 取 PDF 原件（与「打开」同源）
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

// —— 新建书对话框 ——
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

// —— 网盘链接弹窗（所有书型通用）——
const netdiskVisible = ref(false)
const netdiskBook = ref<ShelfBookVO | null>(null)

function openNetdisk(b: ShelfBookVO) {
  netdiskBook.value = b
  netdiskVisible.value = true
}

/** 保存成功就地回填该行（明细 + 计数），卡片小标立刻跟上，不整页重拉。 */
function onNetdiskSaved(p: { bookId: string; netdisks: BookNetdisk[] }) {
  books.value = books.value.map((b) =>
    b.id === p.bookId
      ? { ...b, styleMeta: { ...(b.styleMeta ?? {}), netdisks: p.netdisks }, netdiskCount: p.netdisks.length }
      : b,
  )
}

// —— 导入 PDF 弹窗（直录待解析书）——
const importVisible = ref(false)

function openImportPdf() {
  importVisible.value = true
}

function onPdfImported() {
  load()
}

onMounted(() => {
  // 筛选维度字典（学科/学段/年级/册）—— 与卷库同源 sys_dict
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

    <!-- ══ 筛选面板（对齐卷库：类型 / 学科 / 学段 / 年级 / 册 + 书名）══ -->
    <div class="filter-panel">
      <div class="frow">
        <!-- 类型（下拉；无书类型保留但置灰）-->
        <div class="grp">
          <div class="grp-lab">类型</div>
          <el-select v-model="typeFilter" class="sel-type" placeholder="全部">
            <el-option
              v-for="t in typeSegs"
              :key="t.key || 'all'"
              :label="t.label"
              :value="t.key"
              :disabled="!!t.key && !typesAvail.has(t.key)"
            />
          </el-select>
        </div>
        <!-- 学科 -->
        <div class="grp">
          <div class="grp-lab">学科</div>
          <div class="seg">
            <button :class="{ on: subjectFilter === '' }" @click="pickSubject('')">全部</button>
            <button
              v-for="s in subjectList"
              :key="s.dictValue"
              :class="{ on: subjectFilter === Number(s.dictValue) }"
              :disabled="!subjectsAvail.has(Number(s.dictValue))"
              @click="pickSubject(Number(s.dictValue))"
            >{{ s.dictLabel }}</button>
          </div>
        </div>
        <!-- 学段 -->
        <div class="grp">
          <div class="grp-lab">学段</div>
          <div class="seg">
            <button :class="{ on: stageFilter === '' }" @click="pickStage('')">全部</button>
            <button
              v-for="st in stageList"
              :key="st.dictValue"
              :class="{ on: stageFilter === Number(st.dictValue) }"
              :disabled="!stagesAvail.has(Number(st.dictValue))"
              @click="pickStage(Number(st.dictValue))"
            >{{ st.dictLabel }}</button>
          </div>
        </div>
        <!-- 年级（下拉；受学科/学段收窄，无书年级置灰）-->
        <div v-if="gradeCells.length" class="grp">
          <div class="grp-lab">年级</div>
          <el-select v-model="gradeFilter" class="sel-grade" placeholder="全部">
            <el-option label="全部" :value="''" />
            <el-option
              v-for="g in gradeCells"
              :key="g"
              :label="gradeLabel(g)"
              :value="g"
              :disabled="!gradesAvail.has(g)"
            />
          </el-select>
        </div>
        <!-- 册 -->
        <div class="grp">
          <div class="grp-lab">册</div>
          <div class="seg">
            <button :class="{ on: volumeFilter === '' }" @click="pickVolume('')">全部</button>
            <button :class="{ on: volumeFilter === 1 }" :disabled="!volumesAvail.has(1)" @click="pickVolume(1)">上册</button>
            <button :class="{ on: volumeFilter === 2 }" :disabled="!volumesAvail.has(2)" @click="pickVolume(2)">下册</button>
          </div>
        </div>
      </div>
      <!-- 底栏：书名搜索 + 重置 + 新建书 -->
      <div class="frow foot-row">
        <el-input
          v-model="keyword"
          class="search"
          placeholder="搜书名 / 学科 / 年级"
          clearable
        />
        <el-button v-if="hasActiveFilter" text class="reset-btn" @click="resetFilters">重置筛选</el-button>
        <span class="count">共 {{ shownBooks.length }} 本</span>
        <el-button type="primary" plain class="new-btn" @click="openCreate">＋ 新建书</el-button>
        <!-- PDF 直录：整本 PDF 先原样入架占位（待解析），后续再走管线拆书 -->
        <el-button plain class="import-btn" @click="openImportPdf">导入 PDF</el-button>
      </div>
    </div>

    <div v-loading="loading" class="grid-wrap">
      <div v-if="shownBooks.length" class="grid">
        <div v-for="b in shownBooks" :key="b.id" class="bookcard">
          <div
            :class="[coverClass(b.bookType), { 'has-img': isPdfPendingBook(b) && coverStyle(b).backgroundImage }]"
            :style="coverStyle(b)"
            @click="openBook(b)"
          >
            <span class="cover-title">{{ b.title }}</span>
            <span v-if="isPdfPendingBook(b)" class="pending-flag">待解析</span>
          </div>
          <div class="bd">
            <span :class="tagClass(b.bookType)">{{ typeLabel(b.bookType) }}</span>
            <!-- 已绑网盘条数小标（0 条不显示）-->
            <span v-if="netdiskCountOf(b) > 0" class="nd-chip" title="已绑网盘链接">☁{{ netdiskCountOf(b) }}</span>
            <div class="stat">{{ statLine(b) }}</div>
            <!-- 🔴 PRD-006 录入审核进度角标（AC5）：done→录入确认完成徽标 / 否则迷你进度条 -->
            <div v-if="reviewInfoMap[b.id]" class="rv-badge">
              <span v-if="reviewInfoMap[b.id].done" class="rv-done">✓ 录入确认完成</span>
              <template v-else>
                <div class="rv-mini-bar"><i :style="{ width: reviewInfoMap[b.id].pct + '%' }"></i></div>
                <span class="rv-mini-num">已审 {{ reviewInfoMap[b.id].reviewed }}/{{ reviewInfoMap[b.id].total }} 页</span>
              </template>
            </div>
            <div class="ops">
              <el-button size="small" type="primary" @click="openBook(b)">打开</el-button>
              <!-- 🔴 2026-07-30 拆分：打卡书「打开」=干净阅读态，审核走独立按钮进 punch.vue 审核页 -->
              <el-button
                v-if="isPunchBook(b)"
                size="small"
                class="review-btn"
                @click="openPunchReview(b)"
              >审核</el-button>
              <!-- PRD-006 页级源书比对审核（讲义/练习册/课本）；待解析书没拆页无从比对，不给入口 -->
              <el-button
                v-else-if="!isPdfPendingBook(b)"
                size="small"
                class="review-btn"
                @click="openReview(b)"
              >录入审核</el-button>
              <el-dropdown trigger="click" @command="(c: string) => onCardMenu(c, b)">
                <el-button size="small">⋯</el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="netdisk">网盘链接</el-dropdown-item>
                    <!-- 打卡书：整册异步导出（后台渲染，styleMeta 持久化）+ 导好的全册直接可下 -->
                    <template v-if="isPunchBook(b)">
                      <el-dropdown-item command="export" :disabled="isPunchExportRunning(b)">
                        {{ isPunchExportRunning(b) ? '整册导出中…' : '导出整册 PDF' }}
                      </el-dropdown-item>
                      <el-dropdown-item v-if="readBookPunchExport(b)?.questionUrl" command="dl-q">下载题目全册</el-dropdown-item>
                      <el-dropdown-item v-if="readBookPunchExport(b)?.answerUrl" command="dl-a">下载解析全册</el-dropdown-item>
                    </template>
                    <!-- 待解析书：导出 = 取 PDF 原件 -->
                    <el-dropdown-item v-else-if="isPdfPendingBook(b)" command="export">下载 PDF 原件</el-dropdown-item>
                    <!-- 讲义/练习册/课本：BE 整书导出（同步 1-3 分钟）后新窗打开 -->
                    <el-dropdown-item v-else command="export" :disabled="exportingBookId === b.id">
                      {{ exportingBookId === b.id ? '整书导出中…' : '导出整书 PDF' }}
                    </el-dropdown-item>
                    <el-dropdown-item command="del" style="color: var(--el-color-danger)">删除书</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </div>
        </div>
      </div>
      <el-empty v-else-if="!loading" description="书架还没有书">
        <el-button type="primary" @click="openCreate">＋ 新建第一本书</el-button>
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

/* ── 筛选面板（与卷库目录同构：grp-lab + seg 段 + grade 卡）── */
.filter-panel {
  margin-top: 12px;
  padding: 14px 16px;
  background: #fff;
  border: 1px solid var(--bk-line);
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(19, 49, 43, 0.05);
}
.frow {
  display: flex;
  flex-wrap: wrap;
  gap: 18px 22px;
  align-items: flex-end;
}
.foot-row {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed #eef2f2;
  align-items: center;
  gap: 12px;
}
.grp {
  min-width: 0;
}
.grp-lab {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1px;
  color: #7c8a90;
  text-transform: uppercase;
  margin-bottom: 6px;
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
  padding: 7px 14px;
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
/* 类型 / 年级下拉：宽度紧凑，与旁边 seg 按钮组同行底对齐 */
.sel-type {
  width: 140px;
}
.sel-grade {
  width: 120px;
}
.search {
  width: 240px;
}
.reset-btn {
  color: var(--el-text-color-secondary);
}
.count {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.new-btn {
  margin-left: auto;
}
.import-btn {
  color: var(--bk-teal-deep);
  border-color: var(--el-color-primary-light-7);
}

.grid-wrap {
  min-height: 200px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(215px, 1fr));
  gap: 16px;
  padding: 18px 0;
}
.bookcard {
  border: 1px solid var(--bk-line);
  border-radius: 12px;
  overflow: hidden;
  background: #fff;
  transition: box-shadow 0.18s, transform 0.18s;
}
.bookcard:hover {
  box-shadow: 0 6px 20px rgba(15, 118, 110, 0.12);
  transform: translateY(-2px);
}
.cover {
  height: 88px;
  display: flex;
  align-items: flex-end;
  padding: 10px 14px;
  color: #fff;
  font-weight: 800;
  font-size: 15px;
  line-height: 1.35;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
  cursor: pointer;
}
.cover.c1 {
  background: linear-gradient(135deg, #1268b3, #4fa3e0);
}
.cover.c2 {
  background: linear-gradient(135deg, #0f766e, #4cc2b4);
}
.cover.c3 {
  background: linear-gradient(135deg, #7a4fc0, #a98ae0);
}
/* PRD-013 每日打卡：暖橙一档，与讲义/练习册/专项一眼分得开 */
.cover.c4 {
  background: linear-gradient(135deg, #c2701a, #f0b45c);
}
/* PDF 直录待解析：冷灰蓝（未加工态），与已成书的四档拉开 */
.cover.c5 {
  background: linear-gradient(135deg, #4a5b66, #8ea3ad);
  position: relative;
  justify-content: space-between;
}
/* 有封面缩略图时铺图 + 底部压暗，白字标题仍读得清 */
.cover.has-img {
  background-size: cover;
  background-position: center top;
  background-repeat: no-repeat;
}
.cover.has-img::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.05) 35%, rgba(0, 0, 0, 0.62));
}
.cover .cover-title {
  position: relative;
  z-index: 1;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
/* 封面右下「待解析」标（区分色，一眼看出这本还没拆） */
.pending-flag {
  position: relative;
  z-index: 1;
  flex: none;
  align-self: flex-end;
  font-size: 10.5px;
  font-weight: 700;
  padding: 1px 7px;
  border-radius: 999px;
  background: #fde68a;
  color: #92400e;
  text-shadow: none;
  white-space: nowrap;
}
.bd {
  padding: 10px 14px 12px;
}
.tag {
  display: inline-block;
  font-size: 11px;
  font-weight: 700;
  padding: 1px 8px;
  border-radius: 6px;
}
.tag.lec {
  background: #e8f1fb;
  color: #1268b3;
}
.tag.wb {
  background: var(--bk-teal-soft);
  color: var(--bk-teal-deep);
}
.tag.sp {
  background: #f3ecfb;
  color: #7a4fc0;
}
.tag.punch {
  background: #fdf3e3;
  color: #b45309;
}
.tag.pdf {
  background: #eef1f3;
  color: #4a5b66;
}
/* 网盘小标：跟在类型徽标后，0 条不渲染 */
.nd-chip {
  display: inline-block;
  margin-left: 6px;
  font-size: 11px;
  font-weight: 700;
  padding: 1px 7px;
  border-radius: 6px;
  background: #e8f1fb;
  color: #1268b3;
  cursor: default;
}
.stat {
  font-size: 11.5px;
  color: var(--el-text-color-secondary);
  margin-top: 5px;
}
/* ── 录入审核进度角标（PRD-006 AC5）── */
.rv-badge {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 7px;
  min-height: 16px;
}
.rv-mini-bar {
  flex: 1;
  height: 5px;
  border-radius: 4px;
  background: var(--bg-100, #edf2f2);
  overflow: hidden;
}
.rv-mini-bar > i {
  display: block;
  height: 100%;
  background: var(--bk-teal);
  transition: width 0.25s ease;
}
.rv-mini-num {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.rv-done {
  font-size: 11px;
  font-weight: 800;
  color: var(--bk-red-pen, #e0526b);
  background: #fdecef;
  border: 1px solid #f4c6d0;
  border-radius: 999px;
  padding: 1px 9px;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.ops {
  margin-top: 10px;
  display: flex;
  gap: 6px;
  align-items: center;
}
.review-btn {
  color: var(--bk-teal-deep);
  border-color: var(--el-color-primary-light-7);
}
.review-btn:hover {
  color: #fff;
  background: var(--bk-teal);
  border-color: var(--bk-teal);
}
</style>
