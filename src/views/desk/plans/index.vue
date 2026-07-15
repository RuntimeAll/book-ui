<script setup lang="ts">
/**
 * PRD-C-213 课程计划页（/desk/plans）—— FP16~19 + FP21 + FP22。
 *
 * FP16 计划列表：卡片墙（名/term·year/对象类型/素材/课次数/状态 pill + 流转 + 复制 + 新建·编辑）。
 * FP17 课次行：选中计划展开课次表，行编辑/新增/删除/上下移（reorder）。大纲态课次合法不逼填。
 * FP18 课内锚点：课次编辑内 kg_node_ids 多选（复用题库 lazyTree 树），选中 chip 展示 + 点跳题库。
 * FP21 细备窗口徽标：课次绑定场次落在未来 14 天内（getPrepTodo(14)）显「窗口内」，窗口外不催。
 * FP22 家长版导出入口：工具栏按钮 → 选对象 → parentExport → 弹窗展示图片 + 下载。
 *
 * 🔴 PRD-003 P6/D7：旧「专项卷位」（paper_slots 编辑器 / 绑定链 / manual_ready）整套退役，
 *   课次材料统一走「专项材料位」（biz_course_plan_lesson.special_ids）——本课绑定的专项列表，
 *   持久可回看复盘。备课态实时推导：有材料=已备好，无=未备（不存冗余列）。
 *
 * 🔴 id 全 string；枚举走 *_LABEL 映射；BE 未起时优雅空态（拦截器弹错，页面兜 null）。
 */
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  pagePlans,
  getPlan,
  copyPlan,
  updatePlan,
  deleteLesson,
  reorderLessons,
  getPrepTodo,
  PLAN_STATUS_LABEL,
  TARGET_TYPE_LABEL,
  type PlanVO,
  type PlanLessonVO,
  type PlanStatus,
  type PlanPageParams,
} from '@/api/teacher/schedule'
import { getTarget } from '@/api/teacher/schedule'
import { lazyTree, type SubjectNode } from '@/api/question/index'
import {
  getLessonMaterials,
  bindSpecialToLesson,
  unbindSpecialFromLesson,
  type SpecialSummary,
} from '@/api/special'
import { useSpecialStore } from '@/store/special'
import {
  pageBooks,
  getBookStructure,
  bindBookNodeToLesson,
  unbindBookNodeFromLesson,
  getLessonBookMaterials,
  BOOK_TYPE_LABEL,
  type ShelfBookVO,
  type ShelfNodeVO,
  type ShelfStructureVO,
  type LessonBookMaterialVO,
} from '@/api/shelf'
import PlanFormDialog from './components/PlanFormDialog.vue'
import LessonEditDialog from './components/LessonEditDialog.vue'
import ParentExportDialog from './components/ParentExportDialog.vue'

const router = useRouter()
const route = useRoute()
const specialStore = useSpecialStore()

// 计划归属对象名缓存（PlanVO 无 targetName，「学生」项 best-effort 取档案名）
const targetNameCache = new Map<string, string>()
async function resolveTargetName(targetId?: string | null): Promise<string> {
  if (!targetId) return ''
  const key = String(targetId)
  if (targetNameCache.has(key)) return targetNameCache.get(key) || ''
  try {
    const t = await getTarget(key)
    const name = t?.name ?? ''
    targetNameCache.set(key, name)
    return name
  } catch {
    return ''
  }
}

// 备课态（PRD-003 P6：材料位推导 —— 有专项材料=已备好，无=未备）
const PREP_LABEL: Record<string, string> = { '0': '未备', '2': '已备好' }
function prepPillClass(s: string): string {
  return s === '2' ? 'ok' : 'todo'
}

// ── 计划列表（FP16）────────────────────────────────────────────────────────
const plans = ref<PlanVO[]>([])
const loadingPlans = ref(false)
const filter = ref<PlanPageParams>({ keyword: '', status: undefined, targetType: undefined })

async function loadPlans() {
  loadingPlans.value = true
  try {
    const params: PlanPageParams = { pageNum: 1, pageSize: 100 }
    if (filter.value.keyword) params.keyword = filter.value.keyword
    if (filter.value.status) params.status = filter.value.status
    if (filter.value.targetType) params.targetType = filter.value.targetType
    const res = await pagePlans(params)
    plans.value = res?.rows ?? []
    if (selectedPlanId.value && !plans.value.some((p) => p.id === selectedPlanId.value)) {
      selectedPlanId.value = null
      planDetail.value = null
    }
  } catch {
    plans.value = []
  } finally {
    loadingPlans.value = false
  }
}

// ── 计划详情 + 课次（FP17）──────────────────────────────────────────────────
const selectedPlanId = ref<string | null>(null)
const planDetail = ref<PlanVO | null>(null)
const loadingDetail = ref(false)
const expandedLessons = ref<Set<string>>(new Set())
let detailToken = 0

async function selectPlan(id: string) {
  if (selectedPlanId.value === id) return
  selectedPlanId.value = id
  await loadDetail(id)
}

async function loadDetail(id: string) {
  const token = ++detailToken
  loadingDetail.value = true
  planDetail.value = null
  try {
    const res = await getPlan(id)
    if (token !== detailToken) return
    planDetail.value = res
    const open = new Set<string>()
    ;(res?.lessons ?? []).forEach((l) => {
      if (windowLessonIds.value.has(l.id)) open.add(l.id)
    })
    expandedLessons.value = open
    // 预载所有课次材料（备课态推导 + 材料位展示）
    void loadAllMaterials(res?.lessons ?? [])
  } catch {
    if (token === detailToken) planDetail.value = null
  } finally {
    if (token === detailToken) loadingDetail.value = false
  }
}

const lessons = computed<PlanLessonVO[]>(() =>
  [...(planDetail.value?.lessons ?? [])].sort((a, b) => (a.lessonSeq ?? 0) - (b.lessonSeq ?? 0)),
)

function toggleLesson(id: string) {
  const next = new Set(expandedLessons.value)
  next.has(id) ? next.delete(id) : next.add(id)
  expandedLessons.value = next
}

// ── 细备窗口（FP21）─────────────────────────────────────────────────────────
const windowLessonIds = ref<Set<string>>(new Set())
async function loadWindow() {
  try {
    const todo = await getPrepTodo(14)
    const s = new Set<string>()
    ;(todo ?? []).forEach((t) => {
      if (t.planLessonId) s.add(String(t.planLessonId))
    })
    windowLessonIds.value = s
  } catch {
    windowLessonIds.value = new Set()
  }
}

// ── KG 树（FP18）───────────────────────────────────────────────────────────
const kgTree = ref<SubjectNode[]>([])
const kgLoading = ref(false)
const kgTitleMap = ref<Map<string, string>>(new Map())

function flattenTree(nodes: SubjectNode[], map: Map<string, string>) {
  for (const n of nodes) {
    map.set(String(n.id), n.title)
    if (n.children?.length) flattenTree(n.children as SubjectNode[], map)
  }
}

async function loadKgTree() {
  kgLoading.value = true
  try {
    const res = await lazyTree(0)
    const arr = Array.isArray(res) ? res : res ? [res as unknown as SubjectNode] : []
    kgTree.value = arr
    const map = new Map<string, string>()
    flattenTree(arr, map)
    kgTitleMap.value = map
  } catch {
    kgTree.value = []
  } finally {
    kgLoading.value = false
  }
}

function kgTitle(id: string): string {
  return kgTitleMap.value.get(String(id)) || `锚点 ${id}`
}

function jumpToQuestions(kgId: string) {
  router.push({ name: 'QuestionIndex', query: { subjectId: kgId } })
}

// ── 计划状态流转（FP16）────────────────────────────────────────────────────
function statusPillClass(status: PlanStatus): string {
  return status === '1' ? 'ok' : status === '0' ? 'mid' : 'mute'
}
function nextStatusActions(status: PlanStatus): { label: string; to: PlanStatus }[] {
  if (status === '0') return [{ label: '启用', to: '1' }]
  if (status === '1') return [{ label: '归档', to: '2' }]
  return [{ label: '恢复启用', to: '1' }]
}

async function changeStatus(plan: PlanVO, to: PlanStatus) {
  try {
    await updatePlan(plan.id, {
      name: plan.name,
      targetType: plan.targetType,
      termTag: plan.termTag,
      year: plan.year,
      materialNote: plan.materialNote,
      defaultSegTemplate: plan.defaultSegTemplate,
      status: to,
    })
    ElMessage.success(`已${PLAN_STATUS_LABEL[to]}`)
    await loadPlans()
    if (planDetail.value?.id === plan.id) planDetail.value = { ...planDetail.value, status: to }
  } catch {
    /* 拦截器已弹错 */
  }
}

async function doCopyPlan(plan: PlanVO) {
  try {
    const res = await copyPlan(plan.id)
    ElMessage.success('计划已复制')
    await loadPlans()
    if (res?.id) await selectPlan(res.id)
  } catch {
    /* 拦截器已弹错 */
  }
}

// ── 计划弹窗（FP16）────────────────────────────────────────────────────────
const planFormVisible = ref(false)
const editingPlan = ref<PlanVO | null>(null)

function openNewPlan() {
  editingPlan.value = null
  planFormVisible.value = true
}
function openEditPlan(plan: PlanVO) {
  editingPlan.value = plan
  planFormVisible.value = true
}
async function onPlanSaved(id: string) {
  await loadPlans()
  if (id) {
    selectedPlanId.value = id
    await loadDetail(id)
  }
}

// ── 课次弹窗（FP17）────────────────────────────────────────────────────────
const lessonEditVisible = ref(false)
const editingLesson = ref<PlanLessonVO | null>(null)

function openNewLesson() {
  if (!planDetail.value) return
  editingLesson.value = null
  lessonEditVisible.value = true
}
function openEditLesson(lesson: PlanLessonVO) {
  editingLesson.value = lesson
  lessonEditVisible.value = true
}
async function onLessonSaved() {
  if (selectedPlanId.value) {
    await Promise.all([loadDetail(selectedPlanId.value), loadPlans(), loadWindow()])
  }
}

async function removeLesson(lesson: PlanLessonVO) {
  try {
    await ElMessageBox.confirm(`确认删除课次「${lesson.title}」？`, '删除课次', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await deleteLesson(lesson.id)
    ElMessage.success('课次已删除')
    await onLessonSaved()
  } catch {
    /* 拦截器已弹错 */
  }
}

async function moveLesson(index: number, dir: -1 | 1) {
  const list = lessons.value
  const target = index + dir
  if (target < 0 || target >= list.length) return
  const ids = list.map((l) => l.id)
  ;[ids[index], ids[target]] = [ids[target], ids[index]]
  if (!selectedPlanId.value) return
  try {
    await reorderLessons(selectedPlanId.value, ids)
    await loadDetail(selectedPlanId.value)
  } catch {
    /* 拦截器已弹错 */
  }
}

// ── 专项材料位（PRD-003 P6，取代旧卷位）────────────────────────────────────
// lessonId -> 已绑专项概要列表
const materialsByLesson = ref<Map<string, SpecialSummary[]>>(new Map())

function materialsOf(lessonId: string): SpecialSummary[] {
  return materialsByLesson.value.get(lessonId) ?? []
}
// 备课态：有专项材料或有书章节=已备好(2)，全空=未备(0)（实时推导，不存冗余列）
function lessonPrepState(lessonId: string): string {
  return materialsOf(lessonId).length > 0 || bookMaterialsOf(lessonId).length > 0 ? '2' : '0'
}

async function loadMaterials(lessonId: string) {
  try {
    const res = await getLessonMaterials(lessonId)
    const next = new Map(materialsByLesson.value)
    next.set(lessonId, res?.specials ?? [])
    materialsByLesson.value = next
  } catch {
    /* 拦截器已弹错 */
  }
}

async function loadAllMaterials(lessonsArr: PlanLessonVO[]) {
  await Promise.allSettled(lessonsArr.flatMap((l) => [loadMaterials(l.id), loadBookMaterials(l.id)]))
}

// 从备课栏当前专项添加到本课（bind）；无当前专项则引导去备课栏建/选
async function addMaterial(lesson: PlanLessonVO) {
  await specialStore.ensureLoaded()
  const list = specialStore.specials
  if (list.length === 0) {
    ElMessage.info('还没有专项——先在右下「快捷中枢 · 备课栏」新建专项，再回来添加')
    return
  }
  const already = new Set(materialsOf(lesson.id).map((s) => s.id))
  const candidates = list.filter((s) => !already.has(s.id))
  if (candidates.length === 0) {
    ElMessage.info('备课栏里的专项都已加入本课')
    return
  }
  // 用 messagebox 让老师选一个专项（简选：编号列表）
  const optionsText = candidates.map((s, i) => `${i + 1}. ${s.title}（${s.itemCount ?? 0} 题）`).join('\n')
  let pick = ''
  try {
    const r = await ElMessageBox.prompt(
      `输入编号选择要加入本课的专项：\n${optionsText}`,
      `添加专项到「${lesson.title}」`,
      {
        confirmButtonText: '添加',
        cancelButtonText: '取消',
        inputPattern: /^\d+$/,
        inputErrorMessage: '请输入编号',
      },
    )
    pick = (r.value || '').trim()
  } catch {
    return
  }
  const idx = Number(pick) - 1
  const chosen = candidates[idx]
  if (!chosen) {
    ElMessage.warning('编号无效')
    return
  }
  try {
    await bindSpecialToLesson(lesson.id, chosen.id)
    await loadMaterials(lesson.id)
    ElMessage.success(`已添加「${chosen.title}」`)
  } catch {
    /* 拦截器已弹错 */
  }
}

async function removeMaterial(lesson: PlanLessonVO, special: SpecialSummary) {
  try {
    await ElMessageBox.confirm(`把「${special.title}」从本课材料移除？（专项本身保留在备课栏）`, '移除材料', {
      type: 'warning',
      confirmButtonText: '移除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await unbindSpecialFromLesson(lesson.id, special.id)
    await loadMaterials(lesson.id)
    ElMessage.success('已移除')
  } catch {
    /* 拦截器已弹错 */
  }
}

function editSpecial(special: SpecialSummary) {
  router.push(`/special/${special.id}/edit`)
}

// ── 书籍章节材料位（课次绑定书「讲/节」，与专项材料并列）──────────────────
// lessonId -> 已绑书章节材料列表（BE 反查书名/节名/子树题数）
const bookMaterialsByLesson = ref<Map<string, LessonBookMaterialVO[]>>(new Map())

function bookMaterialsOf(lessonId: string): LessonBookMaterialVO[] {
  return bookMaterialsByLesson.value.get(lessonId) ?? []
}

async function loadBookMaterials(lessonId: string) {
  try {
    const res = await getLessonBookMaterials(lessonId)
    const next = new Map(bookMaterialsByLesson.value)
    next.set(lessonId, res?.materials ?? [])
    bookMaterialsByLesson.value = next
  } catch {
    /* 拦截器已弹错 */
  }
}

// 绑定弹窗：选书（pageBooks）→ 目录树挑一级/二级节点 → bind
const bindBookVisible = ref(false)
const bindingLesson = ref<PlanLessonVO | null>(null)
const bindBooks = ref<ShelfBookVO[]>([])
const bindBooksLoading = ref(false)
const bindBookId = ref('')
const bindStructure = ref<ShelfStructureVO | null>(null)
const bindStructureLoading = ref(false)

async function openBindBook(lesson: PlanLessonVO) {
  bindingLesson.value = lesson
  bindBookVisible.value = true
  if (bindBooks.value.length === 0) {
    bindBooksLoading.value = true
    try {
      const res = await pageBooks()
      bindBooks.value = res?.rows ?? []
    } catch {
      bindBooks.value = []
    } finally {
      bindBooksLoading.value = false
    }
  }
}

// 🔴 选书 → 拉结构：watch 唯一触发源（不叠 @change，防双触发）
watch(bindBookId, async (id) => {
  bindStructure.value = null
  if (!id) return
  bindStructureLoading.value = true
  try {
    bindStructure.value = await getBookStructure(id)
  } catch {
    bindStructure.value = null
  } finally {
    bindStructureLoading.value = false
  }
})

interface BindNodeRow {
  id: string
  name: string
  count: number
  children?: BindNodeRow[]
}

function subtreeQuestionCount(n: ShelfNodeVO): number {
  let c = (n.items ?? []).filter((it) => it.kind === 'question').length
  for (const ch of n.children ?? []) c += subtreeQuestionCount(ch)
  return c
}

// 目录树只露一级/二级节点（绑「讲/节」粒度，不下探题型层）
const bindTreeData = computed<BindNodeRow[]>(() => {
  const mapNode = (n: ShelfNodeVO, depth: number): BindNodeRow => ({
    id: n.id,
    name: n.name,
    count: subtreeQuestionCount(n),
    children: depth < 1 ? (n.children ?? []).map((c) => mapNode(c, depth + 1)) : undefined,
  })
  return (bindStructure.value?.tree ?? []).map((n) => mapNode(n, 0))
})

const boundNodeIds = computed<Set<string>>(() => {
  const l = bindingLesson.value
  return new Set(l ? bookMaterialsOf(l.id).map((m) => m.nodeId) : [])
})

function bookTypeTag(b: ShelfBookVO): string {
  return (BOOK_TYPE_LABEL as Record<string, string>)[String(b.bookType)] ?? String(b.bookType)
}

async function doBindNode(row: BindNodeRow) {
  const lesson = bindingLesson.value
  if (!lesson) return
  try {
    await bindBookNodeToLesson(lesson.id, row.id)
    await loadBookMaterials(lesson.id)
    ElMessage.success(`已绑定「${row.name}」`)
  } catch {
    /* 拦截器已弹错 */
  }
}

async function removeBookMaterial(lesson: PlanLessonVO, bm: LessonBookMaterialVO) {
  try {
    await ElMessageBox.confirm(
      `把「${bm.bookTitle} · ${bm.nodeTitle}」从本课材料移除？（书本身不受影响）`,
      '移除书章节',
      { type: 'warning', confirmButtonText: '移除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    await unbindBookNodeFromLesson(lesson.id, bm.nodeId)
    await loadBookMaterials(lesson.id)
    ElMessage.success('已移除')
  } catch {
    /* 拦截器已弹错 */
  }
}

// 点击已绑章节卡 → 跳书浏览页并锚定该节
function openBookNode(bm: LessonBookMaterialVO) {
  router.push({ path: `/bookshelf/book/${bm.bookId}`, query: { nodeId: bm.nodeId } })
}

// ── FP22 家长版导出 ─────────────────────────────────────────────────────────
const parentExportVisible = ref(false)
function openParentExport() {
  if (!planDetail.value) return
  parentExportVisible.value = true
}

// ── 展示辅助 ────────────────────────────────────────────────────────────────
function planTermLabel(p: PlanVO): string {
  const parts = [p.termTag, p.year != null ? String(p.year) : ''].filter(Boolean)
  return parts.join(' · ')
}
function inWindow(lesson: PlanLessonVO): boolean {
  return windowLessonIds.value.has(lesson.id)
}

// ── 从 query 定位课次（去备课 / 概览 / 旧 /desk/prep 重定向 均落此页）──────────
async function locateFromQuery() {
  const q = route.query
  const lessonId = q.lessonId ? String(q.lessonId) : ''
  const planId = q.planId ? String(q.planId) : ''
  const targetId = q.targetId ? String(q.targetId) : ''
  let planToOpen = planId
  if (!planToOpen && targetId) {
    const p = plans.value.find((pl) => String(pl.targetId ?? '') === targetId)
    if (p) planToOpen = p.id
  }
  if (!planToOpen) return
  await selectPlan(planToOpen)
  // 记备课上下文（备课栏「正在备」+ 材料位 bind 用），best-effort 补学生名
  if (lessonId && planDetail.value) {
    const lesson = planDetail.value.lessons?.find((l) => l.id === lessonId)
    if (lesson) {
      const studentName = await resolveTargetName(planDetail.value.targetId)
      specialStore.setPrepContext({
        lessonId,
        lessonTitle: lesson.title,
        studentName,
        planId: planToOpen,
        targetId: planDetail.value.targetId ? String(planDetail.value.targetId) : '',
      })
    }
    const next = new Set(expandedLessons.value)
    next.add(lessonId)
    expandedLessons.value = next
    setTimeout(() => {
      document.getElementById(`lesson-${lessonId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 120)
  }
}

onMounted(async () => {
  await Promise.all([loadPlans(), loadWindow(), loadKgTree()])
  await locateFromQuery()
})
</script>

<template>
  <div class="c213-plans">
    <!-- 工具栏 -->
    <div class="vhead">
      <div>
        <h1 class="ph-h1">课程计划</h1>
        <p class="ph-sub">可复用的教学大纲 · 每个课次锚定知识图谱，讲义 / 组卷 / 举一反三一键直达</p>
      </div>
      <span class="spacer"></span>
      <el-button type="primary" @click="openNewPlan">
        <span class="plus">+</span> 新建计划
      </el-button>
    </div>

    <!-- 筛选 -->
    <div class="filter-bar">
      <el-input
        v-model="filter.keyword"
        placeholder="搜索计划名"
        clearable
        style="width: 220px"
        @keyup.enter="loadPlans"
        @clear="loadPlans"
      />
      <el-select v-model="filter.targetType" placeholder="对象类型" clearable style="width: 130px" @change="loadPlans">
        <el-option label="学生" value="0" />
        <el-option label="班级" value="1" />
      </el-select>
      <el-select v-model="filter.status" placeholder="状态" clearable style="width: 130px" @change="loadPlans">
        <el-option label="草稿" value="0" />
        <el-option label="启用" value="1" />
        <el-option label="归档" value="2" />
      </el-select>
      <el-button @click="loadPlans">查询</el-button>
    </div>

    <!-- 计划卡片墙（FP16）-->
    <div v-loading="loadingPlans" class="plan-list-wrap">
      <el-empty v-if="!loadingPlans && plans.length === 0" description="暂无课程计划，点右上「新建计划」创建" />
      <div v-else class="plan-list">
        <div
          v-for="p in plans"
          :key="p.id"
          class="plan-card"
          :class="{ sel: p.id === selectedPlanId }"
          @click="selectPlan(p.id)"
        >
          <div class="pc-top">
            <b class="pc-name">{{ p.name }}</b>
            <span class="pill flat" :class="statusPillClass(p.status)">{{ PLAN_STATUS_LABEL[p.status] }}</span>
          </div>
          <div class="tags">
            <span class="tag">{{ planTermLabel(p) }}</span>
            <span class="tag">{{ TARGET_TYPE_LABEL[p.targetType] }}</span>
            <span v-if="p.materialNote" class="tag">素材：{{ p.materialNote }}</span>
          </div>
          <div class="foot">
            <span><b>{{ p.lessonCount ?? p.lessons?.length ?? 0 }}</b> 课次</span>
            <span class="spacer"></span>
            <el-button link size="small" @click.stop="openEditPlan(p)">编辑</el-button>
            <el-button link size="small" @click.stop="doCopyPlan(p)">复制</el-button>
            <el-dropdown trigger="click" @command="(to: PlanStatus) => changeStatus(p, to)">
              <el-button link size="small" @click.stop>状态</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item
                    v-for="a in nextStatusActions(p.status)"
                    :key="a.to"
                    :command="a.to"
                  >
                    {{ a.label }}
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>
      </div>
    </div>

    <!-- 计划编辑区（FP17-19 + FP21 + FP22 + P6 材料位）-->
    <div v-if="selectedPlanId" v-loading="loadingDetail" class="plan-editor">
      <template v-if="planDetail">
        <div class="pe-head">
          <div class="who">
            <b>{{ planDetail.name }}</b>
            <div class="tags">
              <span class="tag">{{ planTermLabel(planDetail) }}</span>
              <span class="tag">{{ TARGET_TYPE_LABEL[planDetail.targetType] }}</span>
              <span v-if="planDetail.materialNote" class="tag">素材：{{ planDetail.materialNote }}</span>
              <span class="tag">{{ lessons.length }} 课次</span>
            </div>
          </div>
          <div class="acts">
            <el-button size="small" @click="openParentExport">家长版课表</el-button>
            <el-button size="small" @click="doCopyPlan(planDetail)">复制计划</el-button>
            <el-button size="small" type="primary" @click="openNewLesson">+ 添加课次</el-button>
          </div>
        </div>

        <!-- FP21 细备窗口说明 -->
        <div class="win-banner">
          <b>细备窗口 = 未来 2 周</b>：绑定场次落在 14 天内的课次标「窗口内」，请优先细备；窗口外保持大纲态即可，不催。
        </div>

        <!-- 课次列表（FP17）-->
        <el-empty v-if="lessons.length === 0" description="还没有课次，点「+ 添加课次」开始（大纲态即可）" :image-size="70" />
        <div v-else class="lesson-list">
          <div
            v-for="(lesson, idx) in lessons"
            :id="`lesson-${lesson.id}`"
            :key="lesson.id"
            class="lrow"
            :class="{ open: expandedLessons.has(lesson.id), dimmed: lessonPrepState(lesson.id) === '0' }"
          >
            <div class="lrow-bar" @click="toggleLesson(lesson.id)">
              <span class="lseq">{{ lesson.lessonSeq ?? idx + 1 }}</span>
              <div class="lt">
                <b>
                  {{ lesson.title }}
                  <span v-if="lesson.lessonType === '1'" class="pill mid flat lesson-test">🧪 测试</span>
                  <span v-if="lesson.tag" class="pill mid flat">{{ lesson.tag }}</span>
                </b>
                <span v-if="lesson.sourceRef">素材：{{ lesson.sourceRef }}</span>
              </div>
              <div class="bar-right">
                <span v-if="inWindow(lesson)" class="pill ok flat win-badge">窗口内</span>
                <span class="pill" :class="prepPillClass(lessonPrepState(lesson.id))">
                  {{ PREP_LABEL[lessonPrepState(lesson.id)] }}
                </span>
                <span class="chev">›</span>
              </div>
            </div>

            <div class="lrow-body">
              <!-- 本课材料（PRD-003 P6 专项材料位）-->
              <div class="slots-head">
                <span class="slots-t">本课材料</span>
                <span class="spacer"></span>
                <el-button size="small" @click="addMaterial(lesson)">+ 从备课栏添加专项</el-button>
                <el-button size="small" @click="openBindBook(lesson)">+ 绑定书籍章节</el-button>
              </div>

              <div v-if="materialsOf(lesson.id).length || bookMaterialsOf(lesson.id).length" class="materials">
                <div v-for="sp in materialsOf(lesson.id)" :key="sp.id" class="mat-row">
                  <span class="mat-ic">📄</span>
                  <div class="mat-main">
                    <b class="mat-name">{{ sp.title }}</b>
                    <span class="mat-meta">{{ sp.itemCount ?? 0 }} 题</span>
                  </div>
                  <div class="mat-acts">
                    <el-button link size="small" type="primary" @click="editSpecial(sp)">编辑</el-button>
                    <el-button link size="small" type="danger" @click="removeMaterial(lesson, sp)">移除</el-button>
                  </div>
                </div>
                <div
                  v-for="bm in bookMaterialsOf(lesson.id)"
                  :key="bm.nodeId"
                  class="mat-row mat-book"
                  title="点击到书浏览页查看该章节"
                  @click="openBookNode(bm)"
                >
                  <span class="mat-ic">📖</span>
                  <div class="mat-main">
                    <b class="mat-name">{{ bm.bookTitle }} · {{ bm.nodeTitle }}</b>
                    <span class="mat-meta">{{ bm.questionCount ?? 0 }} 题</span>
                  </div>
                  <div class="mat-acts">
                    <el-button link size="small" type="primary" @click.stop="openBookNode(bm)">查看</el-button>
                    <el-button link size="small" type="danger" @click.stop="removeBookMaterial(lesson, bm)">移除</el-button>
                  </div>
                </div>
              </div>
              <p v-else class="slots-empty">本课还没有材料。可「+ 从备课栏添加专项」，或「+ 绑定书籍章节」把书里的讲/节挂上来。</p>

              <!-- 思维动作 / 层数 -->
              <div v-if="lesson.thinkingAction || lesson.layerTarget" class="meta-line">
                <span v-if="lesson.thinkingAction">思维动作：{{ lesson.thinkingAction }}</span>
                <span v-if="lesson.layerTarget">　层数：{{ lesson.layerTarget }}</span>
              </div>

              <!-- KG 锚点（FP18）-->
              <div class="kg-row">
                <span class="kg-t">课内锚点</span>
                <template v-if="lesson.kgNodeIds?.length">
                  <span
                    v-for="kid in lesson.kgNodeIds"
                    :key="kid"
                    class="kg"
                    title="点击到题库查看该锚点题目"
                    @click="jumpToQuestions(kid)"
                  >
                    {{ kgTitle(kid) }}
                  </span>
                </template>
                <span v-else class="kg-empty">未设锚点</span>
                <el-button link size="small" @click="openEditLesson(lesson)">+ 编辑锚点</el-button>
              </div>

              <!-- 家长版文案（parent_copy）-->
              <div v-if="lesson.parentCopy" class="parent-copy">
                家长版文案：「{{ lesson.parentCopy }}」
              </div>

              <!-- 动作区 -->
              <div class="lrow-foot">
                <el-button size="small" @click="openEditLesson(lesson)">编辑课次</el-button>
                <el-button size="small" :disabled="idx === 0" @click="moveLesson(idx, -1)">上移</el-button>
                <el-button size="small" :disabled="idx === lessons.length - 1" @click="moveLesson(idx, 1)">下移</el-button>
                <el-button size="small" type="danger" plain @click="removeLesson(lesson)">删除</el-button>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- 弹窗 -->
    <PlanFormDialog v-model="planFormVisible" :plan="editingPlan" @saved="onPlanSaved" />
    <LessonEditDialog
      v-if="planDetail"
      v-model="lessonEditVisible"
      :plan-id="planDetail.id"
      :lesson="editingLesson"
      :kg-tree="kgTree"
      :kg-loading="kgLoading"
      @saved="onLessonSaved"
    />
    <ParentExportDialog v-model="parentExportVisible" :plan="planDetail" />

    <!-- 绑定书籍章节弹窗 -->
    <el-dialog
      v-model="bindBookVisible"
      :title="`绑定书籍章节到「${bindingLesson?.title ?? ''}」`"
      width="560px"
    >
      <el-select
        v-model="bindBookId"
        placeholder="选择一本书"
        filterable
        clearable
        :loading="bindBooksLoading"
        style="width: 100%"
      >
        <el-option
          v-for="b in bindBooks"
          :key="b.id"
          :label="`${b.title}（${bookTypeTag(b)}）`"
          :value="b.id"
        />
      </el-select>
      <div v-loading="bindStructureLoading" class="bind-tree">
        <el-tree
          v-if="bindTreeData.length"
          :data="bindTreeData"
          node-key="id"
          default-expand-all
          :expand-on-click-node="false"
        >
          <template #default="{ data }">
            <div class="bind-node">
              <span class="bn-name">{{ data.name }}</span>
              <span class="bn-cnt">{{ data.count }} 题</span>
              <span v-if="boundNodeIds.has(data.id)" class="bn-bound">✓ 已绑定</span>
              <el-button v-else link type="primary" size="small" @click.stop="doBindNode(data)">绑定</el-button>
            </div>
          </template>
        </el-tree>
        <el-empty
          v-else-if="bindBookId && !bindStructureLoading"
          description="这本书还没有章节"
          :image-size="60"
        />
        <p v-else class="bind-hint">先选择一本书，再从目录中挑「讲 / 节」绑定到本课。</p>
      </div>
      <template #footer>
        <el-button @click="bindBookVisible = false">完成</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.c213-plans {
  --sub: #5f716d;
  --faint: #8ba09a;
  --grey-soft: #eef1f0;
  --line-soft: #eef3f1;
  --amber: #b45309;
  --amber-soft: #fdf3e7;
  --warn: #ba3a2a;
  --warn-soft: #fbeeec;
  --grey: #7d8f8b;
  color: var(--bk-ink);
}

/* 工具栏 */
.vhead { display: flex; align-items: flex-end; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.vhead .spacer { flex: 1; }
.ph-h1 { font-size: 19px; font-weight: 800; margin: 0; }
.ph-sub { color: var(--sub); font-size: 13px; margin: 4px 0 0; }
.plus { font-weight: 700; margin-right: 2px; }

.filter-bar { display: flex; gap: 10px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }

/* 计划卡片墙 */
.plan-list-wrap { min-height: 60px; margin-bottom: 18px; }
.plan-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 14px; }
.plan-card {
  background: #fff; border: 1px solid var(--bk-line); border-radius: 12px;
  padding: 15px 18px 12px; cursor: pointer; transition: border-color .15s, box-shadow .15s;
}
.plan-card:hover { box-shadow: 0 4px 14px rgba(19,49,43,.08); }
.plan-card.sel { border-color: var(--bk-teal); box-shadow: 0 4px 14px rgba(15,118,110,.12); }
.pc-top { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.pc-name { font-size: 14px; flex: 1; min-width: 0; }
.tags { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
.tag {
  display: inline-flex; align-items: center; font-size: 11.5px; color: var(--sub);
  background: var(--grey-soft); border-radius: 6px; padding: 1px 8px; line-height: 19px;
}
.foot { font-size: 12px; color: var(--faint); display: flex; align-items: center; gap: 6px; }
.foot b { color: var(--bk-ink); font-weight: 700; }
.foot .spacer { flex: 1; }

/* 状态 pill */
.pill {
  display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600;
  border-radius: 99px; padding: 1px 9px; line-height: 18px; white-space: nowrap;
}
.pill::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.pill.flat::before { display: none; }
.pill.ok { color: var(--bk-teal-deep); background: var(--bk-teal-soft); }
.pill.mid { color: var(--amber); background: var(--amber-soft); }
.pill.todo { color: var(--warn); background: var(--warn-soft); }
.pill.mute { color: var(--grey); background: var(--grey-soft); }

/* 计划编辑区 */
.plan-editor { background: #fff; border: 1px solid var(--bk-line); border-radius: 12px; overflow: hidden; }
.pe-head {
  padding: 16px 20px; border-bottom: 1px solid var(--bk-line); display: flex; align-items: center;
  gap: 14px; flex-wrap: wrap; background: linear-gradient(120deg, var(--bk-teal-soft), #fff 60%);
}
.pe-head .who b { font-size: 16px; font-weight: 800; }
.pe-head .tags { margin-top: 6px; }
.pe-head .acts { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; }

.win-banner {
  margin: 14px 16px 0; padding: 10px 14px; border-radius: 10px; background: var(--amber-soft);
  border: 1px solid #f0dcc0; font-size: 12.5px; color: var(--amber); line-height: 1.6;
}
.win-banner b { font-weight: 700; }

/* 课次行 */
.lesson-list { padding: 14px 16px 18px; display: flex; flex-direction: column; gap: 10px; }
.lrow { border: 1px solid var(--bk-line); border-radius: 11px; overflow: hidden; background: #fff; }
.lrow.open { border-color: #cfe3df; box-shadow: 0 3px 10px rgba(15,118,110,.06); }
.lrow-bar { display: flex; align-items: center; gap: 12px; padding: 11px 14px; cursor: pointer; }
.lrow-bar:hover { background: var(--bk-teal-soft); }
.lseq {
  width: 34px; height: 34px; border-radius: 10px; background: var(--bk-teal-soft); color: var(--bk-teal-deep);
  display: grid; place-items: center; font-size: 15px; font-weight: 700; flex: none;
}
.lrow.dimmed .lseq { background: var(--grey-soft); color: var(--grey); }
.lrow-bar .lt { min-width: 0; flex: 1; }
.lrow-bar .lt b { font-size: 13.5px; display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.lrow-bar .lt > span { display: block; font-size: 11.5px; color: var(--faint); margin-top: 2px; }
.lesson-test { font-size: 10.5px; }
.bar-right { margin-left: auto; display: flex; align-items: center; gap: 8px; flex: none; }
.win-badge { font-size: 10.5px; }
.chev { color: var(--faint); font-size: 18px; transition: transform .2s; display: inline-block; }
.lrow.open .chev { transform: rotate(90deg); }
.lrow-body { border-top: 1px solid var(--line-soft); padding: 14px 16px 14px 60px; display: none; }
.lrow.open .lrow-body { display: block; }

/* 本课材料（PRD-003 P6 专项材料位）*/
.slots-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.slots-head .spacer { flex: 1; }
.slots-t { font-size: 11.5px; color: var(--faint); font-weight: 700; letter-spacing: .06em; }
.materials { display: flex; flex-direction: column; gap: 7px; margin-bottom: 10px; }
.mat-row { display: flex; gap: 9px; align-items: center; padding: 8px 10px; border: 1px solid var(--line-soft); border-radius: 9px; background: #fcfefe; }
.mat-ic { flex: none; }
.mat-main { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.mat-name { font-size: 13px; color: var(--bk-ink); }
.mat-meta { font-size: 11.5px; color: var(--faint); }
.mat-acts { flex: none; display: flex; align-items: center; gap: 2px; }
.slots-empty { font-size: 12.5px; color: var(--faint); margin: 0 0 10px; }
.mat-row.mat-book { cursor: pointer; transition: border-color .15s, background .15s; }
.mat-row.mat-book:hover { border-color: var(--bk-teal-deep, #0f766e); background: #f2faf8; }

/* 绑定书籍章节弹窗 */
.bind-tree {
  margin-top: 12px; min-height: 180px; max-height: 46vh; overflow: auto;
  border: 1px solid var(--line-soft); border-radius: 9px; padding: 8px;
}
.bind-hint { color: var(--faint); font-size: 13px; text-align: center; padding: 44px 0; margin: 0; }
.bind-node { flex: 1; display: flex; align-items: center; gap: 8px; min-width: 0; padding-right: 8px; }
.bind-node .bn-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bind-node .bn-cnt { flex: none; color: var(--faint); font-size: 12px; }
.bind-node .bn-bound { flex: none; color: var(--bk-teal-deep, #0f766e); font-size: 12px; font-weight: 600; }
.meta-line { font-size: 11.5px; color: var(--faint); margin-bottom: 10px; }

.kg-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.kg-t { font-size: 11.5px; color: var(--faint); font-weight: 700; letter-spacing: .06em; margin-right: 2px; }
.kg {
  display: inline-flex; align-items: center; font-size: 11.5px; font-weight: 600; color: var(--bk-teal-deep);
  background: var(--bk-teal-soft); border-radius: 6px; padding: 1px 8px; line-height: 20px; cursor: pointer;
  transition: background .15s;
}
.kg:hover { background: #d8ece8; }
.kg-empty { font-size: 11.5px; color: var(--faint); }
.parent-copy {
  font-size: 12px; color: var(--sub); background: #fbf7ef; border: 1px solid #f0e6d4; border-radius: 8px;
  padding: 6px 10px; margin-bottom: 10px;
}

.lrow-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; border-top: 1px dashed var(--bk-line); padding-top: 12px; }
.lrow-foot .spacer { flex: 1; }
</style>
