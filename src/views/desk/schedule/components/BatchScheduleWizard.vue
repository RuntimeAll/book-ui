<script setup lang="ts">
/**
 * PRD-C-213 FP9 批量排课向导（3 步 dialog）+ FP11 冲突检测交互。
 *
 * ① 选对象（target/page，归档不出现）+ 选计划（plan/page，可空=散课）+ 科目（PRD-015 D10/V6）
 * ② 节奏行（多条 周几+起止时段）+ 日期范围 + 排除日期
 * ③ 前端按节奏生成日期序列预览（autoBind 语义=按 lesson_seq 顺绑，预览显示第N次·课次标题），
 *    逐条可删可微调 → 提交前先 conflictCheck，有冲突弹警告列明细，
 *    允许「仍然保存」= force 重发 sessionBatch。
 *
 * 🔴 PRD-015 批1 排除日期 bug 四连修复（根因正本=prd/PRD-015/artifacts/排除日期bug根因.md）：
 *  S1 排除日期 picker 加 :default-value（锁开月=范围起始月）+ :disabled-date（范围外禁选）
 *     + 未选日期范围前禁用 —— 从源头堵死「错月录入 → excl.has 永不命中 → 静默失效」。
 *     实证：element-plus 2.14.0 panel-date-pick `watch(defaultValue,{immediate:true})→innerDate`
 *     对 type="dates" 同样生效（isMultipleType 早退只在 parsedValue 那个 watch 里，且注册在后）。
 *  S3 mode 切换用 v-if（非 v-show）+ 切模式清空 excludeDates，杜绝「指定日期」模式残留。
 *  S4 节奏行去重 + 预览/提交两处按「日期+起止」去重，防批内自撞重复落库。
 *  S5 回上一步再生成前，若第③步有手工增删改则先 confirm，防静默丢微调。
 *  校验提示：生成时统计「已排除 N 天 / 命中 M 场」+ 范围外、未命中的排除日期明确告警（不静默吞）。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  pageTargets,
  pagePlans,
  getPlan,
  conflictCheck,
  batchSchedule,
  TARGET_TYPE_LABEL,
} from '@/api/teacher/schedule'
import type {
  TargetType,
  TargetCardVO,
  PlanVO,
  PlanLessonVO,
  SessionBatchBo,
  SessionBatchItem,
  ConflictItem,
} from '@/api/teacher/schedule'
import { DICT_EDU_SUBJECT, useDictStore } from '@/store/dict'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'submitted'): void
}>()

const innerVisible = computed({
  get: () => props.visible,
  set: (v) => emit('update:visible', v),
})

const step = ref(0)

// ── 步骤一：对象 + 计划 ─────────────────────────────────────────
const targetType = ref<TargetType>('0')
const targetList = ref<TargetCardVO[]>([])
const targetLoading = ref(false)
const selectedTargetId = ref('')

const planList = ref<PlanVO[]>([])
const planLoading = ref(false)
const selectedPlanId = ref('') // '' = 散课

// ── PRD-015 V6：科目（一场课一科）───────────────────────────────
// 学科选项走共享字典（口径同 schedule/index.vue 单天快捷排课）。
const dict = useDictStore()
void dict.load(DICT_EDU_SUBJECT)
const SUBJECT_OPTIONS = computed(() => dict.list(DICT_EDU_SUBJECT))
const selectedSubject = ref('')
const selectedSubjectLabel = computed(() =>
  selectedSubject.value ? dict.label(DICT_EDU_SUBJECT, selectedSubject.value) : '',
)

/** 计划行可能带学科（BE 逐步补齐，契约未定稿前防御性读），无则回落对象主学科。 */
function resolveDefaultSubject(): string {
  const plan = planList.value.find((p) => p.id === selectedPlanId.value) as
    | (PlanVO & { subject?: string })
    | undefined
  if (plan?.subject) return plan.subject
  return targetList.value.find((t) => t.id === selectedTargetId.value)?.subject || ''
}

// 选完对象/计划自动带出默认科目（可改）
watch([selectedTargetId, selectedPlanId], () => {
  selectedSubject.value = resolveDefaultSubject()
})

async function fetchTargets() {
  targetLoading.value = true
  selectedTargetId.value = ''
  try {
    const res = await pageTargets({
      targetType: targetType.value,
      includeArchived: false,
      pageSize: 100,
    })
    targetList.value = res?.rows || []
  } catch (e) {
    console.warn('[wizard] pageTargets 失败', e)
    targetList.value = []
  } finally {
    targetLoading.value = false
  }
}

async function fetchPlans() {
  planLoading.value = true
  selectedPlanId.value = ''
  try {
    const res = await pagePlans({ targetType: targetType.value, pageSize: 100 })
    planList.value = (res?.rows || []).filter((p) => p.status !== '2') // 归档不选
  } catch (e) {
    console.warn('[wizard] pagePlans 失败', e)
    planList.value = []
  } finally {
    planLoading.value = false
  }
}

watch(targetType, () => {
  fetchTargets()
  fetchPlans()
})

// ── 步骤二：节奏 + 日期范围 + 排除 ──────────────────────────────
interface Rhythm {
  weekday: number // 0-6
  start: string
  end: string
}
const WEEKDAY_OPTS = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 0, label: '周日' },
]
const rhythms = ref<Rhythm[]>([{ weekday: 1, start: '18:00', end: '19:30' }])
const dateRange = ref<[string, string] | null>(null)
const excludeDates = ref<string[]>([])

// 排课方式：每周节奏（规则型）/ 指定日期（不规则排期直选具体日子，BUG修复：周节奏表达不了「同周几不同时段」）
const mode = ref<'rhythm' | 'dates'>('rhythm')
interface DateGroup {
  dates: string[] // 多选日期
  start: string
  end: string
}
const dateGroups = ref<DateGroup[]>([{ dates: [], start: '18:30', end: '20:30' }])

function addDateGroup() {
  dateGroups.value.push({ dates: [], start: '13:30', end: '15:30' })
}
function removeDateGroup(i: number) {
  dateGroups.value.splice(i, 1)
}

function addRhythm() {
  rhythms.value.push({ weekday: 1, start: '18:00', end: '19:30' })
}
function removeRhythm(i: number) {
  rhythms.value.splice(i, 1)
}

// S3：切排课方式清空排除日期（「指定日期」模式不吃排除，残留=静默失效来源）
watch(mode, () => {
  excludeDates.value = []
})

// ── S1：排除日期 picker 锁月 + 锁范围 ───────────────────────────
/** 面板开月锚点 = 日期范围起始日（element-plus 用它初始化 innerDate）。 */
const rangeStartDate = computed<Date | undefined>(() => {
  const s = dateRange.value?.[0]
  return s ? new Date(`${s}T00:00:00`) : undefined
})
/** 范围外日期禁选：从源头杜绝「排 8 月课却在 7 月面板上点日子」。 */
function isOutOfRange(d: Date): boolean {
  const r = dateRange.value
  if (!r || !r[0] || !r[1]) return true // 未选范围时整个面板不可点（picker 也已 disabled）
  const ds = fmtDate(d)
  return ds < r[0] || ds > r[1]
}

// ── 步骤三：预览 ────────────────────────────────────────────────
interface PreviewItem {
  key: string
  date: string
  start: string
  end: string
  seq: number
  title?: string
}
const preview = ref<PreviewItem[]>([])
const planLessons = ref<PlanLessonVO[]>([])

/** 生成期诊断（排除命中/失效、批内去重），第③步常驻展示，绝不静默吞。 */
interface GenDiag {
  exclHitDays: number
  exclHitSessions: number
  exclOutOfRange: string[]
  exclNoHit: string[]
  deduped: number
}
const diag = ref<GenDiag | null>(null)

function fmtDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function emptyDiag(): GenDiag {
  return { exclHitDays: 0, exclHitSessions: 0, exclOutOfRange: [], exclNoHit: [], deduped: 0 }
}

async function generatePreview() {
  preview.value = []
  const d = emptyDiag()
  if (mode.value === 'dates') {
    const groups = dateGroups.value.filter((g) => g.dates.length)
    if (!groups.length) {
      ElMessage.warning('请至少点选一个日期')
      return false
    }
    for (const g of groups) {
      if (!g.start || !g.end || g.end <= g.start) {
        ElMessage.warning('请给每组日期填好起止时间（结束需晚于开始）')
        return false
      }
    }
    await loadPlanLessons()
    return finishPreview(
      groups.flatMap((g) => g.dates.map((x) => ({ date: x, start: g.start, end: g.end }))),
      d,
    )
  }
  if (!dateRange.value || !dateRange.value[0] || !dateRange.value[1]) {
    ElMessage.warning('请先选择日期范围')
    return false
  }
  if (!rhythms.value.length) {
    ElMessage.warning('请至少添加一条节奏')
    return false
  }
  await loadPlanLessons()

  const [rangeFrom, rangeTo] = dateRange.value
  // S4：节奏行先按「周几+起止」去重（两条一模一样的节奏不该各生成一场）
  const seenRhythm = new Set<string>()
  const uniqRhythms = rhythms.value.filter((r) => {
    const k = `${r.weekday}|${r.start}|${r.end}`
    if (seenRhythm.has(k)) return false
    seenRhythm.add(k)
    return true
  })
  if (uniqRhythms.length < rhythms.value.length) {
    ElMessage.info(`已合并 ${rhythms.value.length - uniqRhythms.length} 条重复节奏`)
  }

  const excl = new Set(excludeDates.value)
  const exclHit = new Set<string>()
  const items: { date: string; start: string; end: string }[] = []
  const cur = new Date(`${rangeFrom}T00:00:00`)
  const end = new Date(`${rangeTo}T00:00:00`)
  while (cur.getTime() <= end.getTime()) {
    const ds = fmtDate(cur)
    const matched = uniqRhythms.filter((r) => r.weekday === cur.getDay())
    if (matched.length) {
      if (excl.has(ds)) {
        exclHit.add(ds)
        d.exclHitSessions += matched.length
      } else {
        for (const r of matched) items.push({ date: ds, start: r.start, end: r.end })
      }
    }
    cur.setDate(cur.getDate() + 1)
  }
  d.exclHitDays = exclHit.size
  // 排除日期的两类失效：范围外（永远不可能命中）/ 范围内但不在节奏上（选错日子）——都必须说出来
  for (const ds of excludeDates.value) {
    if (ds < rangeFrom || ds > rangeTo) d.exclOutOfRange.push(ds)
    else if (!exclHit.has(ds)) d.exclNoHit.push(ds)
  }
  if (d.exclOutOfRange.length) {
    ElMessage.warning(`排除日期不在所选日期范围内，未生效：${d.exclOutOfRange.join('、')}`)
  }
  if (d.exclNoHit.length) {
    ElMessage.warning(`该排除日期未命中任何场次：${d.exclNoHit.join('、')}`)
  }
  return finishPreview(items, d)
}

/** 拉计划课次（选了计划时用于 autoBind 预览标题）。 */
async function loadPlanLessons() {
  planLessons.value = []
  if (!selectedPlanId.value) return
  try {
    const plan = await getPlan(selectedPlanId.value)
    planLessons.value = (plan?.lessons || []).slice().sort((a, b) => a.lessonSeq - b.lessonSeq)
  } catch (e) {
    console.warn('[wizard] getPlan 失败', e)
  }
}

/** 生成收尾（两种模式共用）：S4 批内去重 → 排序 → 编号 → 课次标题顺绑。 */
function finishPreview(
  items: { date: string; start: string; end: string }[],
  d: GenDiag = emptyDiag(),
): boolean {
  // S4：同日同起止时段只保留一份（多组日期重叠 / 重复节奏行都会自撞）
  const seen = new Set<string>()
  const uniq = items.filter((it) => {
    const k = `${it.date}|${it.start}|${it.end}`
    if (seen.has(k)) {
      d.deduped += 1
      return false
    }
    seen.add(k)
    return true
  })
  uniq.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))
  preview.value = uniq.map((it, i) => ({
    key: `${it.date}-${it.start}-${i}`,
    date: it.date,
    start: it.start,
    end: it.end,
    seq: i + 1,
    title: selectedPlanId.value ? planLessons.value[i]?.title : undefined,
  }))
  if (d.deduped) ElMessage.info(`已自动去重 ${d.deduped} 场重复安排`)
  diag.value = d
  armPreviewDirty()
  return preview.value.length > 0
}

/** 重排序号 + 重绑标题（autoBind 顺绑随增删滚动）。 */
function renumberPreview() {
  preview.value.forEach((p, idx) => {
    p.seq = idx + 1
    p.title = selectedPlanId.value ? planLessons.value[idx]?.title : undefined
  })
}

/** 提交前兜底去重（第③步手工加行也可能撞）。返回被去掉的场次数。 */
function dedupePreview(): number {
  const seen = new Set<string>()
  const kept: PreviewItem[] = []
  let dropped = 0
  for (const p of preview.value) {
    const k = `${p.date}|${p.start}|${p.end}`
    if (p.date && seen.has(k)) {
      dropped += 1
      continue
    }
    if (p.date) seen.add(k)
    kept.push(p)
  }
  if (dropped) {
    preview.value = kept
    renumberPreview()
  }
  return dropped
}

// ── S5：第③步手工微调脏标记（重生成会整体覆盖，覆盖前必须先问）──
const previewDirty = ref(false)
let dirtyArmed = false
watch(
  preview,
  () => {
    if (dirtyArmed) previewDirty.value = true
  },
  { deep: true },
)
/** 每次重新生成后复位脏标记（下一 tick 再布防，跳过赋值本身触发的那次 watch）。 */
function armPreviewDirty() {
  dirtyArmed = false
  previewDirty.value = false
  void nextTick(() => {
    dirtyArmed = true
  })
}

/** 预览页手动补一场（生成后发现漏了某天，不用回上一步重生成）。 */
function addPreviewRow() {
  const last = preview.value[preview.value.length - 1]
  preview.value.push({
    key: `manual-${Date.now()}-${preview.value.length}`,
    date: '',
    start: last?.start || '18:30',
    end: last?.end || '20:30',
    seq: preview.value.length + 1,
    title: selectedPlanId.value ? planLessons.value[preview.value.length]?.title : undefined,
  })
}

function removePreview(i: number) {
  preview.value.splice(i, 1)
  renumberPreview()
}

// ── 步骤切换 ────────────────────────────────────────────────────
async function next() {
  if (step.value === 0) {
    if (!selectedTargetId.value) {
      ElMessage.warning('请选择排课对象')
      return
    }
    step.value = 1
  } else if (step.value === 1) {
    // S5：第③步动过手就先确认，别让重生成静默吃掉微调
    if (previewDirty.value && preview.value.length) {
      try {
        await ElMessageBox.confirm(
          '第 3 步的手工调整（增删/改日期时段）会被重新生成覆盖，确定重新生成吗？',
          '重新生成预览',
          { type: 'warning', confirmButtonText: '重新生成', cancelButtonText: '保留调整' },
        )
      } catch {
        step.value = 2 // 用户选保留 → 直接回第③步，不重生成
        return
      }
    }
    const ok = await generatePreview()
    if (ok) step.value = 2
    else if (preview.value.length === 0 && dateRange.value)
      ElMessage.warning('该节奏在所选范围内没有生成任何场次')
  }
}
function prev() {
  if (step.value > 0) step.value -= 1
}

// ── 提交 + 冲突 ─────────────────────────────────────────────────
const submitting = ref(false)
const conflictVisible = ref(false)
const conflicts = ref<ConflictItem[]>([])

function buildBo(force: boolean): SessionBatchBo {
  const items: SessionBatchItem[] = preview.value.map((p) => ({
    date: p.date,
    start: p.start,
    end: p.end,
    // PRD-015 V6：一场课一科；留空则由 BE 兜底（计划→对象主学科）
    subject: selectedSubject.value || undefined,
    sessionType: selectedPlanId.value ? undefined : '1',
  }))
  return {
    targetType: targetType.value,
    targetId: selectedTargetId.value,
    planId: selectedPlanId.value || undefined,
    autoBind: !!selectedPlanId.value,
    force,
    items,
  }
}

async function submit() {
  if (!preview.value.length) {
    ElMessage.warning('没有可提交的场次')
    return
  }
  const bad = preview.value.find((p) => !p.date || !p.start || !p.end || p.end <= p.start)
  if (bad) {
    ElMessage.warning(`第 ${bad.seq} 次的日期/时间未填好（结束需晚于开始）`)
    return
  }
  // S4：提交前兜底去重（手工加行也可能与生成结果自撞，BE detectConflicts 只比 DB 不比批内）
  const dropped = dedupePreview()
  if (dropped) ElMessage.info(`提交前已去重 ${dropped} 场重复安排`)
  submitting.value = true
  try {
    const bo = buildBo(false)
    const check = await conflictCheck(bo)
    if (check?.conflicts?.length) {
      conflicts.value = check.conflicts
      conflictVisible.value = true
      return
    }
    await doBatch(false)
  } catch (e) {
    console.warn('[wizard] conflictCheck 失败', e)
    ElMessage.error('冲突预检失败，请重试')
  } finally {
    submitting.value = false
  }
}

async function doBatch(force: boolean) {
  submitting.value = true
  try {
    const res = await batchSchedule(buildBo(force))
    if (!force && res?.conflicts?.length) {
      // 未强存且服务端仍报冲突：一条未落
      conflicts.value = res.conflicts
      conflictVisible.value = true
      return
    }
    ElMessage.success(`已排课 ${res?.created?.length ?? preview.value.length} 场`)
    conflictVisible.value = false
    emit('submitted')
    close()
  } catch (e) {
    console.warn('[wizard] batchSchedule 失败', e)
    ElMessage.error('排课失败，请重试')
  } finally {
    submitting.value = false
  }
}

function forceSave() {
  doBatch(true)
}

// ── 生命周期 ────────────────────────────────────────────────────
function reset() {
  step.value = 0
  targetType.value = '0'
  selectedTargetId.value = ''
  selectedPlanId.value = ''
  selectedSubject.value = ''
  rhythms.value = [{ weekday: 1, start: '18:00', end: '19:30' }]
  dateRange.value = null
  excludeDates.value = []
  mode.value = 'rhythm'
  dateGroups.value = [{ dates: [], start: '18:30', end: '20:30' }]
  preview.value = []
  diag.value = null
  armPreviewDirty()
  conflicts.value = []
  conflictVisible.value = false
}

function close() {
  innerVisible.value = false
}

watch(
  () => props.visible,
  (v) => {
    if (v) {
      reset()
      fetchTargets()
      fetchPlans()
    }
  },
)
</script>

<template>
  <el-dialog
    v-model="innerVisible"
    title="批量排课"
    width="640px"
    :append-to-body="true"
    :close-on-click-modal="false"
    top="7vh"
  >
    <el-steps :active="step" align-center finish-status="success" class="bw-steps">
      <el-step title="选对象与计划" />
      <el-step title="设默认节奏" />
      <el-step title="预览与确认" />
    </el-steps>

    <!-- 步骤一 -->
    <div v-show="step === 0" class="bw-panel">
      <div class="bw-field">
        <label class="bw-label">对象类型</label>
        <el-radio-group v-model="targetType">
          <el-radio-button value="0">{{ TARGET_TYPE_LABEL['0'] }}</el-radio-button>
          <el-radio-button value="1">{{ TARGET_TYPE_LABEL['1'] }}</el-radio-button>
        </el-radio-group>
      </div>
      <div class="bw-field">
        <label class="bw-label">排课对象<span class="bw-req">*</span></label>
        <el-select
          v-model="selectedTargetId"
          :loading="targetLoading"
          placeholder="选择学生 / 班级（归档对象不在列）"
          filterable
          style="width: 100%"
        >
          <el-option v-for="t in targetList" :key="t.id" :value="t.id" :label="t.name">
            <span>{{ t.name }}</span>
            <span class="bw-opt-sub">{{ t.grade }} {{ t.subject }}</span>
          </el-option>
        </el-select>
        <p v-if="!targetLoading && !targetList.length" class="bw-hint">
          暂无可排课对象（先到「我的学生」建档）
        </p>
      </div>
      <div class="bw-field">
        <label class="bw-label">课程计划（可空 = 散课）</label>
        <el-select
          v-model="selectedPlanId"
          :loading="planLoading"
          placeholder="不选 = 散课（不绑课次）"
          clearable
          filterable
          style="width: 100%"
        >
          <el-option v-for="p in planList" :key="p.id" :value="p.id" :label="p.name">
            <span>{{ p.name }}</span>
            <span class="bw-opt-sub">{{ p.lessonCount ?? p.lessons?.length ?? 0 }} 课次</span>
          </el-option>
        </el-select>
      </div>
      <!-- PRD-015 V6：科目（选完对象才出现，默认=计划学科 / 对象主学科，可改） -->
      <div v-if="selectedTargetId" class="bw-field">
        <label class="bw-label">科目</label>
        <el-select
          v-model="selectedSubject"
          placeholder="默认该计划 / 对象主学科"
          clearable
          style="width: 100%"
        >
          <el-option
            v-for="o in SUBJECT_OPTIONS"
            :key="o.dictValue"
            :value="o.dictValue"
            :label="o.dictLabel"
          />
        </el-select>
        <p class="bw-hint-soft">本批场次统一记这个科目；留空由系统按计划 / 对象主学科兜底。</p>
      </div>
    </div>

    <!-- 步骤二 -->
    <div v-show="step === 1" class="bw-panel">
      <div class="bw-field">
        <label class="bw-label">排课方式</label>
        <el-radio-group v-model="mode">
          <el-radio-button value="rhythm">每周节奏</el-radio-button>
          <el-radio-button value="dates">指定日期</el-radio-button>
        </el-radio-group>
        <p class="bw-mode-tip">
          {{ mode === 'rhythm' ? '规则排期：每周固定周几上课，按日期范围批量生成' : '不规则排期：直接点选具体日子，同组日期共用一个时段，可加多组' }}
        </p>
      </div>
      <div v-if="mode === 'dates'" class="bw-field">
        <label class="bw-label">日期组（点选日子 + 起止时段，可多组）<span class="bw-req">*</span></label>
        <div v-for="(g, i) in dateGroups" :key="i" class="bw-dgroup">
          <el-date-picker
            v-model="g.dates"
            type="dates"
            value-format="YYYY-MM-DD"
            placeholder="点选这组时段要上课的日子（可多选）"
            style="flex: 1; min-width: 0"
          />
          <el-time-picker
            v-model="g.start"
            value-format="HH:mm"
            format="HH:mm"
            placeholder="开始"
            style="width: 108px"
          />
          <span class="bw-dash">–</span>
          <el-time-picker
            v-model="g.end"
            value-format="HH:mm"
            format="HH:mm"
            placeholder="结束"
            style="width: 108px"
          />
          <el-button v-if="dateGroups.length > 1" link type="danger" @click="removeDateGroup(i)">
            删除
          </el-button>
        </div>
        <el-button link type="primary" @click="addDateGroup">+ 加一组（不同时段）</el-button>
      </div>
      <div v-if="mode === 'rhythm'" class="bw-field">
        <label class="bw-label">默认节奏（周几 + 起止时段，可多条）</label>
        <div v-for="(r, i) in rhythms" :key="i" class="bw-rhythm">
          <el-select v-model="r.weekday" style="width: 100px">
            <el-option
              v-for="w in WEEKDAY_OPTS"
              :key="w.value"
              :value="w.value"
              :label="w.label"
            />
          </el-select>
          <el-time-picker
            v-model="r.start"
            value-format="HH:mm"
            format="HH:mm"
            placeholder="开始"
            style="width: 118px"
          />
          <span class="bw-dash">–</span>
          <el-time-picker
            v-model="r.end"
            value-format="HH:mm"
            format="HH:mm"
            placeholder="结束"
            style="width: 118px"
          />
          <el-button
            v-if="rhythms.length > 1"
            link
            type="danger"
            @click="removeRhythm(i)"
          >
            删除
          </el-button>
        </div>
        <el-button link type="primary" @click="addRhythm">+ 加一条节奏</el-button>
      </div>
      <div v-if="mode === 'rhythm'" class="bw-field">
        <label class="bw-label">日期范围<span class="bw-req">*</span></label>
        <el-date-picker
          v-model="dateRange"
          type="daterange"
          value-format="YYYY-MM-DD"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          style="width: 100%"
        />
      </div>
      <!-- S1：面板锁到日期范围起始月 + 范围外禁选；未选范围前不可点（错月录入是静默失效的根） -->
      <div v-if="mode === 'rhythm'" class="bw-field">
        <label class="bw-label">排除日期（节假日等，可空）</label>
        <el-date-picker
          :key="dateRange?.[0] || 'no-range'"
          v-model="excludeDates"
          type="dates"
          value-format="YYYY-MM-DD"
          :default-value="rangeStartDate"
          :disabled-date="isOutOfRange"
          :disabled="!rangeStartDate"
          :placeholder="rangeStartDate ? '点选要排除的日期（只能选范围内）' : '请先选择上面的日期范围'"
          style="width: 100%"
        />
        <p v-if="excludeDates.length" class="bw-hint-soft">
          已选 {{ excludeDates.length }} 个排除日期：{{ excludeDates.join('、') }}
        </p>
      </div>
    </div>

    <!-- 步骤三 -->
    <div v-show="step === 2" class="bw-panel">
      <p class="bw-preview-sum">
        共生成 <b>{{ preview.length }}</b> 场
        <span v-if="selectedPlanId">· 按课次顺序自动绑定</span>
        <span v-else>· 散课（不绑课次）</span>
        <span v-if="selectedSubjectLabel">· {{ selectedSubjectLabel }}</span>
      </p>
      <!-- 排除/去重账单：命中多少、哪些没生效，全摊开说，不静默 -->
      <div v-if="diag" class="bw-diag">
        <p v-if="diag.exclHitDays" class="bw-diag-ok">
          已排除 {{ diag.exclHitDays }} 天，命中 {{ diag.exclHitSessions }} 场
        </p>
        <p v-if="diag.deduped" class="bw-diag-ok">已自动去重 {{ diag.deduped }} 场重复安排</p>
        <p v-if="diag.exclOutOfRange.length" class="bw-diag-warn">
          ⚠ 排除日期不在所选日期范围内，未生效：{{ diag.exclOutOfRange.join('、') }}
        </p>
        <p v-if="diag.exclNoHit.length" class="bw-diag-warn">
          ⚠ 该排除日期未命中任何场次（范围内但不在排课节奏上）：{{ diag.exclNoHit.join('、') }}
        </p>
      </div>
      <div v-if="preview.length" class="bw-preview-list">
        <div v-for="(p, i) in preview" :key="p.key" class="bw-prow">
          <span class="bw-seq">第 {{ p.seq }} 次</span>
          <el-date-picker
            v-model="p.date"
            type="date"
            value-format="YYYY-MM-DD"
            size="small"
            style="width: 130px"
          />
          <el-time-picker
            v-model="p.start"
            value-format="HH:mm"
            format="HH:mm"
            size="small"
            style="width: 92px"
          />
          <span class="bw-dash">–</span>
          <el-time-picker
            v-model="p.end"
            value-format="HH:mm"
            format="HH:mm"
            size="small"
            style="width: 92px"
          />
          <span class="bw-ptitle">{{ p.title || (selectedPlanId ? '（无对应课次）' : '散课') }}</span>
          <el-button link type="danger" size="small" @click="removePreview(i)">删除</el-button>
        </div>
        <el-button link type="primary" class="bw-addrow" @click="addPreviewRow">+ 添加一场</el-button>
      </div>
      <el-empty v-else description="没有可预览的场次" />
    </div>

    <template #footer>
      <div class="bw-footer">
        <el-button v-if="step > 0" @click="prev">上一步</el-button>
        <span class="bw-footer-sp" />
        <el-button @click="close">取消</el-button>
        <el-button v-if="step < 2" type="primary" @click="next">下一步</el-button>
        <el-button
          v-else
          type="primary"
          :loading="submitting"
          :disabled="!preview.length"
          @click="submit"
        >
          提交排课
        </el-button>
      </div>
    </template>
  </el-dialog>

  <!-- FP11 冲突警告 -->
  <el-dialog
    v-model="conflictVisible"
    title="检测到排课冲突"
    width="520px"
    :append-to-body="true"
    class="bw-conflict-dialog"
  >
    <p class="bw-conflict-tip">以下场次与已有安排冲突，可返回调整时间，或仍然保存：</p>
    <div class="bw-conflict-list">
      <div v-for="(c, i) in conflicts" :key="i" class="bw-crow">
        <span class="bw-ckind" :class="c.kind === '老师撞场' ? 'k-t' : 'k-s'">{{ c.kind }}</span>
        <span class="bw-cdate">{{ c.date }} {{ c.start }}–{{ c.end }}</span>
        <span class="bw-cwith">撞：{{ c.withTitle || c.withSessionId }}</span>
      </div>
    </div>
    <template #footer>
      <el-button @click="conflictVisible = false">返回调整</el-button>
      <el-button type="warning" :loading="submitting" @click="forceSave">仍然保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.bw-steps {
  margin-bottom: 20px;
}
.bw-mode-tip {
  font-size: 12px;
  color: #8ba09a;
  margin: 6px 0 0;
}
.bw-dgroup {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.bw-addrow {
  margin-top: 6px;
}
.bw-panel {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-height: 220px;
}
.bw-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bw-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--bk-ink);
}
.bw-req {
  color: var(--el-color-danger);
  margin-left: 2px;
}
.bw-opt-sub {
  float: right;
  color: #8ba09a;
  font-size: 12px;
}
.bw-hint {
  font-size: 12px;
  color: #b45309;
  margin: 0;
}
.bw-hint-soft {
  font-size: 12px;
  color: #8ba09a;
  margin: 0;
  line-height: 1.5;
}
.bw-diag {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: -6px 0 12px;
}
.bw-diag-ok {
  font-size: 12.5px;
  color: var(--bk-teal-deep);
  margin: 0;
}
.bw-diag-warn {
  font-size: 12.5px;
  color: #b45309;
  background: #fdf6ec;
  border-radius: 6px;
  padding: 5px 8px;
  margin: 0;
  line-height: 1.5;
}
.bw-rhythm {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bw-dash {
  color: #8ba09a;
  flex: none;
}
.bw-preview-sum {
  font-size: 13px;
  color: #5f716d;
  margin: 0 0 12px;
}
.bw-preview-sum b {
  color: var(--bk-teal-deep);
  font-size: 15px;
}
.bw-preview-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 320px;
  overflow-y: auto;
}
.bw-prow {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--bk-line);
  border-radius: 8px;
}
.bw-seq {
  font-size: 12px;
  font-weight: 700;
  color: var(--bk-teal-deep);
  flex: none;
  width: 52px;
}
.bw-ptitle {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: #5f716d;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bw-footer {
  display: flex;
  align-items: center;
}
.bw-footer-sp {
  flex: 1;
}
.bw-conflict-tip {
  font-size: 13px;
  color: #5f716d;
  margin: 0 0 12px;
}
.bw-conflict-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 300px;
  overflow-y: auto;
}
.bw-crow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: #fbeeec;
  border-radius: 8px;
  font-size: 12.5px;
}
.bw-ckind {
  flex: none;
  font-weight: 700;
  border-radius: 99px;
  padding: 1px 8px;
  font-size: 11px;
}
.bw-ckind.k-t {
  color: #ba3a2a;
  background: #fff;
}
.bw-ckind.k-s {
  color: #b45309;
  background: #fff;
}
.bw-cdate {
  font-variant-numeric: tabular-nums;
  color: var(--bk-ink);
  font-weight: 600;
  flex: none;
}
.bw-cwith {
  color: #5f716d;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
