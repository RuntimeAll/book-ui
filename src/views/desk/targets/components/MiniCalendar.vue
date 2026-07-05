<script setup lang="ts">
/**
 * PRD-C-213 FP15 · 迷你月历（详情面板内自绘小组件）。
 * 纯前端渲染：由该对象场次日期集合驱动——有课日 = 对象色块、今天 = 描边。
 * 无独立接口，数据来自父级已拉的场次表。自动按场次覆盖的月份逐月渲染。
 */
import { computed } from 'vue'
import { parseDate, FALLBACK_COLOR } from '../helpers'

const props = defineProps<{
  /** 场次日期数组（YYYY-MM-DD） */
  dates: string[]
  /** 对象色（有课日方块底色） */
  color?: string
}>()

const WEEK_H = ['日', '一', '二', '三', '四', '五', '六']

interface MonthCell {
  day: number
  dateStr: string
  has: boolean
  today: boolean
  blank: boolean
}
interface MonthBlock {
  key: string
  title: string
  cells: MonthCell[]
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

const themeColor = computed(() => props.color || FALLBACK_COLOR)

const months = computed<MonthBlock[]>(() => {
  const hasSet = new Set<string>()
  const monthKeys = new Set<string>()
  for (const ds of props.dates) {
    const d = parseDate(ds)
    if (!d) continue
    hasSet.add(ymd(d.getFullYear(), d.getMonth(), d.getDate()))
    monthKeys.add(`${d.getFullYear()}-${d.getMonth()}`)
  }
  // 无课时兜底展示当月
  if (monthKeys.size === 0) {
    const n = new Date()
    monthKeys.add(`${n.getFullYear()}-${n.getMonth()}`)
  }
  const now = new Date()
  const todayStr = ymd(now.getFullYear(), now.getMonth(), now.getDate())

  const blocks: MonthBlock[] = []
  const sorted = [...monthKeys].sort((a, b) => {
    const [ay, am] = a.split('-').map(Number)
    const [by, bm] = b.split('-').map(Number)
    return ay !== by ? ay - by : am - bm
  })
  for (const key of sorted) {
    const [y, m] = key.split('-').map(Number)
    const firstDow = new Date(y, m, 1).getDay()
    const daysInMonth = new Date(y, m + 1, 0).getDate()
    const cells: MonthCell[] = []
    for (let i = 0; i < firstDow; i++) {
      cells.push({ day: 0, dateStr: '', has: false, today: false, blank: true })
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = ymd(y, m, d)
      cells.push({
        day: d,
        dateStr: ds,
        has: hasSet.has(ds),
        today: ds === todayStr,
        blank: false,
      })
    }
    blocks.push({ key, title: `${y} 年 ${m + 1} 月`, cells })
  }
  return blocks
})
</script>

<template>
  <div class="mini-rail">
    <div v-for="mb in months" :key="mb.key" class="mini-cal">
      <div class="mc-t">
        <span>{{ mb.title }}</span>
      </div>
      <div class="mc-grid">
        <div v-for="h in WEEK_H" :key="'h' + h" class="mc-h">{{ h }}</div>
        <div
          v-for="(c, i) in mb.cells"
          :key="mb.key + '-' + i"
          class="mc-d"
          :class="{ has: c.has, today: c.today, blank: c.blank }"
          :style="c.has ? { background: themeColor, borderColor: themeColor } : {}"
          :title="c.dateStr"
        >
          {{ c.blank ? '' : c.day }}
        </div>
      </div>
    </div>
    <div class="mini-legend">
      <span class="lg"><span class="swatch" :style="{ background: themeColor }"></span>有课日</span>
      <span class="lg"><span class="dot"></span>今天</span>
    </div>
  </div>
</template>

<style scoped>
.mini-rail {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.mini-cal .mc-t {
  font-size: 12.5px;
  font-weight: 800;
  color: var(--bk-ink);
  margin-bottom: 8px;
}
.mc-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
  font-size: 11px;
  text-align: center;
}
.mc-h {
  color: #8ba09a;
  font-weight: 600;
  padding: 2px 0;
}
.mc-d {
  font-family: Georgia, 'Times New Roman', serif;
  font-variant-numeric: tabular-nums;
  color: #5f716d;
  aspect-ratio: 1;
  display: grid;
  place-items: center;
  border-radius: 6px;
  border: 2px solid transparent;
}
.mc-d.blank {
  visibility: hidden;
}
.mc-d.has {
  color: #fff;
  font-weight: 700;
}
.mc-d.today {
  outline: 2px solid var(--bk-teal);
  outline-offset: -2px;
  font-weight: 700;
  color: var(--bk-teal-deep);
}
.mc-d.has.today {
  outline-color: #fff;
  color: #fff;
}
.mini-legend {
  font-size: 11px;
  color: #8ba09a;
  display: flex;
  gap: 12px;
}
.lg {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.lg .swatch {
  width: 9px;
  height: 9px;
  border-radius: 3px;
}
.lg .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 2px solid var(--bk-teal);
  background: none;
}
</style>
