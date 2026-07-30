<script setup lang="ts">
/**
 * PRD-C-213 FP10 场次详情抽屉。
 * 展示场次信息 + 操作按钮组：改期 / 请假 / 取消 / 标记已上 / 锁定内容。
 * 操作直接调 api，成功后 emit changed 让父页刷新；请假/取消返回顺延明细用 message 提示。
 *
 * 注：抽屉数据由父页从月历事件或待备清单构造（DrawerSession），字段以可得为准；
 * 操作只依赖 session.id，缺 lessonLocked 时锁定态本地维护。
 *
 * 🔴 PRD-015 批3：「标记已上」恢复并<b>改语义 = 打开该场结算确认</b>（emit settle，父页开
 * SettleDialog 单场版）——扣课时课费 + 标已上 + 生成反馈壳一次完成，不再有裸标已上。
 * 已结场次点请假/取消先提示「将返还 X 课时 / ¥Y」，确认后走既有 leave/cancel（BE 自动冲正）。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  updateSession,
  sessionLeave,
  sessionCancel,
  sessionLock,
  sessionUnlock,
  SESSION_STATUS_LABEL,
  PREP_STATUS_LABEL,
} from '@/api/teacher/schedule'
import type {
  SessionType,
  SessionStatus,
  PrepStatus,
  DeferResult,
} from '@/api/teacher/schedule'
import { usePrepEntry } from '@/composables/usePrepEntry'

export interface DrawerSession {
  id: string
  targetName: string
  color: string
  date: string
  start: string
  end: string
  sessionType: SessionType
  sessionStatus?: SessionStatus
  prepStatus: PrepStatus
  /** 学科标签（数学/科学…，BE 兜底链解好） */
  subjectLabel?: string
  title?: string
  lessonLocked?: string
  /** PRD-B-101：去备课定位用（跳课程计划页展开对应课次） */
  targetId?: string
  planLessonId?: string
  /** PRD-015 结算态：'0' 未结 / '1' 已结 / '2' 已冲正 */
  settleStatus?: string
  /** PRD-015 已结场次的实扣快照（冲正提示「将返还 X 课时 / ¥Y」） */
  settled?: { hours: number; amount: number } | null
}

const props = defineProps<{
  visible: boolean
  session: DrawerSession | null
}>()

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'changed'): void
  /** PRD-015：请求父页开结算确认弹窗（单场版） */
  (e: 'settle', s: DrawerSession): void
}>()

const { goPrepForLesson } = usePrepEntry()

const innerVisible = computed({
  get: () => props.visible,
  set: (v) => emit('update:visible', v),
})

// PRD-B-101 V5/D6：去备课 → 有空卷位开备课语境定位第一个空位跳题库；全绑/零卷位跳课程计划页定位
function goPrep() {
  const s = props.session
  if (!s) return
  innerVisible.value = false
  void goPrepForLesson({
    targetId: s.targetId,
    lessonId: s.planLessonId,
    studentName: s.targetName,
    lessonDate: s.date,
    from: 'schedule',
  })
}

// 头部副标题：真实课次标题(过滤「正课/测试」占位词) → 科目 → 测试类型提示 → 空
const headSubtitle = computed(() => {
  const st = props.session
  if (!st) return ''
  const t = st.title && !['正课', '测试'].includes(st.title) ? st.title : ''
  if (t) return st.subjectLabel ? `${st.subjectLabel} · ${t}` : t
  if (st.sessionType === '2') return st.subjectLabel ? `${st.subjectLabel} · 测试` : '测试'
  return st.subjectLabel || ''
})

// 本地锁定态（数据源可能不带 lessonLocked）
const locked = ref(false)
const busy = ref(false)

// 改期子表单
const rescheduling = ref(false)
const reDate = ref('')
const reStart = ref('')
const reEnd = ref('')
// 改期外置常驻：与原值一致时保存置灰（避免无效提交）
const reChanged = computed(() => {
  const st = props.session
  if (!st) return false
  return reDate.value !== st.date || reStart.value !== st.start || reEnd.value !== st.end
})

watch(
  () => props.session,
  (s) => {
    locked.value = s?.lessonLocked === '1'
    rescheduling.value = false
    if (s) {
      reDate.value = s.date
      reStart.value = s.start
      reEnd.value = s.end
    }
  },
  { immediate: true },
)

// PRD-015：已结算（settleStatus='1'）
const isSettled = computed(() => props.session?.settleStatus === '1')

// BUG-003：sessionStatus 存在且非'0'（已排）时禁用改期/请假/取消/锁定/标记已上；
// status undefined（老入口，如从待备清单开抽屉）视为可操作，行为不变。
// 🔴 PRD-015 放行一类：已结算场次仍可请假/取消（走冲正返还），见 canVoid。
const disableReason = computed(() => {
  const st = props.session?.sessionStatus
  if (!st || st === '0') return ''
  return `${SESSION_STATUS_LABEL[st]}的场次不可操作`
})

/** 请假/取消可用性：未上（disableReason 空）或已结算（改主意 → 冲正返还） */
const voidDisableReason = computed(() => (isSettled.value ? '' : disableReason.value))

/** 「结算」按钮：未结 + 非请假/取消态才出（已结的场次改用冲正路径） */
const canSettle = computed(() => {
  const s = props.session
  if (!s || s.sessionType === '3') return false
  if (s.settleStatus === '1' || s.settleStatus === '2') return false
  return !s.sessionStatus || s.sessionStatus === '0'
})

function reportDefer(r: DeferResult | undefined, okMsg: string) {
  const parts: string[] = []
  const rev = r?.reversal
  if (rev) {
    parts.push(`已返还 ${rev.hours} 课时 / ¥${rev.amount}`)
    if (rev.deletedShells) parts.push(`清除 ${rev.deletedShells} 份空反馈`)
    if (rev.keptShells) parts.push(`保留 ${rev.keptShells} 份已填反馈`)
  }
  if (r?.deferred?.length) parts.push(`${r.deferred.length} 场课次顺延`)
  if (r?.overflow?.length) parts.push(`${r.overflow.length} 场末位溢出待补排`)
  ElMessage.success(parts.length ? `${okMsg}：${parts.join('，')}` : okMsg)
}

/** 已结场次改请假/取消前的冲正提示（PRD-015 V13） */
async function confirmReversal(verb: string): Promise<boolean> {
  if (!isSettled.value) return true
  const st = props.session?.settled
  const detail = st ? `将返还 ${st.hours} 课时 / ¥${st.amount}` : '将自动返还本次已扣的课时与课费'
  try {
    await ElMessageBox.confirm(
      `这节课已经结算过了，改为「${verb}」后${detail}，还没填内容的反馈会一并清除。确认吗？`,
      `${verb}并返还`,
      { type: 'warning', confirmButtonText: `确认${verb}`, cancelButtonText: '再想想' },
    )
    return true
  } catch {
    return false
  }
}

async function doLeave() {
  if (!props.session) return
  if (!(await confirmReversal('请假'))) return
  busy.value = true
  try {
    const r = await sessionLeave(props.session.id)
    reportDefer(r, '已标记请假')
    emit('changed')
    innerVisible.value = false
  } catch (e) {
    console.warn('[schedule] leave 失败', e)
    ElMessage.error('操作失败，请重试')
  } finally {
    busy.value = false
  }
}

async function doCancel() {
  if (!props.session) return
  if (isSettled.value) {
    if (!(await confirmReversal('取消'))) return
  } else {
    try {
      await ElMessageBox.confirm('取消该场次会触发后续课次顺延，确认取消？', '取消场次', {
        type: 'warning',
        confirmButtonText: '确认取消',
        cancelButtonText: '再想想',
      })
    } catch {
      return
    }
  }
  busy.value = true
  try {
    const r = await sessionCancel(props.session.id)
    reportDefer(r, '已取消场次')
    emit('changed')
    innerVisible.value = false
  } catch (e) {
    console.warn('[schedule] cancel 失败', e)
    ElMessage.error('操作失败，请重试')
  } finally {
    busy.value = false
  }
}

/**
 * PRD-015：原「标记已上」→ 结算确认。关抽屉、把本场交给父页开 SettleDialog 单场版，
 * 由弹窗一次完成 扣课时课费 + 标已上 + 生成反馈壳。
 */
function doSettle() {
  const s = props.session
  if (!s) return
  innerVisible.value = false
  emit('settle', s)
}

async function toggleLock() {
  if (!props.session) return
  busy.value = true
  try {
    if (locked.value) {
      await sessionUnlock(props.session.id)
      locked.value = false
      ElMessage.success('已解锁内容')
    } else {
      await sessionLock(props.session.id)
      locked.value = true
      ElMessage.success('已锁定内容（顺延时保持本课次）')
    }
    emit('changed')
  } catch (e) {
    console.warn('[schedule] lock 失败', e)
    ElMessage.error('操作失败，请重试')
  } finally {
    busy.value = false
  }
}

// 2026-07-11 先隐藏的按钮（锁定内容）对应处理函数保留，恢复按钮即可用
// （标记已上 → PRD-015 已恢复为「结算」；请假 → PRD-015 已恢复，带冲正提示）
void toggleLock

async function submitReschedule() {
  if (!props.session) return
  if (!reDate.value || !reStart.value || !reEnd.value) {
    ElMessage.warning('请填写完整的日期与时段')
    return
  }
  busy.value = true
  try {
    await updateSession(props.session.id, {
      date: reDate.value,
      start: reStart.value,
      end: reEnd.value,
    })
    ElMessage.success('已改期')
    rescheduling.value = false
    emit('changed')
    innerVisible.value = false
  } catch (e) {
    console.warn('[schedule] reschedule 失败', e)
    ElMessage.error('改期失败，请重试')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <el-drawer
    v-model="innerVisible"
    title="场次详情"
    size="380px"
    :append-to-body="true"
    direction="rtl"
  >
    <div v-if="session" class="sd-body">
      <!-- 头 -->
      <div class="sd-head">
        <span class="sd-swatch" :style="{ background: session.color }" />
        <div>
          <div class="sd-name">{{ session.targetName || '未命名对象' }}</div>
          <div class="sd-title">{{ headSubtitle }}</div>
        </div>
      </div>

      <!-- 信息行 -->
      <dl class="sd-info">
        <div>
          <dt>日期</dt>
          <dd>{{ session.date }}</dd>
        </div>
        <div>
          <dt>时段</dt>
          <dd>{{ session.start }} – {{ session.end }}</dd>
        </div>
        <div>
          <dt>科目</dt>
          <dd>{{ session.subjectLabel || '—' }}</dd>
        </div>
        <div v-if="session.sessionStatus">
          <dt>状态</dt>
          <dd>{{ SESSION_STATUS_LABEL[session.sessionStatus] }}</dd>
        </div>
        <div>
          <dt>备课</dt>
          <dd>{{ PREP_STATUS_LABEL[session.prepStatus] }}</dd>
        </div>
        <!-- PRD-015：结算态 + 实扣明细 -->
        <div v-if="session.settleStatus === '1' || session.settleStatus === '2'">
          <dt>课时</dt>
          <dd v-if="session.settleStatus === '1'">
            已扣
            <template v-if="session.settled">
              {{ session.settled.hours }} 课时 · ¥{{ session.settled.amount }}
            </template>
          </dd>
          <dd v-else>已返还</dd>
        </div>
        <!-- 2026-07-11 用户拍板先隐藏：内容锁（散排用不上，恢复删本注释）
        <div v-if="session.planLessonId">
          <dt>内容锁</dt>
          <dd>{{ locked ? '已锁定' : '未锁定' }}</dd>
        </div>
        -->
      </dl>

      <!-- PRD-B-101 V5：去备课（跳课程计划页定位课次 · 卷位清单）-->
      <el-button type="primary" class="sd-goprep" :disabled="busy" @click="goPrep">去备课</el-button>

      <!-- 改期子表单 -->
      <!-- 改期外置常驻（2026-07-11：少点一次，直接改日期/时段→保存） -->
      <div class="sd-reform">
        <div class="sd-reform-t">改期</div>
        <el-date-picker
          v-model="reDate"
          type="date"
          value-format="YYYY-MM-DD"
          placeholder="选择日期"
          style="width: 100%"
        />
        <div class="sd-reform-time">
          <el-time-picker
            v-model="reStart"
            value-format="HH:mm"
            format="HH:mm"
            placeholder="开始"
            style="width: 100%"
          />
          <span class="sd-dash">–</span>
          <el-time-picker
            v-model="reEnd"
            value-format="HH:mm"
            format="HH:mm"
            placeholder="结束"
            style="width: 100%"
          />
        </div>
        <div class="sd-reform-btns">
          <el-button
            size="small"
            type="primary"
            :loading="busy"
            :disabled="!!disableReason || !reChanged"
            :title="disableReason"
            @click="submitReschedule"
          >
            保存改期
          </el-button>
        </div>
      </div>

      <!-- 操作组（PRD-015 批3：「标记已上」恢复为「结算这节课」；请假恢复并带冲正提示；
           锁定内容仍隐藏——散排用不上，恢复删注释） -->
      <div class="sd-actions">
        <el-button
          v-if="canSettle"
          type="primary"
          plain
          class="sd-settle-btn"
          :disabled="busy"
          @click="doSettle"
        >
          结算这节课
        </el-button>
        <!--
        <el-button v-if="session.planLessonId" :disabled="busy || !!disableReason" @click="toggleLock">
          {{ locked ? '解锁内容' : '锁定内容' }}
        </el-button>
        -->
        <el-button
          :disabled="busy || !!voidDisableReason"
          :title="voidDisableReason"
          @click="doLeave"
        >
          请假
        </el-button>
        <el-button
          :disabled="busy || !!voidDisableReason"
          :title="voidDisableReason"
          type="danger"
          plain
          @click="doCancel"
        >
          取消场次
        </el-button>
      </div>
    </div>
    <el-empty v-else description="无场次数据" />
  </el-drawer>
</template>

<style scoped>
.sd-body {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.sd-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.sd-swatch {
  width: 14px;
  height: 14px;
  border-radius: 4px;
  flex: none;
}
.sd-name {
  font-size: 16px;
  font-weight: 800;
  color: var(--bk-ink);
}
.sd-title {
  font-size: 12.5px;
  color: #5f716d;
  margin-top: 2px;
}
.sd-info {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px 16px;
  margin: 0;
  padding: 14px;
  background: var(--bk-teal-soft);
  border-radius: 10px;
}
.sd-info dt {
  font-size: 11px;
  color: #8ba09a;
  margin-bottom: 3px;
}
.sd-info dd {
  font-size: 13px;
  color: var(--bk-ink);
  font-weight: 600;
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.sd-goprep {
  width: 100%;
  margin: 0;
}
.sd-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.sd-actions .el-button {
  margin: 0;
}
/* PRD-015：操作组现为 结算(整行) + 请假/取消(两列)，不再让 last-child 强行整行 */
.sd-reform {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--bk-line);
  border-radius: 10px;
}
.sd-reform-t {
  font-size: 13px;
  font-weight: 700;
  color: var(--bk-ink);
}
.sd-reform-time {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sd-dash {
  color: #8ba09a;
  flex: none;
}
.sd-reform-btns {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
/* PRD-015：结算按钮独占一行放在操作组最上（主动作） */
.sd-settle-btn {
  grid-column: 1 / -1;
  width: 100%;
}
</style>