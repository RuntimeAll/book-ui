<script setup lang="ts">
/**
 * PRD-015 批5 · /m/schedule 课表总览（手机日历式，V20）。
 *
 * 数据源 = 桌面端排课总览同一个接口 `getCalendar(start,end)`（D14「系统排课总览的移动化」），
 * 不另造移动专用端点、不塞假数据——桌面端改数据这边刷新即同步。
 * 版式：月网格（周一起）+ 有课日按学生色点标 + 今天实心 + 点日期下方展开当天场次全览；
 *       「回今天」一键回位；‹ › 月切换；点「待结算」场次跳 /m/settle。
 * 🔴 BE 未就绪/网络失败 → 空态兜底不白屏（沿桌面端 schedule/index.vue 的 try-catch 口径）。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { getCalendar, type CalendarSessionVO } from '@/api/teacher/schedule'
import { cnDay, fmtDate, hhmm, isPending, sessionChip, todayStr } from './shared'

const router = useRouter()

const WEEK_CN = ['一', '二', '三', '四', '五', '六', '日']

const today = todayStr()
const initial = new Date()
const year = ref(initial.getFullYear())
const month = ref(initial.getMonth() + 1) // 1-12
const selDate = ref(today)

const events = ref<CalendarSessionVO[]>([])
const loading = ref(false)
const failed = ref(false)

const monthLabel = computed(() => `${year.value} 年 ${month.value} 月`)

async function fetchMonth() {
  loading.value = true
  failed.value = false
  const start = fmtDate(new Date(year.value, month.value - 1, 1))
  const end = fmtDate(new Date(year.value, month.value, 0))
  try {
    const data = await getCalendar({ start, end })
    events.value = Array.isArray(data) ? data : []
  } catch (e) {
    console.warn('[m/schedule] getCalendar 失败', e)
    events.value = []
    failed.value = true
  } finally {
    loading.value = false
  }
}

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
  // 换月：选中日跟到该月 1 号（若正好是今天所在月则选今天）
  selDate.value =
    y === initial.getFullYear() && m === initial.getMonth() + 1 ? today : fmtDate(new Date(y, m - 1, 1))
  void fetchMonth()
}

function backToToday() {
  const needFetch = year.value !== initial.getFullYear() || month.value !== initial.getMonth() + 1
  year.value = initial.getFullYear()
  month.value = initial.getMonth() + 1
  selDate.value = today
  if (needFetch) void fetchMonth()
}

/** 场次名（外部占位没有学生，走 externalTitle） */
function nameOf(e: CalendarSessionVO): string {
  return e.sessionType === '3' ? e.externalTitle || '外部占位' : e.targetName
}

// 按日聚合
const byDate = computed(() => {
  const map: Record<string, CalendarSessionVO[]> = {}
  for (const e of events.value) {
    ;(map[e.sessionDate] ||= []).push(e)
  }
  for (const k in map) {
    map[k].sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''))
  }
  return map
})

interface DayCell {
  date: string | null
  day: number | null
  isToday: boolean
  /** 当天有课学生的颜色（去重，最多 3 点，V20/G9：点数=当日场次学生数） */
  dots: string[]
}

const grid = computed<DayCell[]>(() => {
  const first = new Date(year.value, month.value - 1, 1)
  // 周一起始：JS getDay() 0=周日 → 前导空格数 = (getDay()+6)%7
  const lead = (first.getDay() + 6) % 7
  const days = new Date(year.value, month.value, 0).getDate()
  const cells: DayCell[] = []
  for (let i = 0; i < lead; i++) cells.push({ date: null, day: null, isToday: false, dots: [] })
  for (let d = 1; d <= days; d++) {
    const date = fmtDate(new Date(year.value, month.value - 1, d))
    const list = byDate.value[date] || []
    const seen = new Map<string, string>()
    for (const e of list) {
      const key = e.sessionType === '3' ? `ext:${e.id}` : e.targetId
      if (!seen.has(key)) seen.set(key, e.color || '#7d8f8b')
    }
    cells.push({ date, day: d, isToday: date === today, dots: [...seen.values()].slice(0, 3) })
  }
  while (cells.length % 7 !== 0) cells.push({ date: null, day: null, isToday: false, dots: [] })
  return cells
})

const rows = computed<DayCell[][]>(() => {
  const out: DayCell[][] = []
  const g = grid.value
  for (let i = 0; i < g.length; i += 7) out.push(g.slice(i, i + 7))
  return out
})

const daySessions = computed(() => byDate.value[selDate.value] || [])

function chipOf(e: CalendarSessionVO) {
  return sessionChip(e.sessionStatus, e.settleStatus, isPending(e.sessionStatus, e.settleStatus, e.sessionDate, e.endTime))
}

function pendingOf(e: CalendarSessionVO): boolean {
  return isPending(e.sessionStatus, e.settleStatus, e.sessionDate, e.endTime)
}

function onSlotClick(e: CalendarSessionVO) {
  if (pendingOf(e)) router.push('/m/settle')
}

onMounted(fetchMonth)
</script>

<template>
  <section>
    <div class="m-calhead">
      <button class="nav" aria-label="上一月" @click="shiftMonth(-1)">‹</button>
      <span class="m">{{ monthLabel }}</span>
      <button class="nav" aria-label="下一月" @click="shiftMonth(1)">›</button>
      <button class="today-btn" @click="backToToday">回今天</button>
    </div>

    <div class="m-cal">
      <div class="m-calwk"><span v-for="w in WEEK_CN" :key="w">{{ w }}</span></div>
      <div v-for="(row, ri) in rows" :key="ri" class="m-calrow">
        <span
          v-for="(c, ci) in row"
          :key="ci"
          class="m-day"
          :class="{ blank: !c.day, today: c.isToday, sel: !!c.date && c.date === selDate }"
          :role="c.day ? 'button' : undefined"
          :tabindex="c.day ? 0 : undefined"
          @click="c.date && (selDate = c.date)"
          @keyup.enter="c.date && (selDate = c.date)"
        >
          <span v-if="c.day" class="n">{{ c.day }}</span>
          <span v-if="c.dots.length" class="dots">
            <i v-for="(color, di) in c.dots" :key="di" :style="{ background: color }" />
          </span>
        </span>
      </div>
    </div>

    <div class="m-daylist">
      <div class="dhead">
        <span class="d">{{ cnDay(selDate) }}{{ selDate === today ? ' · 今天' : '' }}</span>
        <span class="c">{{ daySessions.length ? `${daySessions.length} 场` : '无排课' }}</span>
      </div>
      <div class="m-card">
        <div v-if="loading" class="m-empty">加载中…</div>
        <div v-else-if="failed" class="m-empty">课表暂时取不到，稍后下拉重试</div>
        <div v-else-if="!daySessions.length" class="m-empty">这天没有排课</div>
        <template v-else>
          <div
            v-for="e in daySessions"
            :key="e.id"
            class="m-slot"
            :role="pendingOf(e) ? 'button' : undefined"
            :tabindex="pendingOf(e) ? 0 : undefined"
            @click="onSlotClick(e)"
            @keyup.enter="onSlotClick(e)"
          >
            <span class="clr" :style="{ background: e.color || '#7d8f8b' }" />
            <span class="tm">{{ hhmm(e.startTime) }}–{{ hhmm(e.endTime) }}</span>
            <span class="body">
              <span class="nm">{{ nameOf(e) }}</span>
              <span v-if="e.subjectLabel" class="m-chip subj">{{ e.subjectLabel }}</span>
              <span class="ls">{{ e.lessonTitle || e.externalTitle || '—' }}</span>
            </span>
            <span class="st">
              <span class="m-chip" :class="chipOf(e).cls">{{ chipOf(e).text }}</span>
            </span>
          </div>
        </template>
      </div>
    </div>

    <p class="m-note">点日期看当天全览；批量排课 / 改期等重操作在电脑端完成。</p>
  </section>
</template>
