<script setup lang="ts">
/**
 * PRD-C-213 详情面板（点卡片进入）：
 * - 头部：对象基本维 + 绑定计划(FP13) + 归档/取消归档。
 * - 肖像(FP20) · 场次表(FP14) · 迷你月历(FP15)。
 * 载入用「请求代次」防串：切对象快速点击时旧响应不覆盖新数据（api 冻结件不能传 signal，
 * 故用自增 seq 守卫替代 AbortController 达到同等防竞态效果）。
 */
import { ref, computed, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  getTarget,
  pageSessions,
  getPlan,
  archiveTarget,
  unarchiveTarget,
  updateTargetProfile,
  type TargetCardVO,
  type TargetDetailVO,
  type SessionVO,
  type PlanLessonVO,
  type PlanVO,
  type ProfileJson,
} from '@/api/teacher/schedule'
import { avatarChar, maskPhone, progressPct, FALLBACK_COLOR } from '../helpers'
import PortraitPanel from './PortraitPanel.vue'
import SessionTable from './SessionTable.vue'
import MiniCalendar from './MiniCalendar.vue'
import AccountPanel from './AccountPanel.vue'

const props = defineProps<{
  card: TargetCardVO
}>()

const emit = defineEmits<{
  (e: 'refresh-cards'): void
  (e: 'edit', id: string): void
  (e: 'open-prep', sessionId: string): void
  (e: 'close'): void
}>()

const detail = ref<TargetDetailVO | null>(null)
const sessions = ref<SessionVO[]>([])
const planLessons = ref<PlanLessonVO[]>([])
const plan = ref<PlanVO | null>(null)
const loading = ref(false)
const sessLoading = ref(false)
const profileSaving = ref(false)
const portraitRef = ref<InstanceType<typeof PortraitPanel> | null>(null)

let seq = 0

const color = computed(() => detail.value?.color || props.card.color || FALLBACK_COLOR)
const isClass = computed(() => props.card.targetType === '1')
const archived = computed(() => detail.value?.archived === '1' || props.card.archived === '1')
const kindLabel = computed(() => (isClass.value ? '班级' : '学生'))

const headSub = computed(() => {
  const d = detail.value
  if (!d) return ''
  // R1a：grade/textbook=BE 推导串；学科显示中文标签（subject 现为字典码）
  const parts = [d.grade, d.textbook, d.subjectLabel || d.subject].filter(Boolean)
  let s = parts.join(' · ')
  if (!isClass.value && d.parentPhone) s += `${s ? ' · ' : ''}家长 ${maskPhone(d.parentPhone)}`
  return s || '—'
})

const progText = computed(() => {
  const c = props.card
  if (c.progressTotal) return `${c.progressDone ?? 0} / ${c.progressTotal}`
  return `${c.doneCount ?? 0} / ${c.scheduledCount ?? 0}`
})
const progPct = computed(() => {
  const c = props.card
  if (c.progressTotal) return progressPct(c.progressDone, c.progressTotal)
  return progressPct(c.doneCount, c.scheduledCount)
})

const sessionDates = computed(() => sessions.value.map((s) => s.sessionDate).filter(Boolean))

async function loadDetail() {
  const my = ++seq
  loading.value = true
  try {
    const d = await getTarget(props.card.id)
    if (my !== seq) return
    detail.value = d
  } catch {
    if (my === seq) detail.value = null
  } finally {
    if (my === seq) loading.value = false
  }
}

async function loadSessions() {
  const my = seq
  sessLoading.value = true
  try {
    const res = await pageSessions({ targetId: props.card.id, pageSize: 200 })
    if (my !== seq) return
    sessions.value = res.rows || []
  } catch {
    if (my === seq) sessions.value = []
  } finally {
    if (my === seq) sessLoading.value = false
  }
}

async function loadPlan() {
  const my = seq
  const pid = props.card.planId
  if (!pid) {
    planLessons.value = []
    plan.value = null
    return
  }
  try {
    const pv = await getPlan(pid)
    if (my !== seq) return
    plan.value = pv
    planLessons.value = pv.lessons || []
  } catch {
    if (my === seq) {
      plan.value = null
      planLessons.value = []
    }
  }
}

async function loadAll() {
  await loadDetail()
  // detail 已推进 seq；session/plan 复用同一代次守卫
  await Promise.all([loadSessions(), loadPlan()])
}

watch(() => props.card.id, loadAll, { immediate: true })

// —— 场次变更后：刷新场次 + 通知外层刷新卡片聚合 ——
function onSessionsChanged() {
  loadSessions()
  emit('refresh-cards')
}

// —— 肖像保存 ——
async function onProfileSave(profile: ProfileJson) {
  profileSaving.value = true
  try {
    await updateTargetProfile(props.card.id, profile)
    ElMessage.success('肖像已保存')
    portraitRef.value?.close()
    await loadDetail()
  } finally {
    profileSaving.value = false
  }
}

// —— 归档 / 取消归档 ——
const archiving = ref(false)

/** 今天 YYYY-MM-DD（本地，ISO 日期串可直接字典序比较） */
function todayStr(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
/** 该对象未来未上场次数（本地过滤已加载场次：status='0' 且日期>=今天）——BUG-015 归档联动明细 */
const futureUnstartedCount = computed(() => {
  const t = todayStr()
  return sessions.value.filter((s) => s.sessionStatus === '0' && (s.sessionDate || '') >= t).length
})

async function toggleArchive() {
  // 取消归档：无联动，不恢复场次（要复课走重新排课）
  if (archived.value) {
    archiving.value = true
    try {
      await unarchiveTarget(props.card.id)
      ElMessage.success('已取消归档')
      await loadDetail()
      emit('refresh-cards')
    } finally {
      archiving.value = false
    }
    return
  }
  // BUG-015 归档：弹窗列明未来未上场次数（N），确认后一并取消
  const n = futureUnstartedCount.value
  const msg =
    n > 0
      ? `该${kindLabel.value}还有 ${n} 场未上课程，归档将一并取消这些场次（已上/请假/历史记录不动）。确认归档？`
      : '归档后该对象不再进入排课选择器（数据保留，可随时取消归档）。确认归档？'
  await ElMessageBox.confirm(msg, '归档', { type: 'warning' }).catch(() => Promise.reject('cancel'))
  archiving.value = true
  try {
    const res = await archiveTarget(props.card.id)
    const cancelled = res?.cancelled ?? 0
    ElMessage.success(cancelled > 0 ? `已归档，已取消 ${cancelled} 场未来课程` : '已归档')
    await loadDetail()
    await loadSessions()
    emit('refresh-cards')
  } finally {
    archiving.value = false
  }
}

</script>

<template>
  <div class="stu-detail" v-loading="loading">
    <!-- 头部 -->
    <div class="stu-dhead" :style="{ background: `linear-gradient(120deg, ${color}14, #fff 60%)` }">
      <span class="stu-ava" :style="{ background: color, borderRadius: isClass ? '12px' : '14px' }">{{
        avatarChar(detail?.name || card.name)
      }}</span>
      <div class="who">
        <b
          >{{ detail?.name || card.name }}
          <span v-if="isClass" class="mini-badge">班课</span>
          <span v-if="archived" class="mini-badge grey">已归档</span></b
        >
        <span>{{ headSub }}</span>
      </div>

      <div class="dhead-acts">
        <el-button size="small" text bg @click="emit('edit', card.id)">编辑</el-button>
        <el-button size="small" text bg :loading="archiving" @click="toggleArchive">{{
          archived ? '取消归档' : '归档'
        }}</el-button>
        <el-button size="small" text bg @click="emit('close')">收起</el-button>
      </div>

      <!-- FP13 绑定计划与进度 -->
      <div class="plan-bind">
        <div class="pb-info">
          <div class="pb-t">
            绑定计划<template v-if="plan"> · {{ plan.year }} {{ plan.termTag }}</template>
          </div>
          <div class="pb-n">{{ card.planName || '未绑定计划' }}</div>
        </div>
        <div class="pb-prog" v-if="card.planName">
          <div class="prog"><i :style="{ width: progPct + '%', background: color }" /></div>
          <span class="pb-c">{{ progText }}</span>
        </div>
      </div>
    </div>

    <!-- PRD-015 课时账户（学生专有；班级无账户，班课收费模型未拍） -->
    <AccountPanel
      v-if="!isClass"
      :student-id="card.id"
      :student-name="detail?.name || card.name"
      @changed="emit('refresh-cards')"
    />

    <!-- FP20 肖像 -->
    <PortraitPanel
      ref="portraitRef"
      :profile="detail?.profileJson || null"
      :kind-label="kindLabel"
      :saving="profileSaving"
      @save="onProfileSave"
    />

    <!-- FP14 场次表 + FP15 迷你月历 -->
    <div class="stu-dbody">
      <SessionTable
        :sessions="sessions"
        :plan-lessons="planLessons"
        :loading="sessLoading"
        :target-name="detail?.name || card.name"
        :subject-label="detail?.subjectLabel || detail?.subject || ''"
        @refresh="onSessionsChanged"
        @open-prep="(id) => emit('open-prep', id)"
      />
      <aside class="mini-side">
        <MiniCalendar :dates="sessionDates" :color="color" />
      </aside>
    </div>
  </div>
</template>

<style scoped>
.stu-detail {
  background: #fff;
  border: 1px solid var(--bk-line);
  border-radius: 12px;
  overflow: hidden;
}
.stu-dhead {
  padding: 16px 20px;
  border-bottom: 1px solid var(--bk-line);
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.stu-ava {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  color: #fff;
  font-weight: 800;
  font-size: 17px;
  flex: none;
}
.who {
  min-width: 0;
}
.who b {
  font-size: 17px;
  font-weight: 800;
  color: var(--bk-ink);
  display: flex;
  align-items: center;
  gap: 6px;
}
.who span {
  display: block;
  font-size: 12.5px;
  color: #5f716d;
}
.mini-badge {
  font-size: 10.5px;
  font-weight: 600;
  color: #7d8f8b;
  background: #eef1f0;
  border-radius: 99px;
  padding: 0 7px;
  line-height: 17px;
}
.mini-badge.grey {
  color: #b45309;
  background: #fdf3e7;
}
.dhead-acts {
  display: flex;
  gap: 6px;
  margin-left: auto;
}
.plan-bind {
  display: flex;
  align-items: center;
  gap: 14px;
  background: #fff;
  border: 1px solid var(--bk-line);
  border-radius: 10px;
  padding: 8px 14px;
  flex-wrap: wrap;
  flex-basis: 100%;
}
.pb-t {
  font-size: 12px;
  color: #8ba09a;
}
.pb-n {
  font-size: 13px;
  font-weight: 700;
  color: var(--bk-ink);
}
.pb-prog {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
}
.pb-prog .prog {
  width: 130px;
  margin: 0;
}
.prog {
  height: 6px;
  border-radius: 3px;
  background: #eef3f1;
  overflow: hidden;
}
.prog i {
  display: block;
  height: 100%;
  border-radius: 3px;
}
.pb-c {
  font-size: 12px;
  color: var(--bk-teal-deep);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.stu-dbody {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 268px;
  gap: 0;
}
@media (max-width: 1050px) {
  .stu-dbody {
    grid-template-columns: 1fr;
  }
}
.mini-side {
  border-left: 1px solid var(--bk-line);
  padding: 16px 18px;
}
@media (max-width: 1050px) {
  .mini-side {
    border-left: none;
    border-top: 1px solid var(--bk-line);
  }
}
</style>
