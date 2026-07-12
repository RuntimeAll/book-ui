<script setup lang="ts">
/**
 * PaperLibrary — 卷库通用列表组件（2026-07-01 目录重构，对齐题库目录）
 *
 * 左侧目录 = 分层收放筛选：类型(公共试卷/我的卷库) → 学科 → 学段 → 年级卡(+中考专区) → 册 → 卷型。
 * 全部读 biz_paper_category 结构化字段码（subject/stage/grade/volume/paperType/nodeKind）+ useDictStore
 * 翻标签，不再解析节点名。选中维度 → 定位到分类节点 id → 走 getPaperPage(subjectId 前缀匹配)。
 *
 * scope='public'(公共卷) / 'mine'(我的卷)；?mine=1 query 进入自动选「我的卷库」。
 *
 * PRD-C-212 增量「我的卷库转移进备课台」— `mode` prop：
 *   - undefined（默认）= 现行为不变（顶导航卷库页，类型 seg 可切，?mine=1 生效）。
 *   - 'public-only' = 卷库顶导航页专用：scope 锁 'public'，类型 seg 不渲染，?mine=1 忽略。
 *   - 'mine-only' = 备课台「我的卷库」分区专用：scope 锁 'mine'，类型 seg 不渲染。
 *   固定 mode 下缓存读写走独立 key 后缀，避免与顶导航页缓存互相污染。
 */
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search, Star, ArrowDown } from '@element-plus/icons-vue'
import { useRouter, useRoute } from 'vue-router'
import {
  getPaperLazyTree,
  getPaperPage,
  deletePaper,
  type PaperTreeNode,
  type PaperListItem,
  type MisiktPageVo,
} from '@/api/paper/index'
import {
  useDictStore,
  DICT_EDU_SUBJECT, DICT_EDU_STAGE, DICT_EDU_GRADE, DICT_PAPER_TYPE,
} from '@/store/dict'
import { useUserStore } from '@/store/user'
import { getCurrentUser } from '@/api/user'
import { usePaperBasket } from '@/composables/usePaperBasket'
import { useAbortableRequest } from '@/composables/useAbortableRequest'
import { useLoginGuard } from '@/composables/useLoginGuard'
// PRD-003 D7：AttachToLessonDialog（把卷挂到课次卷位）随卷位体系退役

const props = defineProps<{
  /** PRD-C-212 增量：固定 scope 场景（卷库顶导航页 / 备课台我的卷库分区）；不传 = 现行为不变 */
  mode?: 'public-only' | 'mine-only'
}>()

const router = useRouter()
const route = useRoute()
const userStore = useUserStore()
const basket = usePaperBasket()
const dict = useDictStore()
// PRD-C-212 D5 — 游客态操作按钮登录引导
const { ensureLogin } = useLoginGuard()

// ══ 分类树（结构化字段驱动）══════════════════════════════════
const NO_MATCH = 'NONE' // 空学科/学段兜底 subjectId（前缀匹配不到任何分类 → 0 条）
const treeLoading = ref(false)
const gradeNodes = ref<PaperTreeNode[]>([]) // nodeKind=grade（年级册节点）
const examNodes = ref<PaperTreeNode[]>([])  // nodeKind=exam（中考模拟/真题）
const ptypeNodes = ref<PaperTreeNode[]>([]) // nodeKind=ptype（卷型节点）

const GRADE_NUM: Record<number, string> = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八', 9: '九', 10: '高一', 11: '高二', 12: '高三' }
const STAGE_GRADES: Record<number, number[]> = { 1: [1, 2, 3, 4, 5, 6], 2: [7, 8, 9], 3: [10, 11, 12] }

// ══ 选择状态 ════════════════════════════════════════════════
const scope = ref<'public' | 'mine'>(props.mode === 'mine-only' ? 'mine' : 'public') // 类型
// PRD-B-101：我的卷库·卷型 tab（'all'=全部含备课卷 / 'prep'=只备课卷 paper_kind='2'）。
// 🔴 备课卷 tab 绕过年级/学科树（自建卷缺年级元数据会被树挡），直接查 mine+paperKind。
const kindTab = ref<'all' | 'prep'>('all')
const showKindTab = computed(() => scope.value === 'mine')
const prepOnly = computed(() => scope.value === 'mine' && kindTab.value === 'prep')
const subject = ref(1) // 学科（1数学 2科学）
const stage = ref(2)   // 学段（1小学 2初中 3高中）
const gradeCode = ref<number | null>(7) // 选中年级（null=走中考）
const vol = ref(1)     // 册（1上 2下）
const examId = ref('') // 选中的中考节点 id（非空=中考态）
const paperType = ref<number | ''>('') // 卷型（''=该年级全部）

// ══ 维度派生 ════════════════════════════════════════════════
const uniq = <T,>(a: T[]) => [...new Set(a)]
const subjectList = computed(() => dict.list(DICT_EDU_SUBJECT))
const stageList = computed(() => dict.list(DICT_EDU_STAGE))
const ptypeList = computed(() => dict.list(DICT_PAPER_TYPE))

/** 当前学科+学段下有卷型/年级数据的年级码集合 */
const gradesAvail = computed(() =>
  new Set(gradeNodes.value.filter((n) => n.subject === subject.value && n.stage === stage.value).map((n) => n.grade as number)),
)
/** 当前学科+学段下的中考节点 */
const examList = computed(() => examNodes.value.filter((n) => n.subject === subject.value && n.stage === stage.value))
/** 当前年级下可用的册（有些年级如九年级无上下册） */
const volsAvail = computed(() => {
  if (gradeCode.value == null) return new Set<number>()
  return new Set(
    gradeNodes.value
      .filter((n) => n.subject === subject.value && n.stage === stage.value && n.grade === gradeCode.value && n.volume != null)
      .map((n) => n.volume as number),
  )
})
/** 当前选中的年级册节点（含无册的单节点如九年级） */
const currentGradeNode = computed<PaperTreeNode | null>(() => {
  if (gradeCode.value == null) return null
  const cands = gradeNodes.value.filter((n) => n.subject === subject.value && n.stage === stage.value && n.grade === gradeCode.value)
  if (!cands.length) return null
  return cands.find((n) => n.volume === vol.value) ?? cands.find((n) => n.volume == null) ?? cands[0]
})
/** 当前年级节点下的卷型集合（paperType 码） */
const ptypesAvail = computed(() => {
  const gn = currentGradeNode.value
  if (!gn) return new Set<number>()
  return new Set(ptypeNodes.value.filter((n) => n.parentId === gn.id && n.paperType != null).map((n) => n.paperType as number))
})
const stageHasData = computed(() => gradesAvail.value.size > 0 || examList.value.length > 0)
const isExam = computed(() => !!examId.value)

// ══ 收放 + 卡头 ═════════════════════════════════════════════
const pickerOpen = ref(false)
function togglePicker() { pickerOpen.value = !pickerOpen.value }
const isSci = computed(() => subject.value === 2)
// 卡头只概括「收起的前半截」= 学科·学段（年级往下常驻可见）
const crumbIco = computed(() => dict.label(DICT_EDU_SUBJECT, subject.value).charAt(0) || '卷')
const crumbTag = computed(() => (scope.value === 'public' ? '公共试卷' : '我的卷库'))
const crumbMain = computed(() => `${dict.label(DICT_EDU_SUBJECT, subject.value)}·${dict.label(DICT_EDU_STAGE, stage.value)}`)

// ══ 目标节点解析 → subjectId（前缀匹配）══════════════════════
function resolveTargetId(): string {
  if (isExam.value) return examId.value
  const gn = currentGradeNode.value
  if (!gn) return NO_MATCH // 没选到具体年级（空学科/学段）→ 0 条，不回退到全部数学卷
  if (paperType.value !== '') {
    const pn = ptypeNodes.value.find((n) => n.parentId === gn.id && n.paperType === paperType.value)
    if (pn) return pn.id
  }
  return gn.id
}

// ══ 面包屑 ══════════════════════════════════════════════════
const crumb = computed(() => {
  const parts = [scope.value === 'public' ? '公共试卷' : '我的卷库', dict.label(DICT_EDU_SUBJECT, subject.value), dict.label(DICT_EDU_STAGE, stage.value)]
  if (isExam.value) {
    const e = examList.value.find((n) => n.id === examId.value)
    parts.push(e?.title ?? '中考')
  } else if (gradeCode.value != null) {
    const gn = currentGradeNode.value
    parts.push(`${dict.label(DICT_EDU_GRADE, gradeCode.value)}${gn?.volume != null ? (vol.value === 2 ? '下册' : '上册') : ''}`)
    if (paperType.value !== '') parts.push(`${dict.label(DICT_PAPER_TYPE, paperType.value)}卷`)
  }
  return parts
})

// ══ 缓存 ════════════════════════════════════════════════════
// mode 固定时用独立 key 后缀，避免与顶导航页（无 mode）/ 另一侧固定 mode 共享缓存互相污染 scope
const CACHE_KEY = props.mode ? `book-ui:paper-dir-sel:${props.mode}` : 'book-ui:paper-dir-sel'
interface CacheState { scope: 'public' | 'mine'; subject: number; stage: number; gradeCode: number | null; vol: number; examId: string; paperType: number | '' }
function readCache(): CacheState | null { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null') } catch { return null } }
function persist() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ scope: scope.value, subject: subject.value, stage: stage.value, gradeCode: gradeCode.value, vol: vol.value, examId: examId.value, paperType: paperType.value }))
  } catch { /* 隐私模式忽略 */ }
}

// ══ 应用筛选 → 拉列表 ═══════════════════════════════════════
function applyFilter() {
  persist()
  pageParams.subjectId = resolveTargetId()
  pageParams.pageIndex = 1
  fetchPapers()
}

// ══ 交互 ════════════════════════════════════════════════════
function pickScope(s: 'public' | 'mine') { if (props.mode) return; scope.value = s; kindTab.value = 'all'; applyFilter() } // mode 固定时类型 seg 不渲染，此处兜底防误触
// PRD-B-101 卷型 tab 切换（全部 / 备课卷）
function pickKind(k: 'all' | 'prep') { if (kindTab.value === k) return; kindTab.value = k; pageParams.pageIndex = 1; fetchPapers() }

function pickSubject(code: number) { subject.value = code; normalizeStageGrade(); applyFilter() }
function pickStage(code: number) { stage.value = code; normalizeStageGrade(); applyFilter(); pickerOpen.value = false } // 选好学段收起前半截
function pickGrade(g: number) {
  if (!gradesAvail.value.has(g)) return
  gradeCode.value = g; examId.value = ''
  if (!volsAvail.value.has(vol.value)) vol.value = [...volsAvail.value][0] ?? 1
  paperType.value = ''
  applyFilter()
}
function pickExam(id: string) { examId.value = id; gradeCode.value = null; paperType.value = ''; applyFilter() }
function pickVol(v: number) { if (!volsAvail.value.has(v)) return; vol.value = v; applyFilter() }
function pickPtype(pt: number | '') { paperType.value = pt; applyFilter() }

/** 换学科/学段后把年级归一化到可用值（无则清空落中考/空） */
function normalizeStageGrade() {
  examId.value = ''
  paperType.value = ''
  const avail = gradesAvail.value
  if (gradeCode.value == null || !avail.has(gradeCode.value)) {
    gradeCode.value = avail.size ? [...avail].sort((a, b) => a - b)[0] : null
  }
  if (gradeCode.value != null && !volsAvail.value.has(vol.value)) vol.value = [...volsAvail.value][0] ?? 1
}

// ── 顶部搜索框 ─────────────────────────────────────────────
const searchName = ref('')
const searchLoading = ref(false)
function onSearch() { pageParams.name = searchName.value.trim(); pageParams.pageIndex = 1; fetchPapers() }

// ══ 卷列表 + 分页（保留原逻辑）══════════════════════════════
const papers = ref<PaperListItem[]>([])
const listLoading = ref(false)
const total = ref(0)
const pageParams = reactive({ name: '', subjectId: '', pageIndex: 1, pageSize: 10 })
const { run: runAbortable } = useAbortableRequest<MisiktPageVo<PaperListItem>>()

async function fetchPapers() {
  if (scope.value === 'mine' && !userStore.userInfo) {
    try { const info = await getCurrentUser(); if (info) userStore.setUserInfo(info) } catch (e) { console.warn('[PaperLibrary] getCurrentUser 兜底失败', e) }
  }
  listLoading.value = true
  searchLoading.value = true
  try {
    // 备课卷 tab：绕过年级/学科树（subjectId 置空），加 paperKind='2'（仅 mine 生效）
    const usePrep = prepOnly.value
    const result = await runAbortable((signal) =>
      getPaperPage(
        {
          name: pageParams.name || '',
          subjectId: usePrep ? '' : pageParams.subjectId || '',
          pageIndex: pageParams.pageIndex,
          pageSize: pageParams.pageSize,
          scope: scope.value,
          ...(usePrep ? { paperKind: '2' as const } : {}),
        },
        { signal },
      ),
    )
    if (result === null) return
    if (result && Array.isArray(result.list)) { papers.value = result.list; total.value = result.total ?? 0 } else { papers.value = []; total.value = 0 }
  } catch (e) {
    console.warn('[paper-list] page failed', e); papers.value = []; total.value = 0
  } finally {
    listLoading.value = false; searchLoading.value = false
  }
}
function handlePageChange(p: number) { pageParams.pageIndex = p; fetchPapers() }
function handleSizeChange(s: number) { pageParams.pageSize = s; pageParams.pageIndex = 1; fetchPapers() }

// ── 业务动作（保留原逻辑）─────────────────────────────────
function handleView(item: PaperListItem) { router.push(`/papers/source/${item.id}`) }
function handleEdit(item: PaperListItem) { router.push(`/papers/edit/${item.id}`) }
function isOwner(item: PaperListItem): boolean {
  const uid = userStore.userInfo?.id
  if (uid == null || item.createUser == null) return false
  return String(item.createUser) === String(uid)
}
async function handleDelete(item: PaperListItem) {
  try {
    await ElMessageBox.confirm(`确认删除试卷「${item.name}」？删除后不可恢复。`, '删除试卷', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
  } catch { return }
  try { await deletePaper(item.id); ElMessage.success('删除成功'); fetchPapers() } catch (e) { console.warn('[PaperLibrary] deletePaper failed', e); ElMessage.error('删除失败') }
}
function handleNotOpen() { ElMessage.info('暂未开放') }
async function handleToggleBasket(item: PaperListItem) {
  if (!(await ensureLogin())) return
  if (basket.isLoading(item.id)) return
  if (basket.basketIds.value.has(item.id)) { await basket.remove(item.id) } else { await basket.add(item) }
}

// ══ 生命周期 ════════════════════════════════════════════════
async function loadTree() {
  treeLoading.value = true
  try {
    const result = await getPaperLazyTree()
    const flat: PaperTreeNode[] = []
    const walk = (ns?: PaperTreeNode[]) => { (ns ?? []).forEach((n) => { flat.push(n); walk(n.children) }) }
    walk(Array.isArray(result) ? result : [])
    gradeNodes.value = flat.filter((n) => n.nodeKind === 'grade')
    examNodes.value = flat.filter((n) => n.nodeKind === 'exam')
    ptypeNodes.value = flat.filter((n) => n.nodeKind === 'ptype')
  } catch (e) {
    console.warn('[paper-tree] lazyTree failed', e)
  } finally {
    treeLoading.value = false
  }
}

onMounted(async () => {
  // PRD-C-212 V0 首屏瀑布并行化：用户信息兜底 / 4 字典 / 卷库树 三者互不依赖，
  // 原先三段串行（user → dicts → tree）= 3 个 RTT，并行后 1 个 RTT。
  const userReady: Promise<void> = !userStore.userInfo
    ? getCurrentUser()
        .then((info) => { if (info) userStore.setUserInfo(info) })
        .catch((e) => console.warn('[PaperLibrary] getCurrentUser 兜底失败', e))
    : Promise.resolve()
  await Promise.all([
    userReady,
    dict.load(DICT_EDU_SUBJECT), dict.load(DICT_EDU_STAGE), dict.load(DICT_EDU_GRADE), dict.load(DICT_PAPER_TYPE),
    loadTree(),
  ])

  // 恢复缓存 > 页面默认（数学·初中·七上）
  const c = readCache()
  if (c) {
    // mode 固定时忽略缓存里的 scope，防止缓存把它拽回另一侧
    if (!props.mode) scope.value = c.scope
    subject.value = c.subject; stage.value = c.stage
    gradeCode.value = c.gradeCode; vol.value = c.vol; examId.value = c.examId; paperType.value = c.paperType
    // 缓存的选择在当前数据下若失效则归一化
    if (!isExam.value) normalizeStageGrade()
  } else {
    normalizeStageGrade()
  }
  // ?mine=1 进入 → 我的卷库（mode 固定场景跳过，scope 已由 prop 锁死）
  if (!props.mode && route.query.mine === '1') scope.value = 'mine'

  pageParams.subjectId = resolveTargetId()
  fetchPapers()
})
</script>

<template>
  <div class="papers-page">
    <!-- ══ 左侧卷库目录（对齐题库目录）══ -->
    <aside class="dir">
      <div class="dir-head">
        <div class="t"><span class="bar" /><b>卷库目录</b></div>
        <span class="n">{{ total }} 卷</span>
      </div>
      <div v-loading="treeLoading" class="dir-body">
        <!-- PRD-B-101 卷型 tab（仅我的卷库）：全部 / 备课卷 -->
        <div v-if="showKindTab" class="grp kind-grp">
          <div class="grp-lab">卷型</div>
          <div class="seg">
            <button :class="{ on: kindTab === 'all' }" @click="pickKind('all')">全部</button>
            <button :class="{ on: kindTab === 'prep' }" @click="pickKind('prep')">备课卷</button>
          </div>
        </div>
        <!-- 备课卷 tab：绕过年级/学科树，按本人全部列出 -->
        <div v-if="prepOnly" class="prep-note">备课卷按本人全部列出，不受年级/学科筛选</div>

        <!-- 当前选择 / 收放开关 -->
        <div v-show="!prepOnly" class="crumb" :class="{ open: pickerOpen }" @click="togglePicker">
          <div class="ico" :class="isSci ? 'sci' : 'math'">{{ crumbIco }}</div>
          <div class="txt">
            <div class="l1"><span class="main">{{ crumbMain }}</span><span class="ed">{{ crumbTag }}</span></div>
            <!-- mode 固定（public-only/mine-only）时类型段已隐藏，收起条文案同步不提"类型" -->
            <div class="l2">{{ pickerOpen ? '选好学段自动收起 ▴' : (props.mode ? '点此切换 学科·学段 ▾' : '点此切换 类型·学科·学段 ▾') }}</div>
          </div>
          <el-icon class="chev"><ArrowDown /></el-icon>
        </div>

        <!-- 收放筛选 -->
        <div v-show="!prepOnly" class="picker" :class="{ collapsed: !pickerOpen }">
        <div class="picker-in">
        <!-- 类型（mode 固定时不渲染切换段） -->
        <div v-if="!props.mode" class="grp">
          <div class="grp-lab">类型</div>
          <div class="seg">
            <button :class="{ on: scope === 'public' }" @click="pickScope('public')">公共试卷</button>
            <button :class="{ on: scope === 'mine' }" @click="pickScope('mine')">我的卷库</button>
          </div>
        </div>
        <!-- 学科 -->
        <div class="grp">
          <div class="grp-lab">学科</div>
          <div class="seg">
            <button v-for="s in subjectList" :key="s.dictValue" :class="{ on: subject === Number(s.dictValue) }" @click="pickSubject(Number(s.dictValue))">{{ s.dictLabel }}</button>
          </div>
        </div>
        <!-- 学段 -->
        <div class="grp">
          <div class="grp-lab">学段</div>
          <div class="seg">
            <button v-for="st in stageList" :key="st.dictValue" :class="{ on: stage === Number(st.dictValue) }" @click="pickStage(Number(st.dictValue))">{{ st.dictLabel }}</button>
          </div>
        </div>
        </div><!-- /picker-in -->
        </div><!-- /picker：收放只管 类型/学科/学段 -->

        <!-- 年级/册/卷型：常驻不收（前面半截才收）；备课卷 tab 绕过树整体隐藏 -->
        <!-- 年级 大卡 + 中考专区 -->
        <div v-show="!prepOnly" class="grp">
          <div class="grp-lab">年级（点选即定位）</div>
          <div class="grades">
            <div
              v-for="g in (STAGE_GRADES[stage] || [])"
              :key="g"
              class="grade"
              :class="{ on: !isExam && gradeCode === g, dim: !gradesAvail.has(g) }"
              @click="pickGrade(g)"
            >
              <div class="num">{{ GRADE_NUM[g] }}</div>
              <div class="cn">{{ dict.label(DICT_EDU_GRADE, g) }}</div>
            </div>
          </div>
          <div v-if="examList.length" class="zk">
            <div v-for="e in examList" :key="e.id" class="chip" :class="{ on: examId === e.id }" @click="pickExam(e.id)">{{ e.title }}</div>
          </div>
          <div v-if="!stageHasData" class="stage-empty">该学段暂无卷（分类骨架待补）</div>
        </div>
        <!-- 册 -->
        <div v-show="!prepOnly" class="grp">
          <div class="grp-lab">册</div>
          <div class="seg">
            <button :disabled="isExam || !volsAvail.has(1)" :class="{ on: !isExam && vol === 1 && volsAvail.has(1) }" @click="pickVol(1)">上册</button>
            <button :disabled="isExam || !volsAvail.has(2)" :class="{ on: !isExam && vol === 2 && volsAvail.has(2) }" @click="pickVol(2)">下册</button>
          </div>
        </div>
        <!-- 卷型 -->
        <div v-show="!prepOnly" class="grp" :class="{ dis: isExam || gradeCode == null }">
          <div class="grp-lab">卷型（可留空 = 该年级全部）</div>
          <div class="ptype">
            <div class="chip" :class="{ on: paperType === '' }" @click="pickPtype('')">全部</div>
            <div
              v-for="pt in ptypeList"
              :key="pt.dictValue"
              class="chip"
              :class="{ on: paperType === Number(pt.dictValue), dim: !ptypesAvail.has(Number(pt.dictValue)) }"
              @click="ptypesAvail.has(Number(pt.dictValue)) && pickPtype(Number(pt.dictValue))"
            >{{ pt.dictLabel }}</div>
          </div>
        </div>
        <div class="divln" />
        <div class="search-mini">
          <el-input v-model="searchName" placeholder="输入试卷名字筛选…" size="small" clearable @keyup.enter="onSearch">
            <template #prefix><el-icon><Search /></el-icon></template>
          </el-input>
        </div>
      </div>
    </aside>

    <!-- ══ 右侧内容区（保留原样）══ -->
    <section class="paper-main">
      <div class="search-bar">
        <el-input v-model="searchName" placeholder="输入试卷名字" class="search-input" clearable @keyup.enter="onSearch" />
        <el-button type="primary" :loading="searchLoading" class="search-btn" @click="onSearch">
          <el-icon><Search /></el-icon><span>查询</span>
        </el-button>
      </div>
      <div class="crumbbar">
        <template v-for="(c, i) in crumb" :key="i">
          <span v-if="i === 0" class="pill">{{ c }}</span>
          <span v-else class="seg-crumb"><span class="sep">/</span>{{ c }}</span>
        </template>
      </div>

      <div v-loading="listLoading" class="paper-list">
        <div v-for="item in papers" :key="item.id" class="paper-card">
          <div class="paper-card-row1">
            <div class="paper-card-title-area">
              <el-icon class="paper-star" @click="handleNotOpen"><Star /></el-icon>
              <span class="paper-name" @click="handleView(item)">{{ item.name }}</span>
            </div>
            <div class="paper-card-actions">
              <el-link type="primary" :underline="false" @click="handleView(item)">查看</el-link>
              <el-link v-if="isOwner(item)" type="primary" :underline="false" @click="handleEdit(item)">编辑</el-link>
              <el-link v-if="isOwner(item)" type="danger" :underline="false" @click="handleDelete(item)">删除</el-link>
              <el-link :type="basket.basketIds.value.has(item.id) ? 'danger' : 'primary'" :underline="false" :disabled="basket.isLoading(item.id)" @click="handleToggleBasket(item)">
                {{ basket.basketIds.value.has(item.id) ? '移出试卷篮' : '加入试卷篮' }}
              </el-link>
            </div>
          </div>
          <div class="paper-card-row2">
            <div class="paper-field"><span class="paper-field-label">总分</span><span class="paper-field-colon">:</span><span class="paper-field-value">{{ item.score }}</span></div>
            <div class="paper-field"><span class="paper-field-label">时长</span><span class="paper-field-colon">:</span><span class="paper-field-value">{{ item.suggestTime ?? '' }} 分钟</span></div>
            <div class="paper-field"><span class="paper-field-label">题目数</span><span class="paper-field-colon">:</span><span class="paper-field-value">{{ item.questionCount }}</span></div>
            <div class="paper-field"><span class="paper-field-label">创建时间</span><span class="paper-field-colon">:</span><span class="paper-field-value">{{ item.createTime }}</span></div>
          </div>
        </div>
        <el-empty v-if="!listLoading && papers.length === 0" description="暂无试卷" />
      </div>

      <div class="pagination-wrap">
        <el-pagination
          background
          layout="total, sizes, prev, pager, next, jumper"
          :total="total"
          :current-page="pageParams.pageIndex"
          :page-size="pageParams.pageSize"
          :page-sizes="[10, 20, 50]"
          @current-change="handlePageChange"
          @size-change="handleSizeChange"
        />
      </div>
    </section>

  </div>
</template>

<style scoped>
.papers-page { display: flex; height: 100%; background: #f0f2f5; position: relative; overflow: hidden; gap: 14px; padding: 14px; }

/* ── 左侧卷库目录（题库目录同构）─────────────────── */
.dir { width: 300px; flex-shrink: 0; background: #fff; border: 1px solid var(--bk-line); border-radius: 12px; box-shadow: 0 1px 3px rgba(19, 49, 43, .05); display: flex; flex-direction: column; overflow: hidden; }
.dir-head { padding: 13px 14px; border-bottom: 1px solid #eef2f2; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
.dir-head .t { display: flex; align-items: center; gap: 8px; }
.dir-head .bar { width: 3px; height: 15px; border-radius: 2px; background: #7b6cf0; }
.dir-head b { font-size: 14px; font-weight: 700; color: var(--bk-ink); }
.dir-head .n { font-size: 10.5px; color: #a8b2b6; }
.dir-body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 10px 10px; }

/* 卡头 + 收放（对齐题库目录） */
.crumb { padding: 8px 9px; border: 1px solid #e3e9e9; border-radius: 9px; background: #fafdfd; cursor: pointer; display: flex; align-items: center; gap: 7px; transition: .15s; margin-bottom: 11px; }
.crumb:hover { border-color: #cfe0e0; background: #f3faf9; }
.crumb .ico { width: 26px; height: 26px; border-radius: 7px; flex-shrink: 0; display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 12.5px; }
.crumb .ico.math { background: linear-gradient(135deg, #14958a, var(--bk-teal)); }
.crumb .ico.sci { background: linear-gradient(135deg, #8f86f4, #6357d6); }
.crumb .txt { flex: 1; min-width: 0; }
.crumb .l1 { font-size: 12px; font-weight: 700; color: var(--bk-ink); line-height: 1.25; display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.crumb .l1 .main { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.crumb .l2 { font-size: 10px; color: #7c8a90; margin-top: 1px; }
.crumb .ed { font-size: 9.5px; font-weight: 600; padding: 1px 5px; border-radius: 4px; background: #efeefe; color: #7b6cf0; flex-shrink: 0; }
.crumb .chev { color: #a8b2b6; transition: .25s; flex-shrink: 0; font-size: 13px; }
.crumb.open .chev { transform: rotate(180deg); }
.picker { max-height: 520px; overflow: hidden; transition: max-height .3s cubic-bezier(.4, 0, .2, 1); }
.picker.collapsed { max-height: 0; }

.grp { margin-bottom: 12px; }
.grp.dis { opacity: .5; pointer-events: none; }
.kind-grp { margin-bottom: 10px; }
.prep-note { font-size: 11px; color: var(--bk-teal-deep); background: var(--bk-teal-soft); border-radius: 7px; padding: 7px 9px; margin-bottom: 11px; line-height: 1.5; }
.grp-lab { font-size: 10px; font-weight: 700; letter-spacing: 1px; color: #7c8a90; text-transform: uppercase; margin-bottom: 6px; }
.seg { display: flex; background: #eef2f2; border-radius: 8px; padding: 2px; gap: 2px; }
.seg button { flex: 1; border: 0; background: transparent; font-size: 12.5px; font-weight: 600; color: #536268; padding: 7px 4px; border-radius: 6px; cursor: pointer; transition: .15s; }
.seg button.on { background: #fff; color: var(--bk-teal); box-shadow: 0 1px 3px rgba(19, 49, 43, .05); }
.seg button:disabled { color: #a8b2b6; cursor: not-allowed; opacity: .45; }
.grades { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.grade { border: 1px solid #e3e9e9; border-radius: 9px; background: #fff; cursor: pointer; padding: 8px 4px 6px; text-align: center; transition: .15s; position: relative; overflow: hidden; }
.grade .num { font-size: 17px; font-weight: 700; color: var(--bk-ink); line-height: 1; }
.grade .cn { font-size: 10px; color: #7c8a90; margin-top: 2px; font-weight: 600; }
.grade:hover { border-color: #14958a; }
.grade.on { border-color: var(--bk-teal); background: linear-gradient(180deg, #f0faf9, #fff); }
.grade.on .num { color: var(--bk-teal); }
.grade.on::before { content: ''; position: absolute; inset: 0 0 auto 0; height: 3px; background: var(--bk-teal); }
.grade.dim { opacity: .32; pointer-events: none; filter: grayscale(.4); }
.zk { display: flex; gap: 6px; margin-top: 7px; flex-wrap: wrap; }
.zk .chip { flex: 1; justify-content: center; }
.stage-empty { margin-top: 8px; font-size: 11.5px; color: #a8b2b6; text-align: center; padding: 6px; }
.chip { display: inline-flex; align-items: center; justify-content: center; gap: 4px; font-size: 11.5px; font-weight: 600; color: #536268; background: #fff; border: 1px solid #e3e9e9; padding: 5px 11px; border-radius: 999px; cursor: pointer; transition: .15s; user-select: none; }
.chip:hover { border-color: #14958a; color: var(--bk-teal); }
.chip.on { background: var(--bk-teal); border-color: var(--bk-teal); color: #fff; }
.chip.dim { opacity: .35; pointer-events: none; }
.ptype { display: flex; flex-wrap: wrap; gap: 6px; }
.ptype .chip.on { background: var(--bk-teal-soft); border-color: var(--bk-teal); color: var(--bk-teal); }
.divln { height: 1px; background: #eef2f2; margin: 4px 0 10px; }
.search-mini { padding: 0 1px; }

/* ── 右侧内容区 ───────────────────────────── */
.paper-main { flex: 1; height: 100%; padding: 2px 4px 2px 0; display: flex; flex-direction: column; gap: 12px; min-width: 0; overflow: hidden; }
.search-bar { display: flex; gap: 10px; align-items: center; flex-shrink: 0; }
.search-input { width: 260px; }
.search-btn { padding: 0 18px; }
.crumbbar { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: #7c8a90; flex-shrink: 0; flex-wrap: wrap; }
.crumbbar .pill { background: var(--bk-teal-soft); color: var(--bk-teal); font-weight: 700; padding: 3px 10px; border-radius: 999px; }
.crumbbar .seg-crumb { display: inline-flex; align-items: center; gap: 6px; }
.crumbbar .sep { color: #cbd4d6; }
.paper-list { flex: 1; background: #fff; border-radius: 12px; border: 1px solid var(--bk-line); box-shadow: 0 1px 3px rgba(19, 49, 43, .05); min-height: 0; overflow-y: auto; }
.paper-card { padding: 16px 20px; border-bottom: 1px solid #ebeef5; display: flex; flex-direction: column; gap: 12px; background: #fff; transition: background .15s ease; }
.paper-card:last-child { border-bottom: none; }
.paper-card:hover { background: #fafcfc; }
.paper-card-row1 { display: flex; justify-content: space-between; align-items: center; }
.paper-card-title-area { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
.paper-star { font-size: 16px; color: #c0c4cc; cursor: pointer; transition: color .15s ease; }
.paper-star:hover { color: var(--bk-teal); }
.paper-name { font-size: 14px; font-weight: 600; color: var(--bk-teal); cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.paper-name:hover { text-decoration: underline; }
.paper-card-actions { display: flex; gap: 16px; flex-shrink: 0; }
.paper-card-row2 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; color: #606266; font-size: 13px; }
.paper-field { display: flex; align-items: center; }
.paper-field-label { color: #909399; }
.paper-field-colon { margin-right: 8px; color: #909399; }
.paper-field-value { color: #303133; }
.pagination-wrap { flex-shrink: 0; display: flex; justify-content: flex-start; padding: 12px 0 12px 8px; background: #fff; border-radius: 12px; border: 1px solid var(--bk-line); }
</style>
