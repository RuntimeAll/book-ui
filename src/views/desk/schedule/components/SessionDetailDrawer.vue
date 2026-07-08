<script setup lang="ts">
/**
 * PRD-C-213 FP10 场次详情抽屉。
 * 展示场次信息 + 操作按钮组：改期 / 请假 / 取消 / 标记已上 / 锁定内容。
 * 操作直接调 api，成功后 emit changed 让父页刷新；请假/取消返回顺延明细用 message 提示。
 *
 * 注：抽屉数据由父页从月历事件或待备清单构造（DrawerSession），字段以可得为准；
 * 操作只依赖 session.id，缺 lessonLocked 时锁定态本地维护。
 */
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  updateSession,
  sessionLeave,
  sessionCancel,
  sessionMarkDone,
  sessionLock,
  sessionUnlock,
  SESSION_TYPE_LABEL,
  SESSION_STATUS_LABEL,
  PREP_STATUS_LABEL,
} from '@/api/teacher/schedule'
import type {
  SessionType,
  SessionStatus,
  PrepStatus,
  DeferResult,
} from '@/api/teacher/schedule'

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
  title?: string
  lessonLocked?: string
  /** PRD-B-101：去备课定位用（跳课程计划页展开对应课次） */
  targetId?: string
  planLessonId?: string
}

const props = defineProps<{
  visible: boolean
  session: DrawerSession | null
}>()

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'changed'): void
}>()

const router = useRouter()

const innerVisible = computed({
  get: () => props.visible,
  set: (v) => emit('update:visible', v),
})

// PRD-B-101 V5：去备课 → 跳课程计划页并定位/展开对应课次（B2b 升级为开备课语境）
function goPrep() {
  const s = props.session
  if (!s) return
  const query: Record<string, string> = { from: 'schedule' }
  if (s.targetId) query.targetId = s.targetId
  if (s.planLessonId) query.lessonId = s.planLessonId
  innerVisible.value = false
  router.push({ path: '/desk/plans', query })
}

// 本地锁定态（数据源可能不带 lessonLocked）
const locked = ref(false)
const busy = ref(false)

// 改期子表单
const rescheduling = ref(false)
const reDate = ref('')
const reStart = ref('')
const reEnd = ref('')

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

// BUG-003：sessionStatus 存在且非'0'（已排）时禁用改期/请假/取消/锁定/标记已上；
// status undefined（老入口，如从待备清单开抽屉）视为可操作，行为不变。
const disableReason = computed(() => {
  const st = props.session?.sessionStatus
  if (!st || st === '0') return ''
  return `${SESSION_STATUS_LABEL[st]}的场次不可操作`
})

function reportDefer(r: DeferResult | undefined, okMsg: string) {
  const parts: string[] = []
  if (r?.deferred?.length) parts.push(`${r.deferred.length} 场课次顺延`)
  if (r?.overflow?.length) parts.push(`${r.overflow.length} 场末位溢出待补排`)
  ElMessage.success(parts.length ? `${okMsg}：${parts.join('，')}` : okMsg)
}

async function doLeave() {
  if (!props.session) return
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
  try {
    await ElMessageBox.confirm('取消该场次会触发后续课次顺延，确认取消？', '取消场次', {
      type: 'warning',
      confirmButtonText: '确认取消',
      cancelButtonText: '再想想',
    })
  } catch {
    return
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

async function doMarkDone() {
  if (!props.session) return
  busy.value = true
  try {
    await sessionMarkDone(props.session.id)
    ElMessage.success('已标记为已上')
    emit('changed')
    innerVisible.value = false
  } catch (e) {
    console.warn('[schedule] markDone 失败', e)
    ElMessage.error('操作失败，请重试')
  } finally {
    busy.value = false
  }
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
          <div class="sd-title">{{ session.title || SESSION_TYPE_LABEL[session.sessionType] }}</div>
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
          <dt>类型</dt>
          <dd>{{ SESSION_TYPE_LABEL[session.sessionType] }}</dd>
        </div>
        <div v-if="session.sessionStatus">
          <dt>状态</dt>
          <dd>{{ SESSION_STATUS_LABEL[session.sessionStatus] }}</dd>
        </div>
        <div>
          <dt>备课</dt>
          <dd>{{ PREP_STATUS_LABEL[session.prepStatus] }}</dd>
        </div>
        <div>
          <dt>内容锁</dt>
          <dd>{{ locked ? '已锁定' : '未锁定' }}</dd>
        </div>
      </dl>

      <!-- PRD-B-101 V5：去备课（跳课程计划页定位课次 · 卷位清单）-->
      <el-button type="primary" class="sd-goprep" :disabled="busy" @click="goPrep">去备课</el-button>

      <!-- 改期子表单 -->
      <div v-if="rescheduling" class="sd-reform">
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
          <el-button size="small" @click="rescheduling = false">取消</el-button>
          <el-button size="small" type="primary" :loading="busy" @click="submitReschedule">
            保存改期
          </el-button>
        </div>
      </div>

      <!-- 操作组：sessionStatus 非'0'（已排）时禁用，title 给禁用原因 -->
      <div v-else class="sd-actions">
        <el-button :disabled="busy || !!disableReason" :title="disableReason" @click="rescheduling = true">
          改期
        </el-button>
        <el-button :disabled="busy || !!disableReason" :title="disableReason" @click="doMarkDone">
          标记已上
        </el-button>
        <el-button :disabled="busy || !!disableReason" :title="disableReason" @click="doLeave">请假</el-button>
        <el-button :disabled="busy || !!disableReason" :title="disableReason" @click="toggleLock">
          {{ locked ? '解锁内容' : '锁定内容' }}
        </el-button>
        <el-button
          :disabled="busy || !!disableReason"
          :title="disableReason"
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
.sd-actions .el-button:last-child {
  grid-column: 1 / -1;
}
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
</style>
