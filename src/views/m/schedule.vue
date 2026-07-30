<script setup lang="ts">
/**
 * PRD-015 · /m/schedule 课表总览（手机日历式，V20）—— **Vant 4 版**。
 *
 * 数据源 = 桌面端排课总览同一个接口 `getCalendar(start,end)`（D14「系统排课总览的移动化」），
 * 不另造移动专用端点、不塞假数据——桌面端改数据这边刷新即同步。
 *
 * 🔴 2026-07-31 Vant 化的取舍（月历走哪条路）：**用 van-calendar 平铺 + day 插槽**，不再自绘网格。
 *    能走通是因为它三样都给全了：
 *      ① `switch-mode="month"` = 单月面板 + 内建 ‹ › 月切换 + `@panel-change` 告诉我换到哪个月拉数据
 *      ② `#bottom-info` 插槽 = 每格底部塞学生色点（原自绘的 .dots 一比一搬过来）
 *      ③ `formatter` = 给「今天」挂 className 做高亮；选中日的实心块由 Vant 自己画
 *    唯一要压的是它平铺模式 `height:100%` 的假设（mobile.css 里两行改成按内容高）。
 *    换来的是：手感/触区/滚动/无障碍全是框架的，不用再自己维护 7 列网格与前导空格。
 * 🔴 业务口径一字未动：byDate 聚合、色点去重取前 3、sessionChip/isPending、点待结算跳 /m/settle。
 * 🔴 BE 未就绪/网络失败 → 空态兜底不白屏（沿桌面端 schedule/index.vue 的 try-catch 口径）。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { CalendarDayItem } from 'vant'
import { getCalendar, type CalendarSessionVO } from '@/api/teacher/schedule'
import { chipTagType, cnDay, fmtDate, hhmm, isPending, sessionChip, todayStr } from './shared'

const router = useRouter()

const today = todayStr()
const initial = new Date()
const year = ref(initial.getFullYear())
const month = ref(initial.getMonth() + 1) // 1-12
const selDate = ref(today)
/** 传给 van-calendar 的选中日（它只吃 Date 对象） */
const selDateObj = ref<Date>(new Date(initial.getFullYear(), initial.getMonth(), initial.getDate()))
/** 面板可切换范围：前后各 3 年足够教务用，超出无意义 */
const minDate = new Date(initial.getFullYear() - 3, 0, 1)
const maxDate = new Date(initial.getFullYear() + 3, 11, 31)

const events = ref<CalendarSessionVO[]>([])
const loading = ref(false)
const failed = ref(false)

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

/** 换到某天：同步「选中日」的三份表示（字符串给列表、Date 给日历、年月给取数） */
function gotoDate(d: Date) {
  year.value = d.getFullYear()
  month.value = d.getMonth() + 1
  selDate.value = fmtDate(d)
  selDateObj.value = d
}

/** van-calendar 的月切换（‹ ›）：换月 → 选中日跟到该月（本月则回今天）→ 重新取数 */
function onPanelChange(payload: { date: Date }) {
  const d = payload.date
  const sameAsNow = d.getFullYear() === initial.getFullYear() && d.getMonth() === initial.getMonth()
  gotoDate(sameAsNow ? new Date(initial.getFullYear(), initial.getMonth(), initial.getDate()) : new Date(d.getFullYear(), d.getMonth(), 1))
  void fetchMonth()
}

function onSelect(d: Date) {
  const needFetch = d.getFullYear() !== year.value || d.getMonth() + 1 !== month.value
  gotoDate(d)
  if (needFetch) void fetchMonth()
}

function backToToday() {
  const needFetch = year.value !== initial.getFullYear() || month.value !== initial.getMonth() + 1
  gotoDate(new Date(initial.getFullYear(), initial.getMonth(), initial.getDate()))
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

/** 当天有课学生的颜色（去重，最多 3 点，V20/G9：点数=当日场次学生数） */
function dotsOf(date: string): string[] {
  const list = byDate.value[date] || []
  const seen = new Map<string, string>()
  for (const e of list) {
    const key = e.sessionType === '3' ? `ext:${e.id}` : e.targetId
    if (!seen.has(key)) seen.set(key, e.color || '#7d8f8b')
  }
  return [...seen.values()].slice(0, 3)
}

/**
 * 日格装饰器：只给「今天」挂 className。
 * 🔴 故意做成 computed 返回函数 —— events 变了 formatter 的**引用**才会变，
 *    CalendarMonth 才会重渲染把新色点画出来（不然要靠 :key 整体重挂，会闪且丢选中态）。
 */
const dayFormatter = computed(() => {
  void events.value
  return (day: CalendarDayItem): CalendarDayItem => {
    if (day.date && fmtDate(day.date) === today) {
      day.className = `${day.className || ''} m-cal-today`.trim()
    }
    return day
  }
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
    <div class="m-cal">
      <van-calendar
        :poppable="false"
        :show-title="false"
        :show-mark="false"
        :show-confirm="false"
        switch-mode="month"
        :first-day-of-week="1"
        :min-date="minDate"
        :max-date="maxDate"
        :default-date="selDateObj"
        :formatter="dayFormatter"
        :row-height="46"
        @select="onSelect"
        @panel-change="onPanelChange"
      >
        <template #bottom-info="item">
          <span v-if="item.date && dotsOf(fmtDate(item.date)).length" class="m-caldots">
            <i v-for="(c, i) in dotsOf(fmtDate(item.date))" :key="i" :style="{ background: c }" />
          </span>
        </template>
      </van-calendar>
    </div>

    <van-cell-group inset>
      <van-cell :title="cnDay(selDate) + (selDate === today ? ' · 今天' : '')" value-class="m-vnarrow">
        <template #value>
          <span class="m-muted">{{ daySessions.length ? `${daySessions.length} 场` : '无排课' }}</span>
        </template>
      </van-cell>

      <van-loading v-if="loading" class="m-note" size="18">加载中…</van-loading>
      <van-empty v-else-if="failed" image="error" image-size="70" description="课表暂时取不到，稍后重试">
        <van-button round type="primary" size="small" @click="fetchMonth">重新加载</van-button>
      </van-empty>
      <van-empty v-else-if="!daySessions.length" image="search" image-size="70" description="这天没有排课" />
      <template v-else>
        <van-cell
          v-for="e in daySessions"
          :key="e.id"
          class="m-slotcell"
          :is-link="pendingOf(e)"
          :clickable="pendingOf(e)"
          @click="onSlotClick(e)"
        >
          <template #title>
            <span class="m-slotclr" :style="{ background: e.color || '#7d8f8b' }" />
            <span class="m-slottime">{{ hhmm(e.startTime) }}–{{ hhmm(e.endTime) }}</span>
            <span style="min-width: 0; flex: 1">
              <span class="m-rowtitle">
                <b>{{ nameOf(e) }}</b>
                <van-tag v-if="e.subjectLabel" type="primary" plain>{{ e.subjectLabel }}</van-tag>
                <van-tag :type="chipTagType(chipOf(e).cls)" :plain="chipOf(e).cls === 'plain'">
                  {{ chipOf(e).text }}
                </van-tag>
              </span>
              <span class="m-note" style="display: block; margin: 2px 0 0">
                {{ e.lessonTitle || e.externalTitle || '—' }}
              </span>
            </span>
          </template>
        </van-cell>
      </template>
    </van-cell-group>

    <p class="m-note">点日期看当天全览；批量排课 / 改期等重操作在电脑端完成。</p>
    <div style="text-align: center; margin-top: 10px">
      <van-button round size="small" type="primary" plain icon="aim" @click="backToToday">
        回今天
      </van-button>
    </div>
  </section>
</template>
