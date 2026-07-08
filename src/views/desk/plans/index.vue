<script setup lang="ts">
/**
 * PRD-C-213 课程计划页（/desk/plans）—— FP16~19 + FP21 + FP22。
 *
 * FP16 计划列表：卡片墙（名/term·year/对象类型/素材/课次数/状态 pill + 流转 + 复制 + 新建·编辑）。
 * FP17 课次行：选中计划展开课次表，行编辑/新增/删除/上下移（reorder）。大纲态课次合法不逼填。
 * FP18 课内锚点：课次编辑内 kg_node_ids 多选（复用题库 lazyTree 树），选中 chip 展示 + 点跳题库。
 * PRD-B-101 V1：课次行 = 专项卷位清单（名/style/rules/绑定态；组这张卷[占位]/挂已有卷/查看下载/重组/增删卷位）
 *   + 推导备课态三色 pill + 标记已备好开关。段模型退役，卷位替代。
 * FP21 细备窗口徽标：课次绑定场次落在未来 14 天内（getPrepTodo(14)）显「窗口内」，窗口外不催。
 * FP22 家长版导出入口：工具栏按钮 → 选对象 → parentExport → 弹窗展示图片 + 下载。
 *
 * 🔴 id 全 string；枚举走 *_LABEL 映射；BE 未起时优雅空态（拦截器弹错，页面兜 null）。
 */
import { ref, computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  pagePlans,
  getPlan,
  copyPlan,
  updatePlan,
  deleteLesson,
  reorderLessons,
  upsertLessons,
  bindPaperSlot,
  unbindPaperSlot,
  markLessonReady,
  getPrepTodo,
  PLAN_STATUS_LABEL,
  TARGET_TYPE_LABEL,
  LESSON_TYPE_LABEL,
  type PlanVO,
  type PlanLessonVO,
  type PlanLessonBo,
  type PlanStatus,
  type PlanPageParams,
  type PaperSlot,
} from '@/api/teacher/schedule'
import { getTarget } from '@/api/teacher/schedule'
import { lazyTree, getPaperDetail, type SubjectNode } from '@/api/question/index'
import { usePrepContextStore } from '@/store/prepContext'
import PlanFormDialog from './components/PlanFormDialog.vue'
import LessonEditDialog from './components/LessonEditDialog.vue'
import ParentExportDialog from './components/ParentExportDialog.vue'
import PaperPickerDialog from './components/PaperPickerDialog.vue'

const router = useRouter()
const route = useRoute()
const prepCtx = usePrepContextStore()

// 计划归属对象名缓存（PlanVO 无 targetName，横幅「学生」项 best-effort 取档案名）
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

// 备课态三色 + 文案（PRD-B-101 换权威 = paper_slots 推导：0未备/1备课中/2已备好）
const PREP_LABEL: Record<string, string> = { '0': '未备', '1': '备课中', '2': '已备好' }
function prepPillClass(s: string): string {
  return s === '2' ? 'ok' : s === '1' ? 'mid' : 'todo'
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
    // 选中项若已不在列表则清空
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
// 竞态守卫：快速切计划时旧详情不覆盖新详情
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
    if (token !== detailToken) return // 已切到别的计划，丢弃旧响应
    planDetail.value = res
    // 默认展开在窗口内的课次
    const open = new Set<string>()
    ;(res?.lessons ?? []).forEach((l) => {
      if (windowLessonIds.value.has(l.id)) open.add(l.id)
    })
    expandedLessons.value = open
    void resolvePaperNames(res?.lessons ?? [])
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
// getPrepTodo(14) = 今天起 14 天内待备场次，含 planLessonId；据此标「窗口内」，窗口外无徽标不催。
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

// ── KG 树（FP18，一次加载，供锚点多选 + chip 标题解析）──────────────────────
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

// 点 KG chip 跳题库（question/index 现不消费 query，带 subjectId 备用，裸跳亦可看）
function jumpToQuestions(kgId: string) {
  router.push({ name: 'QuestionIndex', query: { subjectId: kgId } })
}

// ── 计划状态流转（FP16）────────────────────────────────────────────────────
// 草稿(0) → 启用(1) → 归档(2)；归档可恢复为启用。
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

// ── 计划弹窗（FP16 新建 / 编辑）──────────────────────────────────────────────
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

// ── 课次弹窗（FP17 新增 / 编辑）──────────────────────────────────────────────
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

// ── PRD-B-101 卷位清单（V1）────────────────────────────────────────────────
// 卷位只存 paper_id，卷名靠 getPaperDetail 懒解析入缓存。
const paperNameCache = ref<Map<string, string>>(new Map())
function paperName(id?: string | null): string {
  if (!id) return ''
  return paperNameCache.value.get(String(id)) || '已绑卷'
}
async function resolvePaperNames(lessonsArr: PlanLessonVO[]) {
  const ids = new Set<string>()
  for (const l of lessonsArr) {
    for (const s of l.paperSlots ?? []) {
      if (s.paper_id && !paperNameCache.value.has(String(s.paper_id))) ids.add(String(s.paper_id))
    }
  }
  if (!ids.size) return
  await Promise.allSettled(
    [...ids].map(async (id) => {
      try {
        const d = await getPaperDetail(id)
        paperNameCache.value.set(id, d?.paperName || '已绑卷')
      } catch {
        paperNameCache.value.set(id, '已绑卷')
      }
    }),
  )
  // 触发响应式更新（Map 原地 set 不触发模板重算）
  paperNameCache.value = new Map(paperNameCache.value)
}

// 本地备课态推导（镜像 BE PaperSlotService.deriveStatus，用于就地更新免整页重载）
function deriveState(slots: PaperSlot[]): string {
  if (!slots.length) return '0'
  let anyManual = false
  let allBound = true
  let anyBound = false
  for (const s of slots) {
    if (s.manual_ready) anyManual = true
    const bound = !!s.paper_id && String(s.paper_id).trim() !== ''
    if (bound) anyBound = true
    else allBound = false
  }
  if (anyManual) return '2'
  if (allBound) return '2'
  return anyBound ? '1' : '0'
}
function manuallyReady(lesson: PlanLessonVO): boolean {
  return (lesson.paperSlots ?? []).some((s) => s.manual_ready)
}

// 找到 planDetail 里的真实课次对象（就地改）
function liveLesson(lessonId: string): PlanLessonVO | undefined {
  return planDetail.value?.lessons?.find((l) => l.id === lessonId)
}

// 写课次卷位配方（走课次更新端点）；写后课次即拥有自有卷位（覆盖继承）。
async function saveLessonSlots(lesson: PlanLessonVO, slots: PaperSlot[]): Promise<boolean> {
  if (!selectedPlanId.value) return false
  const bo: PlanLessonBo = {
    id: lesson.id,
    title: lesson.title,
    lessonSeq: lesson.lessonSeq,
    lessonType: lesson.lessonType,
    tag: lesson.tag,
    sourceRef: lesson.sourceRef,
    thinkingAction: lesson.thinkingAction,
    layerTarget: lesson.layerTarget,
    parentCopy: lesson.parentCopy,
    kgNodeIds: lesson.kgNodeIds,
    paperSlots: slots,
  }
  try {
    await upsertLessons(selectedPlanId.value, [bo])
    const live = liveLesson(lesson.id)
    if (live) {
      live.paperSlots = slots
      live.paperSlotsInherited = false
      live.prepState = deriveState(slots) as PlanLessonVO['prepState']
    }
    return true
  } catch {
    return false
  }
}

// 卷位操作前确保课次有自有卷位（继承态先物化，否则绑定端点定位不到卷位）
async function ensureOwnSlots(lesson: PlanLessonVO): Promise<boolean> {
  if (!lesson.paperSlotsInherited) return true
  return saveLessonSlots(lesson, (lesson.paperSlots ?? []).map((s) => ({ ...s })))
}

function applySlotResult(lessonId: string, paperSlots: PaperSlot[], prepState: string) {
  const live = liveLesson(lessonId)
  if (!live) return
  live.paperSlots = paperSlots
  live.paperSlotsInherited = false
  live.prepState = prepState as PlanLessonVO['prepState']
  void resolvePaperNames([live])
}

// 行尾·加卷位（弹名 → 追加 → 写库）
async function addSlot(lesson: PlanLessonVO) {
  let name = ''
  try {
    const r = await ElMessageBox.prompt('给这个卷位起个名（如 概念辨析 / 巩固提高 / 课内同步）', '添加卷位', {
      confirmButtonText: '添加',
      cancelButtonText: '取消',
      inputPlaceholder: '卷位名',
      inputValidator: (v: string) => (v && v.trim() ? true : '卷位名不能为空'),
    })
    name = (r.value || '').trim()
  } catch {
    return
  }
  const slots = (lesson.paperSlots ?? []).map((s) => ({ ...s }))
  const seq = slots.reduce((m, s) => Math.max(m, Number(s.slot_seq) || 0), 0) + 1
  slots.push({ slot_seq: seq, name, style: '', rules: '', note: '', paper_id: null, manual_ready: false })
  const ok = await saveLessonSlots(lesson, slots)
  if (ok) ElMessage.success('卷位已添加')
}

// 行尾·删卷位（绑着卷=解绑留库不删）
async function removeSlot(lesson: PlanLessonVO, slot: PaperSlot) {
  const bound = !!slot.paper_id
  try {
    await ElMessageBox.confirm(
      bound ? `删除卷位「${slot.name}」？绑定的卷会解绑但保留在卷库，不删除。` : `删除卷位「${slot.name}」？`,
      '删除卷位',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  if (!(await ensureOwnSlots(lesson))) return
  const slots = (lesson.paperSlots ?? []).filter((s) => s.slot_seq !== slot.slot_seq).map((s) => ({ ...s }))
  const ok = await saveLessonSlots(lesson, slots)
  if (ok) ElMessage.success('卷位已删除')
}

// 未绑·「组这张卷」→ 开备课语境（含该卷位配方 + 课次/学生信息）→ 跳题库挑题（PRD-B-101 V2/D6）
async function composeForSlot(lesson: PlanLessonVO, slot: PaperSlot) {
  // 继承态卷位先物化，否则创建时绑定端点定位不到卷位
  if (!(await ensureOwnSlots(lesson))) return
  const tId = planDetail.value?.targetId ? String(planDetail.value.targetId) : ''
  const studentName = await resolveTargetName(tId)
  prepCtx.open({
    planId: selectedPlanId.value ?? '',
    targetId: tId,
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    studentName,
    lessonDate: '',
    // 物化后 lesson.paperSlots 已是自有卷位快照
    slots: (lesson.paperSlots ?? []).map((s) => ({ ...s })),
    slotSeq: slot.slot_seq,
  })
  router.push({ name: 'QuestionIndex' })
}

// 未绑·「挂已有卷」（D7 兜底）
const pickerVisible = ref(false)
const pickerSlotLabel = ref('')
const pickerCtx = ref<{ lessonId: string; slotSeq: number } | null>(null)
async function openPicker(lesson: PlanLessonVO, slot: PaperSlot) {
  if (!(await ensureOwnSlots(lesson))) return
  pickerCtx.value = { lessonId: lesson.id, slotSeq: slot.slot_seq }
  pickerSlotLabel.value = `${lesson.title} · ${slot.name}`
  pickerVisible.value = true
}
async function onPaperPicked(paperId: string) {
  const ctx = pickerCtx.value
  if (!ctx) return
  try {
    const res = await bindPaperSlot(ctx.lessonId, ctx.slotSeq, paperId)
    applySlotResult(ctx.lessonId, res.paperSlots, res.prepState)
    ElMessage.success('已挂到卷位')
    pickerVisible.value = false
  } catch {
    /* 拦截器已弹错 */
  }
}

// 已绑·查看 / 下载（跳卷详情页，预览与导出在那）
function viewPaper(paperId?: string | null) {
  if (paperId) router.push(`/papers/source/${paperId}`)
}

// 已绑·重组（解绑）
async function unbindSlot(lesson: PlanLessonVO, slot: PaperSlot) {
  try {
    await ElMessageBox.confirm(`重组卷位「${slot.name}」？当前卷解绑（保留在卷库），可重新组或挂新卷。`, '重组', {
      type: 'warning',
      confirmButtonText: '解绑',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    const res = await unbindPaperSlot(lesson.id, slot.slot_seq)
    applySlotResult(lesson.id, res.paperSlots, res.prepState)
    ElMessage.success('已解绑')
  } catch {
    /* 拦截器已弹错 */
  }
}

// 标记已备好开关（manual_ready 覆盖；0 卷位禁用）
async function toggleReady(lesson: PlanLessonVO, ready: boolean) {
  try {
    const res = await markLessonReady(lesson.id, ready)
    applySlotResult(lesson.id, res.paperSlots, res.prepState)
    ElMessage.success(ready ? '已标记备好' : '已取消标记')
  } catch {
    /* 拦截器已弹错（0 卷位返 400） */
  }
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
function slotKClass(i: number): string {
  return i === 0 ? 'w' : i === 1 ? 'm' : 's'
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
  // 无 planId 时按 targetId 找归属计划（best-effort：取该对象第一份计划）
  if (!planToOpen && targetId) {
    const p = plans.value.find((pl) => String(pl.targetId ?? '') === targetId)
    if (p) planToOpen = p.id
  }
  if (!planToOpen) return
  await selectPlan(planToOpen)
  if (lessonId) {
    const next = new Set(expandedLessons.value)
    next.add(lessonId)
    expandedLessons.value = next
    // 滚动到该课次
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

    <!-- 计划编辑区（FP17-19 + FP21 + FP22）-->
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
            :class="{ open: expandedLessons.has(lesson.id), dimmed: lesson.prepState === '0' }"
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
                <span class="pill" :class="prepPillClass(lesson.prepState)">
                  {{ PREP_LABEL[lesson.prepState] }}
                </span>
                <span class="chev">›</span>
              </div>
            </div>

            <div class="lrow-body">
              <!-- 卷位清单（PRD-B-101 V1）-->
              <div class="slots-head">
                <span class="slots-t">专项卷位</span>
                <span v-if="lesson.paperSlotsInherited && (lesson.paperSlots?.length ?? 0)" class="slots-inherit">继承计划模板</span>
                <span class="spacer"></span>
                <label class="ready-sw" :title="(lesson.paperSlots?.length ?? 0) ? '' : '先规划卷位才能标记'">
                  <el-switch
                    :model-value="manuallyReady(lesson)"
                    :disabled="(lesson.paperSlots?.length ?? 0) === 0"
                    size="small"
                    @update:model-value="(v: string | number | boolean) => toggleReady(lesson, !!v)"
                  />
                  <span>标记已备好</span>
                </label>
              </div>

              <div v-if="lesson.paperSlots?.length" class="slots">
                <div v-for="(slot, si) in lesson.paperSlots" :key="slot.slot_seq" class="slot-row">
                  <span class="slot-k" :class="slotKClass(si)">{{ slot.slot_seq }}</span>
                  <div class="slot-main">
                    <div class="slot-l1">
                      <b class="slot-name">{{ slot.name || `卷位${slot.slot_seq}` }}</b>
                      <span v-if="slot.style" class="slot-style">{{ slot.style }}</span>
                    </div>
                    <div v-if="slot.rules" class="slot-rules">{{ slot.rules }}</div>
                    <div class="slot-bind">
                      <template v-if="slot.paper_id">
                        <span class="slot-paper" title="查看 / 下载" @click="viewPaper(slot.paper_id)">
                          📄 {{ paperName(slot.paper_id) }}
                        </span>
                      </template>
                      <span v-else class="slot-empty-tag">空位 · 待组卷</span>
                    </div>
                  </div>
                  <div class="slot-acts">
                    <template v-if="slot.paper_id">
                      <el-button link size="small" @click="viewPaper(slot.paper_id)">查看 / 下载</el-button>
                      <el-button link size="small" type="warning" @click="unbindSlot(lesson, slot)">重组</el-button>
                    </template>
                    <template v-else>
                      <el-button link size="small" type="primary" @click="composeForSlot(lesson, slot)">组这张卷</el-button>
                      <el-button link size="small" @click="openPicker(lesson, slot)">挂已有卷</el-button>
                    </template>
                    <el-button link size="small" type="danger" title="删除卷位" @click="removeSlot(lesson, slot)">✕</el-button>
                  </div>
                </div>
              </div>
              <p v-else class="slots-empty">还没有卷位。点「+ 卷位」规划专项卷，或直接组卷挂上来。</p>

              <div class="slots-foot">
                <el-button size="small" @click="addSlot(lesson)">+ 卷位</el-button>
              </div>

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
      :default-paper-slots="planDetail.defaultPaperSlots"
      :kg-tree="kgTree"
      :kg-loading="kgLoading"
      @saved="onLessonSaved"
    />
    <ParentExportDialog v-model="parentExportVisible" :plan="planDetail" />
    <PaperPickerDialog v-model="pickerVisible" :slot-label="pickerSlotLabel" @picked="onPaperPicked" />
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

/* 卷位清单（PRD-B-101 V1）*/
.slots-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.slots-head .spacer { flex: 1; }
.slots-t { font-size: 11.5px; color: var(--faint); font-weight: 700; letter-spacing: .06em; }
.slots-inherit { font-size: 10.5px; font-weight: 600; color: var(--amber); background: var(--amber-soft); border-radius: 5px; padding: 1px 7px; }
.ready-sw { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--sub); cursor: pointer; }
.slots { display: flex; flex-direction: column; gap: 7px; margin-bottom: 8px; }
.slot-row { display: flex; gap: 9px; align-items: flex-start; padding: 8px 10px; border: 1px solid var(--line-soft); border-radius: 9px; background: #fcfefe; }
.slot-k {
  flex: none; width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center;
  font-size: 11.5px; font-weight: 700;
}
.slot-k.w { color: var(--bk-teal-deep); background: var(--bk-teal-soft); }
.slot-k.m { color: #fff; background: var(--bk-teal); }
.slot-k.s { color: var(--sub); background: var(--grey-soft); }
.slot-main { flex: 1; min-width: 0; }
.slot-l1 { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.slot-name { font-size: 13px; color: var(--bk-ink); }
.slot-style { font-size: 11.5px; color: var(--faint); }
.slot-rules { font-size: 11px; color: var(--faint); margin-top: 2px; }
.slot-bind { margin-top: 4px; }
.slot-paper {
  display: inline-flex; align-items: center; font-size: 12px; font-weight: 600; color: var(--bk-teal-deep);
  background: var(--bk-teal-soft); border-radius: 6px; padding: 1px 9px; cursor: pointer; max-width: 100%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.slot-paper:hover { background: #d8ece8; }
.slot-empty-tag { font-size: 11.5px; color: var(--warn); background: var(--warn-soft); border-radius: 6px; padding: 1px 9px; }
.slot-acts { flex: none; display: flex; align-items: center; gap: 2px; flex-wrap: wrap; justify-content: flex-end; }
.slots-empty { font-size: 12.5px; color: var(--faint); margin: 0 0 8px; }
.slots-foot { margin-bottom: 12px; }
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
