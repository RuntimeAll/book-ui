<script setup lang="ts">
/**
 * PRD-C-213 FP10 场次详情抽屉。
 * 展示场次信息 + 操作按钮组：改期 / 请假 / 取消 / 标记已上 / 锁定内容。
 * 操作直接调 api，成功后 emit changed 让父页刷新。
 *
 * 注：抽屉数据由父页从月历事件或待备清单构造（DrawerSession），字段以可得为准；
 * 操作只依赖 session.id，缺 lessonLocked 时锁定态本地维护。
 *
 * 🔴 PRD-015 批3：「标记已上」恢复并<b>改语义 = 打开该场结算确认</b>（emit settle，父页开
 * SettleDialog 单场版）——扣课时 + 标已上一次完成，不再有裸标已上。
 * 已结场次点请假/取消先提示「将返还 X 课时 / ¥Y」，确认后走既有 leave/cancel（BE 自动冲正）。
 *
 * 🔴 PRD-018 批3 三处改造：
 *  ① **上课内容**（③）：新增「这节讲了什么」多行栏，走 updateSession(id,{content})，
 *     台账/流水单/导出的内容列取的就是它（content → 退课次标题 → 退「正课」）。
 *  ② **销假**（AC5/G5）：请假/取消/已冲正的场次一键恢复「已上 · 未结」+ 删掉该场扣课/冲正
 *     流水对 → 可正常重新结算。🔴 不还原课次绑定（请假时课次已释放回池，可能被别的场次排走）。
 *  ③ **顺延已死**（D6）：请假/取消不再顺延后续课次，只改本场状态 + 把本场课次释放回池
 *     （freedLessonId），计划详情的「有 N 个课次尚未排课」接住原 overflow 提示。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  updateSession,
  pageSessions,
  sessionLeave,
  sessionCancel,
  sessionLock,
  sessionUnlock,
  sessionRevokeLeave,
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
  /**
   * 🆕 PRD-018 ③：这节课实际讲了什么。
   * 🔴 契约缺口：`CalendarSessionVO` / `PrepTodoVO` 未声明 content（BE sessionVo 其实回传了），
   *    父页无法透传 → `undefined` 时抽屉自己按 targetId 回捞一次（见 loadContent）。
   */
  content?: string | null
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

/**
 * 「结算」按钮：未结 + 非请假/取消态才出（已结的场次改用冲正路径）。
 * 🔴 PRD-015 修复批：放行「已上（sessionStatus='1'）但未结（settleStatus='0'）」——存量场次
 *    与历史裸「标记已上」留下的漏网场次，因待结算清单口径（session_status='0'）永远进不了清单，
 *    抽屉是它们唯一的补结算入口；BE settleOne 只卡 settle_status，补结算能正常落账。
 */
const canSettle = computed(() => {
  const s = props.session
  if (!s || s.sessionType === '3') return false
  if (s.settleStatus === '1' || s.settleStatus === '2') return false
  return !s.sessionStatus || s.sessionStatus === '0' || s.sessionStatus === '1'
})

/** 结算按钮文案：正路=结算这节课；已上未结的漏网/存量场次=补结算 */
const settleBtnLabel = computed(() =>
  props.session?.sessionStatus === '1' ? '补结算' : '结算这节课',
)

/**
 * 请假/取消成功提示。
 * 🔄 PRD-018 D6：**顺延已删**——`deferred`/`overflow` 恒空，读它们的分支整段移除。
 *    取而代之报 `freedLessonId`（M8）：本场课次已释放回池，可以重新排给别的场次。
 * 🔄 PRD-018 D10：结算不建反馈壳 → `deletedShells`/`keptShells` 恒 0，不再提反馈。
 */
function reportDefer(r: DeferResult | undefined, okMsg: string) {
  const parts: string[] = []
  const rev = r?.reversal
  if (rev) parts.push(`已返还 ${rev.hours} 小时 / ¥${rev.amount}`)
  if (r?.freedLessonId) parts.push('课次已释放，可重新排课')
  ElMessage.success(parts.length ? `${okMsg}：${parts.join('，')}` : okMsg)
}

/** 已结场次改请假/取消前的冲正提示（PRD-015 V13；PRD-018 D10 起不再牵连反馈单） */
async function confirmReversal(verb: string): Promise<boolean> {
  if (!isSettled.value) return true
  const st = props.session?.settled
  const detail = st ? `将返还 ${st.hours} 小时 / ¥${st.amount}` : '将自动返还本次已扣的课时与课费'
  try {
    await ElMessageBox.confirm(
      `这节课已经结算过了，改为「${verb}」后${detail}。确认吗？`,
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
      // 🔄 D6：取消只改本场状态，其余场次的课次绑定一律不动；本场课次释放回池可重新排
      await ElMessageBox.confirm(
        '取消这一场只影响本场，其它课的安排不动。本场绑定的课次会释放回池，之后可以重新排给别的场次。确认取消？',
        '取消场次',
        { type: 'warning', confirmButtonText: '确认取消', cancelButtonText: '再想想' },
      )
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

// ── PRD-018 AC5/G5 · 销假 ────────────────────────────────────────────────
/**
 * 「销假」按钮出现条件：请假('2') / 取消('3') / 已冲正（settleStatus='2'）的场次。
 * 🔴 BE 守卫（已结算未冲正 → 400）**前端不预判**：直接把 BE 原文吐给老师（http 拦截器已弹），
 *    这里不再叠自造文案，免得把真正的原因盖住。
 */
const canRevoke = computed(() => {
  const s = props.session
  if (!s) return false
  return s.sessionStatus === '2' || s.sessionStatus === '3' || s.settleStatus === '2'
})

async function doRevokeLeave() {
  const s = props.session
  if (!s) return
  try {
    await ElMessageBox.confirm(
      '销假后这节课恢复成「已上 · 未结」，并<b>删除该场的冲正 / 扣课流水对</b>（净额为零、余额不变），之后可以重新结算。<br />' +
        '🔴 <b>课次绑定不会还原</b>——请假时课次已经释放回池，可能已经排给别的场次了，需要时手工改绑。',
      '销假并恢复为已上',
      {
        type: 'warning',
        dangerouslyUseHTMLString: true,
        confirmButtonText: '确认销假',
        cancelButtonText: '再想想',
      },
    )
  } catch {
    return
  }
  busy.value = true
  try {
    const r = await sessionRevokeLeave(s.id)
    const parts = ['已销假，恢复为「已上 · 未结」']
    if (r?.removedFlows) parts.push(`清掉 ${r.removedFlows} 条课时流水`)
    parts.push(r?.planLessonId ? '课次需要时手工改绑' : '本场原本没绑课次')
    ElMessage.success(parts.join('；'))
    emit('changed')
    innerVisible.value = false
  } catch (e) {
    // BE 守卫的 400 原文已由 http 拦截器弹出，这里只留痕不覆盖
    console.warn('[schedule] revoke-leave 失败', e)
  } finally {
    busy.value = false
  }
}

// ── PRD-018 ③ · 上课内容（这节实际讲了什么）────────────────────────────────
const contentDraft = ref('')
/** 已保存值快照：判断有没有改（没改就把保存按钮置灰，别让人误以为点了才生效） */
const contentSaved = ref('')
const contentLoading = ref(false)
const contentSaving = ref(false)
const contentChanged = computed(() => contentDraft.value.trim() !== contentSaved.value)

/** 抽屉每次开 / 换场次：内容栏重置为该场当前值；父页给不出（契约缺口）就回捞一次 */
watch(
  () => (props.visible ? props.session : null),
  (s) => {
    const c = s?.content ?? ''
    contentDraft.value = c
    contentSaved.value = c
    // undefined = 父页压根没传（契约缺口）；null = BE 明确说没内容，不必回捞
    if (s && s.content === undefined) void loadContent(s)
  },
  { immediate: true },
)

/**
 * 🔴 契约缺口兜底：抽屉的数据源是月历 / 待备清单，两者的 FE 契约（CalendarSessionVO /
 * PrepTodoVO）都没声明 content，父页透不过来（BE sessionVo 其实回传了）。
 * 所以 content 为 undefined 时，按 targetId 回捞一次场次表补齐本场内容。
 * BE session/page 无服务端分页（一次返该对象全量），一个抽屉一次请求，可接受。
 */
async function loadContent(s: DrawerSession) {
  if (!s.targetId) return
  contentLoading.value = true
  try {
    const res = await pageSessions({ targetId: s.targetId })
    if (props.session?.id !== s.id) return // 抽屉已切走，丢弃迟到结果
    const hit = (res?.rows ?? []).find((x) => x.id === s.id)
    const c = hit?.content ?? ''
    contentDraft.value = c
    contentSaved.value = c
  } catch (e) {
    console.warn('[schedule] 场次内容拉取失败', e)
  } finally {
    contentLoading.value = false
  }
}

async function saveContent() {
  const s = props.session
  if (!s) return
  const v = contentDraft.value.trim()
  contentSaving.value = true
  try {
    await updateSession(s.id, { content: v })
    contentDraft.value = v
    contentSaved.value = v
    ElMessage.success('已保存上课内容')
    emit('changed')
  } catch (e) {
    console.warn('[schedule] 保存上课内容失败', e)
  } finally {
    contentSaving.value = false
  }
}

/**
 * PRD-015：原「标记已上」→ 结算确认。关抽屉、把本场交给父页开 SettleDialog 单场版，
 * 由弹窗一次完成 扣课时 + 标已上（🔄 D10：不再建反馈壳）。
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
      // 🔄 PRD-018 D6：原文案「顺延时保持本课次」已失真（顺延已删），只陈述动作本身
      ElMessage.success('已锁定内容')
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
        <!-- PRD-015：结算态 + 实扣明细（PRD-018 D1：底账单位 = 小时） -->
        <div v-if="session.settleStatus === '1' || session.settleStatus === '2'">
          <dt>课时</dt>
          <dd v-if="session.settleStatus === '1'">
            已扣
            <template v-if="session.settled">
              {{ session.settled.hours }} 小时 · ¥{{ session.settled.amount }}
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

      <!-- PRD-018 ③ 上课内容：排课时带的是计划标题，上完课改成实际讲的；
           台账 / 流水单 / 导出的「内容」列取的就是这一栏 -->
      <div v-loading="contentLoading" class="sd-content">
        <div class="sd-content-t">
          这节讲了什么
          <span class="sd-content-opt">多行 · 可随时改</span>
        </div>
        <el-input
          v-model="contentDraft"
          type="textarea"
          :autosize="{ minRows: 3, maxRows: 6 }"
          maxlength="200"
          show-word-limit
          placeholder="写实际讲的内容，如：思维题 · 等差数列应用｜同步 · 平行与垂直"
        />
        <p class="sd-content-hint">台账和流水单的「内容」列显示的就是这一栏；留空则退回课次标题。</p>
        <div class="sd-content-btns">
          <el-button
            size="small"
            type="primary"
            :loading="contentSaving"
            :disabled="busy || !contentChanged"
            @click="saveContent"
          >
            保存内容
          </el-button>
        </div>
      </div>

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
          {{ settleBtnLabel }}
        </el-button>
        <!-- PRD-018 AC5/G5：销假 —— 请假/取消/已冲正的场次一键恢复「已上 · 未结」并清掉流水对 -->
        <el-button
          v-if="canRevoke"
          class="sd-revoke-btn"
          type="warning"
          plain
          :disabled="busy"
          @click="doRevokeLeave"
        >
          销假 · 恢复为已上
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
/* PRD-018：销假同样独占一行（请假态下它就是主动作） */
.sd-revoke-btn {
  grid-column: 1 / -1;
  width: 100%;
}
/* PRD-018 ③：上课内容栏 */
.sd-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border: 1px solid var(--bk-line);
  border-radius: 10px;
}
.sd-content-t {
  font-size: 13px;
  font-weight: 700;
  color: var(--bk-ink);
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.sd-content-opt {
  font-size: 11px;
  font-weight: 400;
  color: #8ba09a;
}
.sd-content-hint {
  margin: 0;
  font-size: 11.5px;
  color: #8ba09a;
  line-height: 1.6;
}
.sd-content-btns {
  display: flex;
  justify-content: flex-end;
}
</style>