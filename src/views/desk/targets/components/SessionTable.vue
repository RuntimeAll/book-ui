<script setup lang="ts">
/**
 * PRD-C-213 FP14 · 场次表 + 行操作。
 * 场次列：# / 日期 / 时间 / 绑定课次 / 状态 pill / 备课态 pill / 操作。
 * 行操作：改期(sessionUpdate date/start/end) · 请假(sessionLeave) · 取消(sessionCancel) ·
 *         标记已上(sessionMarkDone) · 锁定/解锁内容(sessionLock/Unlock) · 改绑课次(sessionUpdate planLessonId)。
 * 请假/取消返回 {deferred,overflow} → message 提示顺延明细。
 */
import { ref, computed, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  LESSON_TYPE_LABEL,
  sessionLeave,
  sessionCancel,
  sessionMarkDone,
  sessionLock,
  sessionUnlock,
  updateSession,
  getReview,
  type SessionVO,
  type PlanLessonVO,
  type DeferResult,
} from '@/api/teacher/schedule'
import ReviewDialog from './ReviewDialog.vue'
import {
  shortDate,
  weekdayCn,
  relativeDay,
  timeRange,
  sessionStatusPill,
  prepStatusPill,
} from '../helpers'

const props = defineProps<{
  sessions: SessionVO[]
  planLessons: PlanLessonVO[]
  loading?: boolean
}>()

const emit = defineEmits<{
  (e: 'refresh'): void
  (e: 'open-prep', sessionId: string): void
}>()

// —— 课次标题映射 ——
const lessonMap = computed(() => {
  const m = new Map<string, PlanLessonVO>()
  for (const l of props.planLessons) m.set(l.id, l)
  return m
})

function lessonLabel(s: SessionVO): string {
  if (s.sessionType === '3') return s.externalTitle || '外部占位'
  if (s.planLessonId) {
    const l = lessonMap.value.get(s.planLessonId)
    if (l) return `第${l.lessonSeq}次 · ${l.title}`
  }
  return s.externalTitle || '未绑定课次'
}

/** 课次类型中文（改绑下拉用） */
function lessonTypeStr(l: PlanLessonVO): string {
  return LESSON_TYPE_LABEL[l.lessonType] || '教学'
}

const todayStr = (() => {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
})()

// —— 行操作 busy 锁（防双触发） ——
const busyId = ref<string>('')

// —— 回收态（已回收场次集合） ——
// 打开时探测：对「已上·非外部」场次批量 getReview，命中即标记（BE 无记录须返 code:1+null）。
// 另在提交成功 / 弹窗探测到既有记录时增量补入。
const reviewedIds = ref<Set<string>>(new Set())

function isReviewed(s: SessionVO): boolean {
  return reviewedIds.value.has(s.id)
}

let probeSeq = 0
async function probeReviews() {
  const my = ++probeSeq
  const targets = props.sessions.filter((s) => s.sessionStatus === '1' && s.sessionType !== '3')
  if (!targets.length) return
  const results = await Promise.allSettled(targets.map((s) => getReview(s.id)))
  if (my !== probeSeq) return
  const next = new Set(reviewedIds.value)
  results.forEach((r, i) => {
    if (
      r.status === 'fulfilled' &&
      r.value &&
      (r.value.version || (r.value.itemResults && r.value.itemResults.length))
    ) {
      next.add(targets[i].id)
    }
  })
  reviewedIds.value = next
}

watch(() => props.sessions, probeReviews, { immediate: true })

// —— 回收弹窗 ——
const reviewVisible = ref(false)
const reviewTarget = ref<SessionVO | null>(null)

function openReview(s: SessionVO) {
  reviewTarget.value = s
  reviewVisible.value = true
}

function onReviewSaved(id: string) {
  reviewedIds.value = new Set(reviewedIds.value).add(id)
  emit('refresh')
}

function onReviewDetected(id: string) {
  if (!reviewedIds.value.has(id)) {
    reviewedIds.value = new Set(reviewedIds.value).add(id)
  }
}

function showDefer(res: DeferResult, verb: string) {
  const parts: string[] = [`已${verb}`]
  if (res.deferred?.length) parts.push(`后续 ${res.deferred.length} 次课已顺延`)
  if (res.overflow?.length) parts.push(`⚠ 需补排：${res.overflow.join('；')}`)
  ElMessage({
    type: res.overflow?.length ? 'warning' : 'success',
    message: parts.join('，'),
    duration: res.overflow?.length ? 6000 : 3000,
  })
}

async function onLeave(s: SessionVO) {
  await ElMessageBox.confirm(`确认将该场次（${shortDate(s.sessionDate)}）标记为请假？后续课次将自动顺延。`, '请假', {
    type: 'warning',
  }).catch(() => Promise.reject('cancel'))
  busyId.value = s.id
  try {
    const res = await sessionLeave(s.id)
    showDefer(res, '请假')
    emit('refresh')
  } finally {
    busyId.value = ''
  }
}

async function onCancel(s: SessionVO) {
  await ElMessageBox.confirm(`确认取消该场次（${shortDate(s.sessionDate)}）？后续课次将自动顺延。`, '取消场次', {
    type: 'warning',
  }).catch(() => Promise.reject('cancel'))
  busyId.value = s.id
  try {
    const res = await sessionCancel(s.id)
    showDefer(res, '取消')
    emit('refresh')
  } finally {
    busyId.value = ''
  }
}

async function onMarkDone(s: SessionVO) {
  busyId.value = s.id
  try {
    await sessionMarkDone(s.id)
    ElMessage.success('已标记为已上')
    emit('refresh')
  } finally {
    busyId.value = ''
  }
}

async function onToggleLock(s: SessionVO) {
  busyId.value = s.id
  try {
    if (s.lessonLocked === '1') {
      await sessionUnlock(s.id)
      ElMessage.success('已解锁内容')
    } else {
      await sessionLock(s.id)
      ElMessage.success('已锁定内容（顺延时保持原课次）')
    }
    emit('refresh')
  } finally {
    busyId.value = ''
  }
}

function onCommand(cmd: string, s: SessionVO) {
  if (cmd === 'reschedule') openReschedule(s)
  else if (cmd === 'rebind') openRebind(s)
  else if (cmd === 'leave') onLeave(s).catch(() => {})
  else if (cmd === 'cancel') onCancel(s).catch(() => {})
  else if (cmd === 'markdone') onMarkDone(s)
  else if (cmd === 'lock') onToggleLock(s)
}

// —— 改期弹窗 ——
const rsVisible = ref(false)
const rsSaving = ref(false)
const rsTarget = ref<SessionVO | null>(null)
const rsForm = ref<{ date: string; start: string; end: string }>({ date: '', start: '', end: '' })

function openReschedule(s: SessionVO) {
  rsTarget.value = s
  rsForm.value = {
    date: s.sessionDate,
    start: s.startTime?.slice(0, 5) || '',
    end: s.endTime?.slice(0, 5) || '',
  }
  rsVisible.value = true
}

async function saveReschedule() {
  if (!rsTarget.value) return
  if (!rsForm.value.date || !rsForm.value.start || !rsForm.value.end) {
    ElMessage.warning('日期、开始与结束时间均需填写')
    return
  }
  rsSaving.value = true
  try {
    await updateSession(rsTarget.value.id, {
      date: rsForm.value.date,
      start: rsForm.value.start,
      end: rsForm.value.end,
    })
    ElMessage.success('已改期')
    rsVisible.value = false
    emit('refresh')
  } finally {
    rsSaving.value = false
  }
}

// —— 改绑课次弹窗 ——
const rbVisible = ref(false)
const rbSaving = ref(false)
const rbTarget = ref<SessionVO | null>(null)
const rbLessonId = ref<string>('')

function openRebind(s: SessionVO) {
  if (!props.planLessons.length) {
    ElMessage.info('该对象未绑定课程计划，无课次可改绑')
    return
  }
  rbTarget.value = s
  rbLessonId.value = s.planLessonId || ''
  rbVisible.value = true
}

async function saveRebind() {
  if (!rbTarget.value || !rbLessonId.value) {
    ElMessage.warning('请选择要改绑的课次')
    return
  }
  rbSaving.value = true
  try {
    await updateSession(rbTarget.value.id, { planLessonId: rbLessonId.value })
    ElMessage.success('已改绑课次（仅本场）')
    rbVisible.value = false
    emit('refresh')
  } finally {
    rbSaving.value = false
  }
}
</script>

<template>
  <div class="sess-wrap" v-loading="loading">
    <table class="sess">
      <thead>
        <tr>
          <th>#</th>
          <th>日期</th>
          <th>时间</th>
          <th>绑定课次</th>
          <th>状态</th>
          <th>备课</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(s, i) in sessions"
          :key="s.id"
          :class="{ 'row-today': s.sessionDate === todayStr }"
        >
          <td class="seq">{{ i + 1 }}</td>
          <td class="date">
            <b>{{ shortDate(s.sessionDate) }}</b>
            <span>{{ relativeDay(s.sessionDate) || weekdayCn(s.sessionDate) }}</span>
          </td>
          <td class="time">{{ timeRange(s.startTime, s.endTime) }}</td>
          <td class="lesson">
            <span class="lesson-txt">
              <span v-if="s.sessionType === '2'" class="ltype-flag">🧪</span>
              <span v-else-if="s.sessionType === '3'" class="ltype-flag">📌</span>
              {{ lessonLabel(s) }}
            </span>
            <el-tag v-if="s.lessonLocked === '1'" size="small" type="info" class="lock-tag">锁定</el-tag>
          </td>
          <td>
            <span class="pill" :class="'pill-' + sessionStatusPill(s.sessionStatus).tone">
              {{ sessionStatusPill(s.sessionStatus).label }}
            </span>
          </td>
          <td>
            <span
              v-if="s.sessionType !== '3'"
              class="pill flat"
              :class="'pill-' + prepStatusPill(s.prepStatus).tone"
            >
              {{ prepStatusPill(s.prepStatus).label }}
            </span>
            <span v-else class="pill flat pill-mute">—</span>
          </td>
          <td class="ops">
            <el-button
              v-if="s.sessionType !== '3'"
              size="small"
              type="primary"
              text
              bg
              @click="emit('open-prep', s.id)"
              >备课包</el-button
            >
            <el-button
              v-if="s.sessionType !== '3' && s.sessionStatus === '1'"
              size="small"
              :type="isReviewed(s) ? 'success' : 'warning'"
              text
              bg
              @click="openReview(s)"
              >{{ isReviewed(s) ? '已回收' : '回收' }}</el-button
            >
            <el-dropdown
              trigger="click"
              :disabled="busyId === s.id"
              @command="(c: string) => onCommand(c, s)"
            >
              <el-button size="small" text bg :loading="busyId === s.id">操作</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="reschedule">改期</el-dropdown-item>
                  <el-dropdown-item command="rebind">改绑课次</el-dropdown-item>
                  <el-dropdown-item command="markdone" v-if="s.sessionStatus !== '1'">
                    标记已上
                  </el-dropdown-item>
                  <el-dropdown-item command="lock">
                    {{ s.lessonLocked === '1' ? '解锁内容' : '锁定内容' }}
                  </el-dropdown-item>
                  <el-dropdown-item command="leave" divided>请假</el-dropdown-item>
                  <el-dropdown-item command="cancel">取消场次</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </td>
        </tr>
        <tr v-if="!sessions.length && !loading">
          <td colspan="7" class="empty-row">暂无场次 · 去「排课总览」为该对象排课</td>
        </tr>
      </tbody>
    </table>
    <p class="sess-foot">请假 / 改期后，后续课次内容自动顺延（锁定的场次保持原课次）</p>

    <!-- 改期弹窗 -->
    <el-dialog v-model="rsVisible" title="改期" width="380px" append-to-body>
      <div class="rs-form">
        <div class="rs-row">
          <label>日期</label>
          <el-date-picker
            v-model="rsForm.date"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="选择日期"
            style="width: 100%"
          />
        </div>
        <div class="rs-row">
          <label>开始</label>
          <el-time-picker
            v-model="rsForm.start"
            format="HH:mm"
            value-format="HH:mm"
            placeholder="开始时间"
            style="width: 100%"
          />
        </div>
        <div class="rs-row">
          <label>结束</label>
          <el-time-picker
            v-model="rsForm.end"
            format="HH:mm"
            value-format="HH:mm"
            placeholder="结束时间"
            style="width: 100%"
          />
        </div>
        <p class="rs-hint">改期只改时间，不改场次状态、不触发顺延。</p>
      </div>
      <template #footer>
        <el-button @click="rsVisible = false">取消</el-button>
        <el-button type="primary" :loading="rsSaving" @click="saveReschedule">保存</el-button>
      </template>
    </el-dialog>

    <!-- 改绑课次弹窗 -->
    <el-dialog v-model="rbVisible" title="改绑课次" width="420px" append-to-body>
      <p class="rb-hint">仅改本场绑定的课次，不影响其他场次。</p>
      <el-select v-model="rbLessonId" placeholder="选择课次" style="width: 100%" filterable>
        <el-option
          v-for="l in planLessons"
          :key="l.id"
          :value="l.id"
          :label="`第${l.lessonSeq}次 · ${l.title}（${lessonTypeStr(l)}）`"
        />
      </el-select>
      <template #footer>
        <el-button @click="rbVisible = false">取消</el-button>
        <el-button type="primary" :loading="rbSaving" @click="saveRebind">保存</el-button>
      </template>
    </el-dialog>

    <!-- 课后回收弹窗（B4） -->
    <ReviewDialog
      v-model:visible="reviewVisible"
      :session="reviewTarget"
      @saved="onReviewSaved"
      @reviewed-detected="onReviewDetected"
    />
  </div>
</template>

<style scoped>
.sess-wrap {
  padding: 6px 4px 8px;
  overflow-x: auto;
}
table.sess {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.8px;
  min-width: 640px;
}
table.sess th {
  text-align: left;
  font-size: 11.5px;
  color: #8ba09a;
  font-weight: 700;
  letter-spacing: 0.06em;
  padding: 10px 12px 8px;
  border-bottom: 1px solid var(--bk-line);
  white-space: nowrap;
}
table.sess td {
  padding: 9px 12px;
  border-bottom: 1px solid #eef3f1;
  vertical-align: middle;
  white-space: nowrap;
}
table.sess tr:hover td {
  background: #f0f7f5;
}
tr.row-today td {
  background: #f0f7f5;
}
.seq {
  font-family: Georgia, 'Times New Roman', serif;
  color: #8ba09a;
  font-size: 13px;
}
.date b {
  font-variant-numeric: tabular-nums;
  color: var(--bk-ink);
}
.date span {
  color: #8ba09a;
  font-size: 11.5px;
  margin-left: 6px;
}
.time {
  font-variant-numeric: tabular-nums;
  color: #5f716d;
}
.lesson {
  max-width: 260px;
}
.lesson-txt {
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--bk-teal-deep);
  font-weight: 600;
  font-size: 12.5px;
}
.ltype-flag {
  margin-right: 2px;
}
.lock-tag {
  margin-left: 6px;
}
.ops {
  display: flex;
  gap: 6px;
  align-items: center;
}
.empty-row {
  text-align: center;
  color: #8ba09a;
  padding: 28px 12px;
  font-size: 12.5px;
}
.sess-foot {
  padding: 10px 12px 0;
  font-size: 12px;
  color: #8ba09a;
}
/* pill */
.pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  font-weight: 600;
  border-radius: 99px;
  padding: 1px 9px;
  line-height: 18px;
  white-space: nowrap;
}
.pill::before {
  content: '';
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.pill.flat::before {
  display: none;
}
.pill-ok {
  color: var(--bk-teal-deep);
  background: var(--bk-teal-soft);
}
.pill-mid {
  color: #b45309;
  background: #fdf3e7;
}
.pill-todo {
  color: #ba3a2a;
  background: #fbeeec;
}
.pill-mute {
  color: #7d8f8b;
  background: #eef1f0;
}
.rs-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.rs-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.rs-row label {
  width: 40px;
  flex: none;
  font-size: 13px;
  color: #5f716d;
}
.rs-hint,
.rb-hint {
  font-size: 12px;
  color: #8ba09a;
  margin: 4px 0 0;
}
.rb-hint {
  margin: 0 0 12px;
}
</style>
