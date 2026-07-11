<script setup lang="ts">
/**
 * PRD-C-213 FP9 批量排课向导（3 步 dialog）+ FP11 冲突检测交互。
 *
 * ① 选对象（target/page，归档不出现）+ 选计划（plan/page，可空=散课）
 * ② 节奏行（多条 周几+起止时段）+ 日期范围 + 排除日期
 * ③ 前端按节奏生成日期序列预览（autoBind 语义=按 lesson_seq 顺绑，预览显示第N次·课次标题），
 *    逐条可删可微调 → 提交前先 conflictCheck，有冲突弹警告列明细，
 *    允许「仍然保存」= force 重发 sessionBatch。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
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

function fmtDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

async function generatePreview() {
  preview.value = []
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
    return finishPreview(
      groups.flatMap((g) => g.dates.map((d) => ({ date: d, start: g.start, end: g.end }))),
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
  // 拉计划课次（如选了计划，用于 autoBind 预览标题）
  planLessons.value = []
  if (selectedPlanId.value) {
    try {
      const plan = await getPlan(selectedPlanId.value)
      planLessons.value = (plan?.lessons || []).slice().sort((a, b) => a.lessonSeq - b.lessonSeq)
    } catch (e) {
      console.warn('[wizard] getPlan 失败', e)
    }
  }

  const start = new Date(dateRange.value[0] + 'T00:00:00')
  const end = new Date(dateRange.value[1] + 'T00:00:00')
  const excl = new Set(excludeDates.value)
  const items: { date: string; start: string; end: string }[] = []
  const cur = new Date(start)
  while (cur.getTime() <= end.getTime()) {
    const ds = fmtDate(cur)
    if (!excl.has(ds)) {
      const wd = cur.getDay()
      for (const r of rhythms.value) {
        if (r.weekday === wd) items.push({ date: ds, start: r.start, end: r.end })
      }
    }
    cur.setDate(cur.getDate() + 1)
  }
  return finishPreview(items)
}

/** 生成收尾（两种模式共用）：排序 + 编号 + 课次标题顺绑。 */
function finishPreview(items: { date: string; start: string; end: string }[]): boolean {
  items.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))
  preview.value = items.map((it, i) => ({
    key: `${it.date}-${it.start}-${i}`,
    date: it.date,
    start: it.start,
    end: it.end,
    seq: i + 1,
    title: selectedPlanId.value ? planLessons.value[i]?.title : undefined,
  }))
  return preview.value.length > 0
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
  // 重排序号 + 重绑标题（autoBind 顺绑随删除滚动）
  preview.value.forEach((p, idx) => {
    p.seq = idx + 1
    p.title = selectedPlanId.value ? planLessons.value[idx]?.title : undefined
  })
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
  rhythms.value = [{ weekday: 1, start: '18:00', end: '19:30' }]
  dateRange.value = null
  excludeDates.value = []
  mode.value = 'rhythm'
  dateGroups.value = [{ dates: [], start: '18:30', end: '20:30' }]
  preview.value = []
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
      <div v-show="mode === 'dates'" class="bw-field">
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
      <div v-show="mode === 'rhythm'" class="bw-field">
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
      <div v-show="mode === 'rhythm'" class="bw-field">
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
      <div v-show="mode === 'rhythm'" class="bw-field">
        <label class="bw-label">排除日期（节假日等，可空）</label>
        <el-date-picker
          v-model="excludeDates"
          type="dates"
          value-format="YYYY-MM-DD"
          placeholder="点选要排除的日期"
          style="width: 100%"
        />
      </div>
    </div>

    <!-- 步骤三 -->
    <div v-show="step === 2" class="bw-panel">
      <p class="bw-preview-sum">
        共生成 <b>{{ preview.length }}</b> 场
        <span v-if="selectedPlanId">· 按课次顺序自动绑定</span>
        <span v-else>· 散课（不绑课次）</span>
      </p>
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
