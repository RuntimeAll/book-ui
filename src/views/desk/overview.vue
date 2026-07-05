<script setup lang="ts">
/**
 * 备课台 · 概览分区（PRD-C-212 V1 + PRD-C-213 B4 教学安排增强）。
 *
 * 顶部问候 + FP5 快速排课按钮（复用 BatchScheduleWizard，仅 import 不改）。
 * 教学安排区块（对照设计稿 v-overview）：
 *   FP1 今日课程时间线：从本周 getCalendar 过滤当天；外部占位灰显无备课按钮；
 *        已结束且未标已上 → 「标记已上」(sessionMarkDone)。
 *   FP2 待备提醒条：getPrepTodo(7) 聚合；点行跳 /desk/prep?lessonId=。
 *   FP3 统计卡 ×4：getStatOverview()（我的学生 / 本周课次 / 待备课 / 我的题库）。
 *   FP4 本周课表：与 FP1 同源 getCalendar（周一–周日一次拉，前端过滤渲染），🔴 禁另造接口。
 *   保留原「快捷入口」卡（最近动态位）。
 *
 * 🔴 冲突记录：原「我的题库/我创建的试卷/我的收藏」三张卡与 FP3 统计位冲突，
 *   按「本区块优先」规则由 FP3 四卡（走 stat/overview）接管统计位；快捷入口卡保留。
 * 🔴 BE :8090 可能未起：所有请求 try/catch 优雅空态，不白屏。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useUserStore } from '@/store/user'
import { getCurrentUser } from '@/api/user'
import {
  getCalendar,
  getPrepTodo,
  getStatOverview,
  sessionMarkDone,
  PREP_STATUS_LABEL,
  SESSION_TYPE_LABEL,
  type CalendarSessionVO,
  type PrepTodoVO,
  type StatOverviewVO,
  type PrepStatus,
} from '@/api/teacher/schedule'
import BatchScheduleWizard from './schedule/components/BatchScheduleWizard.vue'

const router = useRouter()
const userStore = useUserStore()

// ── 日期工具（纯字符串拼装，避免时区漂移）──────────────────────────
const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const now = new Date()
const todayStr = fmtDate(now)
const nowHM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

// 本周一~周日（周一起算）
function weekRange(): { mon: string; sun: string } {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const dow = d.getDay() // 0=周日
  const offsetToMon = dow === 0 ? -6 : 1 - dow
  const mon = new Date(d)
  mon.setDate(d.getDate() + offsetToMon)
  const sun = new Date(mon)
  sun.setDate(mon.getDate() + 6)
  return { mon: fmtDate(mon), sun: fmtDate(sun) }
}
const wk = weekRange()

function shortDate(str?: string): string {
  if (!str) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str)
  if (!m) return str
  return `${Number(m[2])}/${Number(m[3])}`
}
function weekdayCn(str?: string): string {
  const m = str ? /^(\d{4})-(\d{2})-(\d{2})/.exec(str) : null
  if (!m) return ''
  return WEEK_CN[new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay()]
}
function relDay(str?: string): string {
  if (str === todayStr) return '今天'
  return `${shortDate(str)} ${weekdayCn(str)}`
}
function hhmm(t?: string): string {
  return (t || '').slice(0, 5)
}

// ── 顶部问候 ────────────────────────────────────────────────
const greeting = computed(() => {
  const h = now.getHours()
  if (h < 12) return '早上好'
  if (h < 18) return '下午好'
  return '晚上好'
})
const displayName = computed(
  () => userStore.userInfo?.realName || userStore.userInfo?.userName || '老师',
)
const greetName = computed(() =>
  /老师|校长/.test(displayName.value) ? displayName.value : `${displayName.value} 老师`,
)
const todayEyebrow = computed(() => `${now.getMonth() + 1}月${now.getDate()}日 · ${WEEK_CN[now.getDay()]}`)

// ── FP4 + FP1 同源：本周课表（getCalendar 一次拉）──────────────────
const weekEvents = ref<CalendarSessionVO[]>([])
const calLoading = ref(false)

async function fetchCalendar() {
  calLoading.value = true
  try {
    const data = await getCalendar({ start: wk.mon, end: wk.sun })
    weekEvents.value = Array.isArray(data) ? data : []
  } catch (e) {
    console.warn('[desk-overview] getCalendar 失败', e)
    weekEvents.value = []
  } finally {
    calLoading.value = false
  }
}

// FP1 今日事件（当天，按开始时间排）
const todayEvents = computed(() =>
  weekEvents.value
    .filter((e) => e.sessionDate === todayStr)
    .slice()
    .sort((a, b) => hhmm(a.startTime).localeCompare(hhmm(b.startTime))),
)

// FP4 本周全部（按 日期+时间 排）
const weekList = computed(() =>
  weekEvents.value
    .slice()
    .sort(
      (a, b) =>
        (a.sessionDate + hhmm(a.startTime)).localeCompare(b.sessionDate + hhmm(b.startTime)),
    ),
)

function evtTitle(e: CalendarSessionVO): string {
  if (e.sessionType === '3') return e.externalTitle || '外部占位'
  return `${e.targetName}${e.lessonTitle ? ' · ' + e.lessonTitle : ''}`
}
function isExternal(e: CalendarSessionVO): boolean {
  return e.sessionType === '3'
}
// 本周课表右侧简述（不重复对象名）
function evtWhat(e: CalendarSessionVO): string {
  if (e.sessionType === '3') return e.externalTitle || '外部占位'
  return e.lessonTitle || SESSION_TYPE_LABEL[e.sessionType]
}
// 今日已结束（endTime < 现在，非外部，未标已上）
function isEndedTodo(e: CalendarSessionVO): boolean {
  return e.sessionType !== '3' && e.sessionStatus !== '1' && hhmm(e.endTime) < nowHM
}

const PREP_PILL: Record<PrepStatus, string> = { '2': 'ok', '1': 'mid', '0': 'todo' }

// 顶部一句话概括
const overviewSub = computed(() => {
  const total = todayEvents.value.filter((e) => !isExternal(e)).length
  if (!total) return '今天暂无排课 · 随时可点右上角快速排课'
  const pending = todayEvents.value.filter((e) => e.sessionStatus !== '1' && !isExternal(e)).length
  return `今天 ${total} 场课${pending ? `，${pending} 场待上` : '，均已完成'}`
})

// FP1 标记已上
const markingId = ref('')
async function onMarkDone(e: CalendarSessionVO) {
  markingId.value = e.id
  try {
    await sessionMarkDone(e.id)
    ElMessage.success('已标记为已上')
    await Promise.all([fetchCalendar(), fetchStat()])
  } finally {
    markingId.value = ''
  }
}
function goPrepBySession(e: CalendarSessionVO) {
  const query: Record<string, string> = { sessionId: e.id, from: 'overview' }
  if (e.targetId) query.targetId = e.targetId
  if (e.planLessonId) query.lessonId = e.planLessonId
  router.push({ path: '/desk/prep', query })
}

// ── FP2 明日课程（BUG-006：由「细备窗口·N场待备」大列表改为明日课程，去催备语义）──────
const todoList = ref<PrepTodoVO[]>([])
const todoLoading = ref(false)
async function fetchTodo() {
  todoLoading.value = true
  try {
    const data = await getPrepTodo(7)
    todoList.value = Array.isArray(data) ? data : []
  } catch (e) {
    console.warn('[desk-overview] getPrepTodo 失败', e)
    todoList.value = []
  } finally {
    todoLoading.value = false
  }
}
// 明天日期字符串 + 明日待备课过滤（getPrepTodo 口径本身只含未备/备课中场次，
// 已备好的明日课不会出现在这里，天然满足「已备好则不显示角标」）
const tomorrowStr = computed(() => {
  const d = new Date(now)
  d.setDate(d.getDate() + 1)
  return fmtDate(d)
})
const tomorrowList = computed(() => todoList.value.filter((t) => t.sessionDate === tomorrowStr.value))
function goTodo(t: PrepTodoVO) {
  // BUG-008/BUG-009：补 sessionId + targetId（供身份行拼装）+ from（供返回按钮溯源）
  const query: Record<string, string> = { sessionId: String(t.id), from: 'overview' }
  if (t.planLessonId) query.lessonId = String(t.planLessonId)
  if (t.targetId) query.targetId = String(t.targetId)
  router.push({ path: '/desk/prep', query })
}

// ── FP3 统计卡 ×4 ──────────────────────────────────────────
const stat = ref<StatOverviewVO | null>(null)
const statLoading = ref(false)
async function fetchStat() {
  statLoading.value = true
  try {
    stat.value = await getStatOverview()
  } catch (e) {
    console.warn('[desk-overview] getStatOverview 失败', e)
    stat.value = null
  } finally {
    statLoading.value = false
  }
}
interface StatCard {
  label: string
  value: () => number | null
  unit: string
  path: string
  warm?: boolean
}
const statCards = computed<StatCard[]>(() => [
  { label: '我的学生', value: () => stat.value?.studentCount ?? null, unit: '人', path: '/desk/targets' },
  { label: '本周课次', value: () => stat.value?.weekSessionCount ?? null, unit: '场', path: '/desk/schedule' },
  { label: '待备课', value: () => stat.value?.todoPrepCount ?? null, unit: '场', path: '/desk/prep', warm: true },
  { label: '我的题库', value: () => stat.value?.myQuestionCount ?? null, unit: '题', path: '/desk/my-question' },
])
function goCard(path: string) {
  router.push(path)
}

// ── FP5 快速排课 ────────────────────────────────────────────
const wizardVisible = ref(false)
function reloadAll() {
  fetchCalendar()
  fetchTodo()
  fetchStat()
}

// ── 快捷入口（保留）────────────────────────────────────────
const quickEntries = [
  { title: '去题库逛逛', desc: '到公共题库按章节找找好题', path: '/question/index' },
  { title: '组一张卷', desc: '进组卷工作台，从零攒一份新卷', path: '/papers/workbench' },
  { title: '试试举一反三', desc: '拍一道题，备课帮帮你出变式', path: '/desk/ai-variant' },
]
function goQuick(path: string) {
  router.push(path)
}

onMounted(async () => {
  // userInfo onMounted 兜底（刷新后不丢角色）
  if (!userStore.userInfo) {
    try {
      const info = await getCurrentUser()
      if (info) userStore.setUserInfo(info)
    } catch (e) {
      console.warn('[desk-overview] getCurrentUser 兜底失败', e)
    }
  }
  reloadAll()
})
</script>

<template>
  <div class="dk-overview">
    <!-- 顶部问候 + FP5 快速排课 -->
    <header class="ov-head">
      <div class="ov-head-l">
        <div class="ov-eyebrow">{{ todayEyebrow }}</div>
        <h1 class="ov-title">{{ greeting }}，{{ greetName }}</h1>
        <p class="ov-sub">{{ overviewSub }}</p>
      </div>
      <el-button type="primary" @click="wizardVisible = true">
        <el-icon style="margin-right: 4px"><Plus /></el-icon>快速排课
      </el-button>
    </header>

    <div class="ov-grid">
      <!-- 左列 -->
      <div class="ov-col">
        <!-- FP1 今日课程 -->
        <section class="ov-card" v-loading="calLoading">
          <h2 class="ov-h2"><span class="ov-tick" />今日课程</h2>
          <ul v-if="todayEvents.length" class="tl">
            <li
              v-for="e in todayEvents"
              :key="e.id"
              :class="{ ext: isExternal(e), done: e.sessionStatus === '1' }"
            >
              <div class="tl-time">
                <b>{{ hhmm(e.startTime) || '全天' }}</b>
                <span>{{ e.endTime ? '– ' + hhmm(e.endTime) : '外部日程' }}</span>
              </div>
              <span class="tl-dot" :style="{ background: isExternal(e) ? '#c3cecb' : e.color || 'var(--bk-teal)' }" />
              <div class="tl-body">
                <div class="tl-title">
                  {{ evtTitle(e) }}
                  <span v-if="isExternal(e)" class="pill mute">外部占位</span>
                  <span v-else-if="e.sessionStatus === '1'" class="pill mute">已上</span>
                  <span v-else class="pill" :class="PREP_PILL[e.prepStatus]">
                    {{ PREP_STATUS_LABEL[e.prepStatus] }}
                  </span>
                </div>
                <div class="tl-desc">
                  {{ isExternal(e) ? '外部日程 · 排课时自动避冲突' : SESSION_TYPE_LABEL[e.sessionType] }}
                </div>
              </div>
              <div class="tl-act">
                <el-button
                  v-if="isEndedTodo(e)"
                  size="small"
                  type="warning"
                  text
                  bg
                  :loading="markingId === e.id"
                  @click="onMarkDone(e)"
                  >标记已上</el-button
                >
                <el-button
                  v-else-if="!isExternal(e) && e.sessionStatus !== '1'"
                  size="small"
                  type="primary"
                  text
                  bg
                  @click="goPrepBySession(e)"
                  >进入备课包</el-button
                >
              </div>
            </li>
          </ul>
          <div v-else-if="!calLoading" class="ov-empty">今天没有排课</div>
        </section>

        <!-- FP2 明日课程 -->
        <section class="prep-strip" v-loading="todoLoading">
          <div class="ps-head">
            <span class="ps-ic"><el-icon><Bell /></el-icon></span>
            <b>明日课程</b>
          </div>
          <ul v-if="tomorrowList.length" class="ps-list">
            <li v-for="t in tomorrowList" :key="t.id" @click="goTodo(t)">
              <span class="ps-when">{{ hhmm(t.startTime) }}</span>
              <span class="ps-name">{{ t.targetName || '未命名对象' }}</span>
              <span class="ps-what">{{ t.lessonTitle || SESSION_TYPE_LABEL[t.sessionType] }}</span>
              <span class="pill todo">未备</span>
            </li>
          </ul>
          <div v-else-if="!todoLoading" class="ps-empty">明天暂无排课</div>
        </section>

        <!-- FP3 统计卡 ×4 -->
        <div class="ov-stats" v-loading="statLoading">
          <div
            v-for="c in statCards"
            :key="c.label"
            class="ov-stat"
            :class="{ warm: c.warm }"
            @click="goCard(c.path)"
          >
            <div class="ov-stat-v">
              {{ c.value() ?? '—' }}<small>{{ c.unit }}</small>
            </div>
            <div class="ov-stat-k">{{ c.label }}</div>
          </div>
        </div>
      </div>

      <!-- 右列 -->
      <div class="ov-col">
        <!-- FP4 本周课表 -->
        <section class="ov-card" v-loading="calLoading">
          <h2 class="ov-h2">
            <span class="ov-tick" />本周课表
            <span class="ov-h2-sub">{{ shortDate(wk.mon) }} – {{ shortDate(wk.sun) }}</span>
          </h2>
          <ul v-if="weekList.length" class="wk-list">
            <li v-for="e in weekList" :key="e.id">
              <span class="wk-d">{{ relDay(e.sessionDate) }}</span>
              <span class="wk-dot" :style="{ background: isExternal(e) ? '#c3cecb' : e.color || 'var(--bk-teal)' }" />
              <span class="wk-name">{{ isExternal(e) ? '外部' : e.targetName }}</span>
              <span class="wk-what">{{ hhmm(e.startTime) }} {{ evtWhat(e) }}</span>
              <span
                v-if="isExternal(e)"
                class="pill mute"
                >外部</span
              >
              <span v-else-if="e.sessionStatus === '1'" class="pill mute">已上</span>
              <span v-else class="pill" :class="PREP_PILL[e.prepStatus]">
                {{ PREP_STATUS_LABEL[e.prepStatus] }}
              </span>
            </li>
          </ul>
          <div v-else-if="!calLoading" class="ov-empty">本周暂无排课</div>
        </section>

        <!-- 快捷入口（保留） -->
        <div class="dk-quick-grid">
          <div
            v-for="q in quickEntries"
            :key="q.path"
            class="dk-quick-card"
            @click="goQuick(q.path)"
          >
            <div class="dk-quick-title">{{ q.title }}</div>
            <div class="dk-quick-desc">{{ q.desc }}</div>
            <el-icon class="dk-quick-arrow"><ArrowRight /></el-icon>
          </div>
        </div>
      </div>
    </div>

    <!-- FP5 批量排课向导（复用，仅 import） -->
    <BatchScheduleWizard v-model:visible="wizardVisible" @submitted="reloadAll" />
  </div>
</template>

<style scoped>
.dk-overview {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

/* 顶部 */
.ov-head {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}
.ov-head-l {
  min-width: 0;
}
.ov-eyebrow {
  font-size: 12px;
  color: #8ba09a;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.ov-title {
  font-size: 20px;
  font-weight: 800;
  color: var(--bk-ink);
  margin: 4px 0 4px;
}
.ov-sub {
  font-size: 13px;
  color: #6b7a77;
  margin: 0;
}
.ov-head .el-button {
  margin-left: auto;
}

/* 两列栅格 */
.ov-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
@media (max-width: 1050px) {
  .ov-grid {
    grid-template-columns: 1fr;
  }
}
.ov-col {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

/* 卡片通用 */
.ov-card {
  background: #fff;
  border: 1px solid var(--bk-line);
  border-radius: 12px;
  padding: 16px 18px;
}
.ov-h2 {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 800;
  color: var(--bk-ink);
  margin: 0 0 12px;
}
.ov-tick {
  width: 4px;
  height: 15px;
  border-radius: 2px;
  background: var(--bk-teal);
  flex: none;
}
.ov-h2-sub {
  margin-left: auto;
  font-size: 12px;
  font-weight: 400;
  color: #8ba09a;
  font-variant-numeric: tabular-nums;
}
.ov-empty {
  padding: 20px 4px;
  text-align: center;
  color: #8ba09a;
  font-size: 12.5px;
}

/* FP1 今日时间线 */
.tl {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tl li {
  display: grid;
  grid-template-columns: 62px 12px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  padding: 9px 4px;
  border-top: 1px solid #eef3f1;
}
.tl li:first-child {
  border-top: none;
}
.tl li.ext {
  opacity: 0.6;
}
.tl-time {
  text-align: right;
  line-height: 1.35;
}
.tl-time b {
  display: block;
  font-size: 13px;
  color: var(--bk-ink);
  font-variant-numeric: tabular-nums;
}
.tl-time span {
  font-size: 11px;
  color: #8ba09a;
  font-variant-numeric: tabular-nums;
}
.tl-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  justify-self: center;
}
.tl-body {
  min-width: 0;
}
.tl-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
  color: var(--bk-ink);
  overflow: hidden;
}
.tl-desc {
  font-size: 11.5px;
  color: #8ba09a;
  margin-top: 2px;
}
.tl-act {
  justify-self: end;
}

/* FP2 待备条 */
.prep-strip {
  background: var(--bk-teal-soft);
  border: 1px solid #d9eae6;
  border-radius: 12px;
  padding: 12px 16px;
}
.ps-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ps-ic {
  color: var(--bk-teal-deep);
  display: inline-flex;
}
.ps-head b {
  font-size: 13px;
  color: var(--bk-teal-deep);
}
.ps-empty {
  padding: 10px 4px 2px;
  font-size: 12px;
  color: #8ba09a;
}
.ps-list {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ps-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  background: #fff;
  border-radius: 8px;
  cursor: pointer;
  font-size: 12.5px;
  transition: box-shadow 0.15s;
}
.ps-list li:hover {
  box-shadow: 0 1px 6px rgba(15, 118, 110, 0.12);
}
.ps-when {
  flex: none;
  width: 96px;
  color: #5f716d;
  font-variant-numeric: tabular-nums;
}
.ps-name {
  flex: none;
  font-weight: 700;
  color: var(--bk-ink);
}
.ps-what {
  flex: 1;
  min-width: 0;
  color: #5f716d;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* FP3 统计卡 */
.ov-stats {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}
.ov-stat {
  background: #fff;
  border: 1px solid var(--bk-line);
  border-radius: 12px;
  padding: 14px 16px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.ov-stat:hover {
  border-color: var(--bk-teal);
  box-shadow: 0 2px 8px rgba(15, 118, 110, 0.08);
}
.ov-stat.warm {
  background: #fdf7ee;
  border-color: #f2e2c6;
}
.ov-stat-v {
  font-size: 25px;
  font-weight: 800;
  color: var(--bk-teal);
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}
.ov-stat.warm .ov-stat-v {
  color: #b45309;
}
.ov-stat-v small {
  font-size: 12px;
  font-weight: 600;
  margin-left: 3px;
  color: #8ba09a;
}
.ov-stat-k {
  font-size: 12.5px;
  color: #6b7a77;
  margin-top: 3px;
}

/* FP4 本周课表 */
.wk-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.wk-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 2px;
  border-top: 1px solid #eef3f1;
  font-size: 12.5px;
}
.wk-list li:first-child {
  border-top: none;
}
.wk-d {
  flex: none;
  width: 66px;
  color: #5f716d;
  font-variant-numeric: tabular-nums;
}
.wk-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}
.wk-name {
  flex: none;
  font-weight: 700;
  color: var(--bk-ink);
}
.wk-what {
  flex: 1;
  min-width: 0;
  color: #5f716d;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

/* pill */
.pill {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  font-weight: 600;
  border-radius: 99px;
  padding: 1px 8px;
  line-height: 17px;
  white-space: nowrap;
  flex: none;
}
.pill.ok {
  color: var(--bk-teal-deep);
  background: var(--bk-teal-soft);
}
.pill.mid {
  color: #b45309;
  background: #fdf3e7;
}
.pill.todo {
  color: #ba3a2a;
  background: #fbeeec;
}
.pill.mute {
  color: #7d8f8b;
  background: #eef1f0;
}

/* 快捷入口（保留原样式） */
.dk-quick-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
}
.dk-quick-card {
  position: relative;
  background: #fff;
  border: 1px solid var(--bk-line);
  border-radius: 12px;
  padding: 14px 16px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.dk-quick-card:hover {
  border-color: var(--bk-teal);
  box-shadow: 0 2px 8px rgba(15, 118, 110, 0.08);
}
.dk-quick-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--bk-ink);
  margin-bottom: 4px;
}
.dk-quick-desc {
  font-size: 12px;
  color: #6b7a77;
  padding-right: 20px;
}
.dk-quick-arrow {
  position: absolute;
  right: 16px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--bk-teal);
  font-size: 14px;
}
</style>
