<script setup lang="ts">
/**
 * PRD-C-213 FP14 · 场次表 + 行操作。
 * 场次列：# / 日期 / 时间 / 绑定课次 / 状态 pill / 备课态 pill / 操作。
 * 行操作：改期(sessionUpdate date/start/end) · 请假(sessionLeave) · 取消(sessionCancel) ·
 *         标记已上(sessionMarkDone) · 锁定/解锁内容(sessionLock/Unlock) · 改绑课次(sessionUpdate planLessonId)。
 * 请假/取消返回 {deferred,overflow} → message 提示顺延明细。
 *
 * 🔴 PRD-015 D9/AC11：回收线（逐题判对错→肖像）已下线——本表不再有「回收/已回收」按钮，
 *    也不再引用 ReviewDialog；组件文件与既有回收数据保留（物理清理另立小卡）。
 */
import { ref, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  LESSON_TYPE_LABEL,
  sessionLeave,
  sessionCancel,
  sessionMarkDone,
  sessionLock,
  sessionUnlock,
  updateSession,
  type SessionVO,
  type PlanLessonVO,
  type DeferResult,
} from '@/api/teacher/schedule'
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

// BUG-012：「未绑定课次」降噪——只有「有 planId 却没绑 planLessonId」才是异常态（醒目警示色），
// 单纯没绑计划（该对象根本没建计划）是正常态，降为灰色次要文案。
function lessonToneClass(s: SessionVO): string {
  if (s.sessionType === '3' || s.planLessonId) return ''
  if (s.planId) return 'warn'
  return 'muted'
}

/** 课次类型中文（改绑下拉用） */
function lessonTypeStr(l: PlanLessonVO): string {
  return LESSON_TYPE_LABEL[l.lessonType] || '教学'
}

const todayStr = (() => {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
})()

// BUG-012：场次表改升序（后端仍倒序返回，前端本地排）；下一场（今天及以后最近一场未取消/未请假
// 的排定场次）高亮 + 标记，实现从简（不物理置顶，仅样式区分）。
const sortedSessions = computed(() =>
  [...props.sessions].sort((a, b) => {
    const ka = `${a.sessionDate}${(a.startTime || '').slice(0, 5)}`
    const kb = `${b.sessionDate}${(b.startTime || '').slice(0, 5)}`
    return ka.localeCompare(kb)
  }),
)
const nextSessionId = computed(
  () => sortedSessions.value.find((s) => s.sessionDate >= todayStr && s.sessionStatus === '0')?.id || '',
)

// BUG-003 口径贯通：sessionStatus 非'0'（已排）时行操作（改期/请假/取消/锁定）禁用
function isVoided(s: SessionVO): boolean {
  return s.sessionStatus !== undefined && s.sessionStatus !== '0'
}

/**
 * PRD-015：结算态徽标。'1' 已结（课时已扣）/ '2' 已冲正（课时已退回）；'0'/空不出徽标。
 * 🔴 家长不看本表（老师工作台内部页），文案仍取"人话"不用内部词。
 */
function settleBadge(s: SessionVO): { label: string; tone: string } | null {
  if (s.settleStatus === '1') return { label: '已结', tone: 'done' }
  if (s.settleStatus === '2') return { label: '已退回', tone: 'back' }
  return null
}

// —— 行操作 busy 锁（防双触发） ——
const busyId = ref<string>('')

// 🔴 PRD-015 D9/AC11 回收线下线：原「已回收探测（批量 getReview）+ 回收弹窗」整段移除。
//    场次表只留 备课/改期/改绑/标记已上/锁定/请假/取消 这一条教务主线；
//    回收数据与 GET review 接口保留可读（下线≠坏档），ReviewDialog.vue 文件保留不删。

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
          v-for="(s, i) in sortedSessions"
          :key="s.id"
          :class="{ 'row-today': s.sessionDate === todayStr, 'row-next': s.id === nextSessionId }"
        >
          <td class="seq">{{ i + 1 }}</td>
          <td class="date">
            <b>{{ shortDate(s.sessionDate) }}</b>
            <span>{{ relativeDay(s.sessionDate) || weekdayCn(s.sessionDate) }}</span>
            <span v-if="s.id === nextSessionId" class="next-badge">下一场</span>
          </td>
          <td class="time">{{ timeRange(s.startTime, s.endTime) }}</td>
          <td class="lesson">
            <span class="lesson-txt" :class="lessonToneClass(s)">
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
            <!-- PRD-015：结算态徽标（未结不出徽标，避免全表满屏灰标签） -->
            <span v-if="settleBadge(s)" class="settle-badge" :class="settleBadge(s)!.tone">
              {{ settleBadge(s)!.label }}
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
              >去备课</el-button
            >
            <el-dropdown
              trigger="click"
              :disabled="busyId === s.id"
              @command="(c: string) => onCommand(c, s)"
            >
              <el-button size="small" text bg :loading="busyId === s.id">操作</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="reschedule" :disabled="isVoided(s)">改期</el-dropdown-item>
                  <el-dropdown-item command="rebind">改绑课次</el-dropdown-item>
                  <el-dropdown-item
                    command="markdone"
                    v-if="s.sessionStatus !== '1'"
                    :disabled="isVoided(s)"
                  >
                    标记已上
                  </el-dropdown-item>
                  <el-dropdown-item command="lock" :disabled="isVoided(s)">
                    {{ s.lessonLocked === '1' ? '解锁内容' : '锁定内容' }}
                  </el-dropdown-item>
                  <el-dropdown-item command="leave" divided :disabled="isVoided(s)">请假</el-dropdown-item>
                  <el-dropdown-item command="cancel" :disabled="isVoided(s)">取消场次</el-dropdown-item>
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

    <!-- PRD-015 D9/AC11：回收线（逐题判对错）已下线，此处原「课后回收弹窗（B4）」入口移除。
         组件文件 ReviewDialog.vue 与既有回收数据/读接口保留（下线≠坏档），物理清理另立小卡。 -->
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
tr.row-next td {
  background: var(--bk-teal-soft);
}
.next-badge {
  display: inline-flex;
  align-items: center;
  margin-left: 6px;
  font-size: 10.5px;
  font-weight: 700;
  color: var(--bk-teal-deep);
  background: #fff;
  border: 1px solid var(--bk-teal);
  border-radius: 99px;
  padding: 0 6px;
  line-height: 15px;
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
.lesson-txt.warn {
  color: #b45309;
}
.lesson-txt.muted {
  color: #9aa19d;
  font-weight: 500;
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
/* PRD-015 结算态徽标 */
.settle-badge {
  display: inline-flex;
  align-items: center;
  margin-left: 5px;
  font-size: 10.5px;
  font-weight: 700;
  border-radius: 99px;
  padding: 0 6px;
  line-height: 16px;
  white-space: nowrap;
}
.settle-badge.done {
  color: var(--bk-teal-deep);
  background: #fff;
  border: 1px solid var(--bk-teal);
}
.settle-badge.back {
  color: #b45309;
  background: #fff;
  border: 1px solid #e8c48f;
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
