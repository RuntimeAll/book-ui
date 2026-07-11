<script setup lang="ts">
/**
 * PRD-C-213 排课总览（/desk/schedule）——对照设计稿「视图2·排课总览」(v-schedule)。
 *
 * FP7  排课月历：整月一次 getCalendar(start,end) 拉数据前端渲染 7×N 网格。
 * FP8  对象筛选 chips：前端过滤不重发请求；「外部占位」整体显隐。
 * FP9  批量排课向导：见 components/BatchScheduleWizard.vue。
 * FP10 接下来 7 天：getPrepTodo(7)；点行开场次详情抽屉。
 * FP11 冲突检测交互并入 FP9 向导。
 *
 * 红线：BE :8090 可能未起 —— 所有请求 try/catch 优雅空态，不白屏；id 全 string；
 * 枚举中文一律走 schedule.ts 的 *_LABEL 映射。
 */
import { computed, nextTick, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  getCalendar,
  getPrepTodo,
  PREP_STATUS_LABEL,
  SESSION_TYPE_LABEL,
} from '@/api/teacher/schedule'
import type {
  CalendarSessionVO,
  PrepTodoVO,
  PrepStatus,
  SessionStatus,
  SessionType,
} from '@/api/teacher/schedule'
import BatchScheduleWizard from './components/BatchScheduleWizard.vue'
import SessionDetailDrawer from './components/SessionDetailDrawer.vue'
import type { DrawerSession } from './components/SessionDetailDrawer.vue'

// ── 日期工具（避免时区漂移，纯字符串拼装）────────────────────────
function fmtDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const todayDate = new Date()
todayDate.setHours(0, 0, 0, 0)
const todayStr = fmtDate(todayDate)

// ── 当前展示月份 ────────────────────────────────────────────────
const year = ref(todayDate.getFullYear())
const month = ref(todayDate.getMonth() + 1) // 1-12
const monthLabel = computed(() => `${year.value} 年 ${month.value} 月`)

function shiftMonth(delta: number) {
  let m = month.value + delta
  let y = year.value
  if (m < 1) {
    m = 12
    y -= 1
  } else if (m > 12) {
    m = 1
    y += 1
  }
  year.value = y
  month.value = m
  expandedDays.value = new Set() // 换月收起所有展开格
  fetchCalendar()
}

// ── BUG：格子超 3 场只显示"还有 N 项"死文案无法查看 → 点击展开/收起 ────
const expandedDays = ref<Set<number>>(new Set())

function toggleExpand(day: number | null) {
  if (day === null) return
  const s = new Set(expandedDays.value)
  if (s.has(day)) s.delete(day)
  else s.add(day)
  expandedDays.value = s
}

function isExpanded(day: number | null): boolean {
  return day !== null && expandedDays.value.has(day)
}

/** 格子展示的事件：展开态（或导出中）= 全部，否则前 3 条 */
function visibleEvents(cell: Cell): CalEvent[] {
  if (cell.day !== null && (exporting.value || expandedDays.value.has(cell.day))) return cell.events
  return cell.events.slice(0, 3)
}

// ── 导出日历图片（发家长）────────────────────────────────────────
// 🔴 家长可见物红线：导出图自动隐藏备课状态点/备课图例（内部信息），并展开全部格子不藏场次。
const exporting = ref(false)
const calRef = ref<HTMLElement | null>(null)

async function exportImage() {
  if (exporting.value) return
  exporting.value = true
  const el = calRef.value
  // 🔴 确定性导出宽度：截图瞬间把日历卡固定成 1400px 再截，
  //    与视口/屏宽解耦（html2canvas 按视口克隆渲染，窄窗口会布局漂移裁掉右列）。
  const EXPORT_W = 1400
  const saved = el
    ? { position: el.style.position, top: el.style.top, left: el.style.left, width: el.style.width, zIndex: el.style.zIndex }
    : null
  try {
    if (!el) return
    await nextTick() // 等展开/隐藏内部标记渲染完成
    Object.assign(el.style, { position: 'fixed', top: '0', left: '0', width: `${EXPORT_W}px`, zIndex: '3000' })
    await nextTick() // 等固定宽度 reflow
    const { default: html2canvas } = await import('html2canvas')
    const canvas = await html2canvas(el, {
      backgroundColor: '#ffffff',
      scale: 2,
      width: EXPORT_W,
      height: el.scrollHeight,
      windowWidth: EXPORT_W + 100,
    })
    const a = document.createElement('a')
    a.href = canvas.toDataURL('image/png')
    a.download = `课表-${year.value}年${month.value}月.png`
    a.click()
    ElMessage.success('课表图片已导出')
  } catch (e) {
    console.warn('[schedule] 导出图片失败', e)
    ElMessage.error('导出失败，请重试')
  } finally {
    if (el && saved) Object.assign(el.style, saved)
    exporting.value = false
  }
}

// ── FP7 月历数据 ────────────────────────────────────────────────
const rawEvents = ref<CalendarSessionVO[]>([])
const calLoading = ref(false)
const calError = ref(false)

async function fetchCalendar() {
  calLoading.value = true
  calError.value = false
  const start = fmtDate(new Date(year.value, month.value - 1, 1))
  const end = fmtDate(new Date(year.value, month.value, 0))
  try {
    const data = await getCalendar({ start, end })
    rawEvents.value = Array.isArray(data) ? data : []
  } catch (e) {
    console.warn('[schedule] getCalendar 失败', e)
    rawEvents.value = []
    calError.value = true
  } finally {
    calLoading.value = false
  }
}

// 归一化事件
interface CalEvent {
  id: string
  targetId: string
  targetName: string
  color: string
  date: string
  start: string
  name: string
  title: string
  sessionType: SessionType
  sessionStatus: SessionStatus
  lessonLocked?: string
  prepStatus: PrepStatus
  externalTitle?: string
  lessonTitle?: string
  planLessonId?: string
  endTime: string
}

const normalized = computed<CalEvent[]>(() =>
  rawEvents.value.map((e) => {
    const isExt = e.sessionType === '3'
    const name = isExt ? e.externalTitle || '外部占位' : e.targetName
    const title = isExt
      ? name
      : `${e.targetName}${e.lessonTitle ? ' · ' + e.lessonTitle : ''}`
    return {
      id: e.id,
      targetId: e.targetId,
      targetName: e.targetName,
      color: e.color || '#7d8f8b',
      date: e.sessionDate,
      start: (e.startTime || '').slice(0, 5),
      endTime: (e.endTime || '').slice(0, 5),
      name,
      title,
      sessionType: e.sessionType,
      sessionStatus: e.sessionStatus,
      lessonLocked: e.lessonLocked,
      prepStatus: e.prepStatus,
      externalTitle: e.externalTitle,
      lessonTitle: e.lessonTitle,
      planLessonId: e.planLessonId,
    }
  }),
)

// ── FP8 对象筛选 chips ──────────────────────────────────────────
const activeTargetId = ref<'all' | string>('all')
const showExternal = ref(true)

// chips = 全部 + 各对象（非外部占位，distinct by targetId）+ 外部占位(存在才显)
const objectChips = computed(() => {
  const map = new Map<string, { id: string; name: string; color: string }>()
  for (const e of normalized.value) {
    if (e.sessionType === '3') continue
    if (!map.has(e.targetId)) {
      map.set(e.targetId, { id: e.targetId, name: e.targetName, color: e.color })
    }
  }
  return [...map.values()]
})
const hasExternal = computed(() => normalized.value.some((e) => e.sessionType === '3'))

function selectChip(id: 'all' | string) {
  activeTargetId.value = id
}

const filteredEvents = computed(() =>
  normalized.value.filter((e) => {
    const byTarget = activeTargetId.value === 'all' || e.targetId === activeTargetId.value
    const byExternal = e.sessionType !== '3' || showExternal.value
    return byTarget && byExternal
  }),
)

// 按日聚合（当前展示月，用日号做键）
const eventsByDay = computed(() => {
  const map: Record<number, CalEvent[]> = {}
  for (const e of filteredEvents.value) {
    const d = Number(e.date.slice(8, 10))
    if (!d) continue
    ;(map[d] ||= []).push(e)
  }
  for (const k in map) {
    map[k].sort((a, b) => a.start.localeCompare(b.start))
  }
  return map
})

// 网格 cells
interface Cell {
  day: number | null
  isToday: boolean
  events: CalEvent[]
}
const grid = computed<Cell[]>(() => {
  const first = new Date(year.value, month.value - 1, 1).getDay() // 0-6
  const days = new Date(year.value, month.value, 0).getDate()
  const isCurMonth =
    year.value === todayDate.getFullYear() && month.value === todayDate.getMonth() + 1
  const curDay = todayDate.getDate()
  const cells: Cell[] = []
  for (let i = 0; i < first; i++) cells.push({ day: null, isToday: false, events: [] })
  for (let d = 1; d <= days; d++) {
    cells.push({ day: d, isToday: isCurMonth && d === curDay, events: eventsByDay.value[d] || [] })
  }
  while (cells.length % 7 !== 0) cells.push({ day: null, isToday: false, events: [] })
  return cells
})

// 备课色点 class：'2'已备好=ok / '1'备课中=mid / '0'未备=todo（外部占位无点）
const PREP_DOT: Record<PrepStatus, string> = { '2': 'p-ok', '1': 'p-mid', '0': 'p-todo' }

function tint(hex: string, a: number): string {
  const h = (hex || '').replace('#', '')
  if (h.length < 6) return `rgba(125,143,139,${a})`
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${a})`
}
// BUG-003：已取消（'3'）/ 请假（'2'）场次灰显 + 删除线可辨，与外部占位同色调但加删除线区分语义；
// 已上（'1'）保持现有 tint 样式不动。
function isVoided(e: CalEvent): boolean {
  return e.sessionStatus === '2' || e.sessionStatus === '3'
}
function evtStyle(e: CalEvent) {
  if (e.sessionType === '3') {
    return {
      background: 'var(--el-fill-color-light)',
      color: '#7d8f8b',
      borderLeftColor: '#c3cecb',
      fontWeight: '500',
    }
  }
  if (isVoided(e)) {
    return {
      background: 'var(--el-fill-color-light)',
      color: '#9aa19d',
      borderLeftColor: '#c3cecb',
      fontWeight: '500',
      textDecoration: 'line-through',
    }
  }
  return { background: tint(e.color, 0.12), color: e.color, borderLeftColor: e.color }
}

// ── FP10 接下来 7 天 ────────────────────────────────────────────
const todoList = ref<PrepTodoVO[]>([])
const todoLoading = ref(false)

async function fetchTodo() {
  todoLoading.value = true
  try {
    const data = await getPrepTodo(7)
    todoList.value = Array.isArray(data) ? data : []
  } catch (e) {
    console.warn('[schedule] getPrepTodo 失败', e)
    todoList.value = []
  } finally {
    todoLoading.value = false
  }
}

const PREP_PILL: Record<PrepStatus, string> = { '2': 'ok', '1': 'mid', '0': 'todo' }

// BUG-006：右栏「接下来 7 天」收敛为「明天」——全站去 N 场待备大列表语义，只提示明天课程。
const tomorrowStr = computed(() => {
  const d = new Date(todayDate)
  d.setDate(d.getDate() + 1)
  return fmtDate(d)
})
const tomorrowTodoList = computed(() => todoList.value.filter((t) => t.sessionDate === tomorrowStr.value))

// ── 抽屉 / 向导 ─────────────────────────────────────────────────
const drawerVisible = ref(false)
const drawerSession = ref<DrawerSession | null>(null)

function openFromEvent(e: CalEvent) {
  if (e.sessionType === '3') {
    ElMessage.info('外部占位仅用于避冲突，无需备课')
    return
  }
  drawerSession.value = {
    id: e.id,
    targetName: e.targetName,
    color: e.color,
    date: e.date,
    start: e.start,
    end: e.endTime,
    sessionType: e.sessionType,
    sessionStatus: e.sessionStatus,
    prepStatus: e.prepStatus,
    title: e.lessonTitle || e.externalTitle,
    lessonLocked: e.lessonLocked,
    targetId: e.targetId,
    planLessonId: e.planLessonId,
  }
  drawerVisible.value = true
}

function openFromTodo(t: PrepTodoVO) {
  drawerSession.value = {
    id: t.id,
    targetName: t.targetName || '',
    color: '#0f766e',
    date: t.sessionDate,
    start: (t.startTime || '').slice(0, 5),
    end: (t.endTime || '').slice(0, 5),
    sessionType: t.sessionType,
    sessionStatus: undefined,
    prepStatus: t.prepStatus,
    title: t.lessonTitle,
    lessonLocked: undefined,
    targetId: t.targetId,
    planLessonId: t.planLessonId,
  }
  drawerVisible.value = true
}

const wizardVisible = ref(false)

function refreshAll() {
  fetchCalendar()
  fetchTodo()
}

onMounted(() => {
  fetchCalendar()
  fetchTodo()
})
</script>

<template>
  <div class="sc-page">
    <!-- 工具栏 -->
    <div class="sc-tb">
      <div class="sc-tb-head">
        <h1 class="sc-h1">排课总览</h1>
        <p class="sc-sub">全部学生的课在一张日历上 · 外部日程灰显避冲突</p>
      </div>
      <span class="sc-spacer" />
      <div class="sc-mon-nav">
        <button aria-label="上月" @click="shiftMonth(-1)">
          <el-icon><ArrowLeft /></el-icon>
        </button>
        <span class="sc-mon">{{ monthLabel }}</span>
        <button aria-label="下月" @click="shiftMonth(1)">
          <el-icon><ArrowRight /></el-icon>
        </button>
      </div>
      <el-button :loading="exporting" @click="exportImage">
        <el-icon v-if="!exporting" style="margin-right: 4px"><Download /></el-icon>
        导出图片
      </el-button>
      <el-button type="primary" @click="wizardVisible = true">
        <el-icon style="margin-right: 4px"><Plus /></el-icon>
        批量排课
      </el-button>
    </div>

    <!-- FP8 对象筛选 chips -->
    <div class="sc-chips">
      <button class="sc-fchip" :class="{ on: activeTargetId === 'all' }" @click="selectChip('all')">
        全部
      </button>
      <button
        v-for="c in objectChips"
        :key="c.id"
        class="sc-fchip"
        :class="{ on: activeTargetId === c.id }"
        @click="selectChip(c.id)"
      >
        <span class="sc-swatch" :style="{ background: c.color }" />{{ c.name }}
      </button>
      <button
        v-if="hasExternal"
        class="sc-fchip"
        :class="{ on: showExternal }"
        @click="showExternal = !showExternal"
      >
        <span class="sc-swatch" style="background: #7d8f8b" />外部占位
      </button>
    </div>

    <div class="sc-grid">
      <!-- FP7 月历 -->
      <div ref="calRef" class="sc-card sc-cal" :class="{ exporting }" v-loading="calLoading">
        <!-- 导出图片时的标题（家长看到的第一行），平时不显示 -->
        <div v-if="exporting" class="sc-export-title">{{ monthLabel }} 课表</div>
        <div class="sc-cal-head">
          <div v-for="w in WEEK_CN" :key="w">{{ w }}</div>
        </div>
        <div class="sc-cal-body">
          <div
            v-for="(cell, i) in grid"
            :key="i"
            class="sc-cell"
            :class="{ off: cell.day === null, today: cell.isToday }"
          >
            <template v-if="cell.day !== null">
              <div class="sc-dnum">
                <span v-if="cell.isToday">{{ cell.day }}</span>
                <template v-else>{{ cell.day }}</template>
              </div>
              <div
                v-for="e in visibleEvents(cell)"
                :key="e.id"
                class="sc-evt"
                :style="evtStyle(e)"
                :title="e.title"
                @click="openFromEvent(e)"
              >
                <time v-if="e.start">{{ e.start }}<template v-if="e.endTime">-{{ e.endTime }}</template></time>
                <span class="sc-evt-name">{{ e.name }}</span>
                <span v-if="e.sessionStatus === '2'" class="sc-void-pill">请假</span>
                <span v-else-if="e.sessionStatus === '3'" class="sc-void-pill">已取消</span>
                <span
                  v-else-if="e.sessionType !== '3'"
                  class="sc-pdot"
                  :class="PREP_DOT[e.prepStatus]"
                />
              </div>
              <button
                v-if="cell.events.length > 3"
                class="sc-evt-more"
                type="button"
                @click.stop="toggleExpand(cell.day)"
              >
                {{ isExpanded(cell.day) ? '收起 ▲' : `还有 ${cell.events.length - 3} 项 ▼` }}
              </button>
            </template>
          </div>
        </div>
        <div class="sc-cal-foot">
          <span v-for="c in objectChips" :key="c.id" class="sc-lg">
            <span class="sc-lg-sw" :style="{ background: c.color }" />{{ c.name }}
          </span>
          <span v-if="hasExternal" class="sc-lg">
            <span class="sc-lg-sw" style="background: #c3cecb" />外部占位（不参与备课）
          </span>
          <span class="sc-lg sc-lg-prep">
            备课状态
            <span class="sc-lg-dot p-ok" />已备好
            <span class="sc-lg-dot p-mid" />备课中
            <span class="sc-lg-dot p-todo" />未备课
          </span>
        </div>
        <div v-if="calError && !calLoading" class="sc-empty">暂时拉不到排课数据，请稍后重试</div>
      </div>

      <!-- 右栏 -->
      <div class="sc-rail">
        <!-- FP10 明天（BUG-006：由「接下来 7 天」收敛，去催备大列表语义） -->
        <div class="sc-card sc-rail-card" v-loading="todoLoading">
          <h2 class="sc-h2"><span class="sc-tick" />明天</h2>
          <ul v-if="tomorrowTodoList.length" class="sc-up-list">
            <li v-for="t in tomorrowTodoList" :key="t.id" @click="openFromTodo(t)">
              <span class="sc-up-when">
                <b>{{ (t.startTime || '').slice(0, 5) }}</b>
              </span>
              <span class="sc-up-bar" style="background: var(--bk-teal)" />
              <span class="sc-up-body">
                <b>{{ t.targetName || '未命名对象' }}</b>
                <span>{{ t.lessonTitle || SESSION_TYPE_LABEL[t.sessionType] }}</span>
              </span>
              <span class="sc-pill" :class="PREP_PILL[t.prepStatus]">
                {{ PREP_STATUS_LABEL[t.prepStatus] }}
              </span>
            </li>
          </ul>
          <div v-else-if="!todoLoading" class="sc-rail-empty">明天暂无排课</div>
        </div>

        <!-- FP11 冲突说明卡 -->
        <div class="sc-card sc-hint">
          <div class="sc-hint-ok">
            <el-icon><CircleCheck /></el-icon>
            排课自动查冲突
          </div>
          <p>
            批量排课提交前自动检查两类冲突：<b>老师撞场</b>（我的两场课时间重叠）与<b>学生撞场</b
            >（学生自己的外部日程重叠）。命中冲突会弹窗列明细，可选择避开或仍然保存。
          </p>
        </div>
      </div>
    </div>

    <!-- FP9 批量排课向导 -->
    <BatchScheduleWizard v-model:visible="wizardVisible" @submitted="refreshAll" />

    <!-- 场次详情抽屉 -->
    <SessionDetailDrawer
      v-model:visible="drawerVisible"
      :session="drawerSession"
      @changed="refreshAll"
    />
  </div>
</template>

<style scoped>
.sc-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* 工具栏 */
.sc-tb {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.sc-h1 {
  font-size: 19px;
  font-weight: 800;
  color: var(--bk-ink);
  margin: 0;
}
.sc-sub {
  font-size: 13px;
  color: #5f716d;
  margin: 2px 0 0;
}
.sc-spacer {
  flex: 1;
}
.sc-mon-nav {
  display: flex;
  align-items: center;
  gap: 2px;
  background: #fff;
  border: 1px solid var(--bk-line);
  border-radius: 9px;
  padding: 2px;
}
.sc-mon-nav button {
  display: inline-flex;
  align-items: center;
  padding: 5px 9px;
  border: none;
  background: none;
  border-radius: 7px;
  color: #5f716d;
  cursor: pointer;
}
.sc-mon-nav button:hover {
  background: var(--bk-teal-soft);
  color: var(--bk-teal);
}
.sc-mon {
  font-weight: 800;
  font-size: 14px;
  padding: 0 10px;
  font-variant-numeric: tabular-nums;
  color: var(--bk-ink);
}

/* chips */
.sc-chips {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.sc-fchip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 99px;
  border: 1px solid var(--bk-line);
  background: #fff;
  font-size: 12.5px;
  font-weight: 600;
  color: #5f716d;
  cursor: pointer;
}
.sc-fchip.on {
  border-color: var(--bk-teal);
  color: var(--bk-teal-deep);
  background: var(--bk-teal-soft);
}
.sc-swatch {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

/* grid */
.sc-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 292px;
  gap: 16px;
  align-items: start;
}
@media (max-width: 1150px) {
  .sc-grid {
    grid-template-columns: 1fr;
  }
}
.sc-card {
  background: #fff;
  border: 1px solid var(--bk-line);
  border-radius: 12px;
}
.sc-cal {
  overflow: hidden;
  position: relative;
}
.sc-cal-head {
  display: grid;
  /* minmax(0,1fr)：钉死 7 列等宽，长内容不许撑爆列（1fr 的隐式 min=内容宽会挤裁最右列） */
  grid-template-columns: repeat(7, minmax(0, 1fr));
  border-bottom: 1px solid var(--bk-line);
}
.sc-cal-head div {
  padding: 9px 12px;
  font-size: 12px;
  font-weight: 700;
  color: #8ba09a;
  letter-spacing: 0.08em;
  text-align: right;
}
.sc-cal-body {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
}
.sc-cell {
  min-height: 104px;
  /* 样式修：格线加深（原 #eef3f1 太浅不明显） */
  border-top: 1px solid #c9d6d2;
  border-left: 1px solid #c9d6d2;
  padding: 7px 7px 8px;
  position: relative;
}
.sc-cal-body .sc-cell:nth-child(7n + 1) {
  border-left: none;
}
.sc-cell.off {
  background: #fafcfb;
}
.sc-dnum {
  /* 样式修：日期数字加大加粗（原 14px/常规 不醒目） */
  font-size: 17px;
  font-weight: 800;
  color: var(--bk-ink);
  text-align: right;
  line-height: 1;
  margin-bottom: 6px;
  font-variant-numeric: tabular-nums;
}
.sc-cell.today {
  background: var(--bk-teal-soft);
}
.sc-cell.today .sc-dnum span {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--bk-teal);
  color: #fff;
  font-weight: 800;
}
.sc-evt {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  line-height: 1.35;
  border-radius: 5px;
  padding: 2.5px 6px;
  margin-bottom: 3px;
  cursor: pointer;
  border-left: 3px solid transparent;
  overflow: hidden;
  white-space: nowrap;
  font-weight: 600;
}
.sc-evt time {
  font-variant-numeric: tabular-nums;
  opacity: 0.75;
  font-weight: 500;
  flex: none;
  /* 起止时间共显（08:00-09:30）比单开始时间长，字号微缩保证学生名可见 */
  font-size: 10px;
}
.sc-evt-name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.sc-pdot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
  margin-left: auto;
}
.sc-pdot.p-ok {
  background: var(--bk-teal);
}
.sc-pdot.p-mid {
  background: #b45309;
}
.sc-pdot.p-todo {
  background: #ba3a2a;
}
.sc-void-pill {
  margin-left: auto;
  flex: none;
  font-size: 9.5px;
  font-weight: 700;
  padding: 0 5px;
  line-height: 14px;
  border-radius: 99px;
  background: #eef1f0;
  color: #7d8f8b;
  text-decoration: none;
}
.sc-evt-more {
  /* BUG 修：由死文案改为可点击的展开/收起按钮 */
  display: block;
  width: 100%;
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  color: var(--bk-teal-deep);
  padding: 2px 0 2px 8px;
  border: none;
  background: none;
  border-radius: 5px;
  cursor: pointer;
}
.sc-evt-more:hover {
  background: var(--bk-teal-soft);
}

/* ── 导出图片模式：隐藏内部信息（备课状态点/备课图例/展开按钮），家长可见物红线 ── */
.sc-cal.exporting .sc-pdot,
.sc-cal.exporting .sc-lg-prep,
.sc-cal.exporting .sc-evt-more {
  display: none;
}
.sc-export-title {
  padding: 14px 14px 4px;
  font-size: 18px;
  font-weight: 800;
  color: var(--bk-ink);
  text-align: center;
}
.sc-cal-foot {
  display: flex;
  gap: 16px;
  align-items: center;
  padding: 10px 14px;
  border-top: 1px solid var(--bk-line);
  font-size: 11.5px;
  color: #5f716d;
  flex-wrap: wrap;
}
.sc-lg {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.sc-lg-prep {
  margin-left: auto;
}
.sc-lg-sw {
  width: 9px;
  height: 9px;
  border-radius: 3px;
}
.sc-lg-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.sc-lg-dot.p-ok {
  background: var(--bk-teal);
}
.sc-lg-dot.p-mid {
  background: #b45309;
}
.sc-lg-dot.p-todo {
  background: #ba3a2a;
}
.sc-empty {
  padding: 24px;
  text-align: center;
  font-size: 13px;
  color: #8ba09a;
}

/* 右栏 */
.sc-rail {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.sc-rail-card {
  padding: 15px 16px;
}
.sc-h2 {
  font-size: 13.5px;
  font-weight: 800;
  color: var(--bk-ink);
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 10px;
}
.sc-tick {
  width: 4px;
  height: 14px;
  border-radius: 2px;
  background: var(--bk-teal);
  flex: none;
}
.sc-up-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.sc-up-list li {
  display: flex;
  gap: 10px;
  padding: 8px 0;
  border-top: 1px solid #eef3f1;
  font-size: 12.5px;
  align-items: center;
  cursor: pointer;
}
.sc-up-list li:first-child {
  border-top: none;
  padding-top: 2px;
}
.sc-up-list li:hover {
  background: var(--bk-teal-soft);
  border-radius: 6px;
}
.sc-up-when {
  width: 74px;
  flex: none;
  color: #5f716d;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
}
.sc-up-when b {
  display: block;
  color: var(--bk-ink);
  font-size: 12.5px;
}
.sc-up-bar {
  width: 4px;
  align-self: stretch;
  border-radius: 2px;
  flex: none;
}
.sc-up-body {
  flex: 1;
  min-width: 0;
}
.sc-up-body b {
  font-size: 12.5px;
  color: var(--bk-ink);
}
.sc-up-body span {
  display: block;
  color: #5f716d;
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sc-rail-empty {
  padding: 18px 4px;
  font-size: 12.5px;
  color: #8ba09a;
  text-align: center;
}
.sc-pill {
  display: inline-flex;
  align-items: center;
  font-size: 11.5px;
  font-weight: 600;
  border-radius: 99px;
  padding: 1px 9px;
  line-height: 18px;
  white-space: nowrap;
  flex: none;
}
.sc-pill.ok {
  color: var(--bk-teal-deep);
  background: var(--bk-teal-soft);
}
.sc-pill.mid {
  color: #b45309;
  background: #fdf3e7;
}
.sc-pill.todo {
  color: #ba3a2a;
  background: #fbeeec;
}
.sc-hint {
  padding: 15px 16px;
  background: var(--bk-teal-soft);
  border-color: #d9eae6;
}
.sc-hint-ok {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 700;
  color: var(--bk-teal-deep);
  margin-bottom: 6px;
}
.sc-hint p {
  font-size: 12px;
  color: #5f716d;
  line-height: 1.7;
  margin: 0;
}
.sc-hint p b {
  color: var(--bk-teal-deep);
}
</style>
