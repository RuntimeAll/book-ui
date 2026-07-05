<script setup lang="ts">
/**
 * PRD-C-213 FP24 上次课回收侧卡（只读摘要）。
 * 该对象最近一个「已上」场次（status='1'）的回收摘要：对/错统计 + 错因 chips + 复练建议文案。
 * 无回收记录 → 「暂无回收记录」。
 */
import { computed } from 'vue'
import { type ReviewVO } from '@/api/teacher/schedule'
import { shortDate } from '../../targets/helpers'

const props = defineProps<{
  review: ReviewVO | null
  /** 上次课场次日期（YYYY-MM-DD） */
  sessionDate?: string
  loading?: boolean
  /** 该对象无任何已上场次时置 true（区分「无场次」与「有场次无回收」） */
  noSession?: boolean
}>()

const r = computed(() => props.review)

const stats = computed(() => {
  const items = r.value?.itemResults ?? []
  const total = items.length
  const right = items.filter((i) => i.result === '对').length
  const wrong = items.filter((i) => i.result === '错').length
  const stuck = items.filter((i) => i.result === '卡').length
  return { total, right, wrong, stuck }
})

// 错因 chips（错/卡 题的 cause 去重）
const causes = computed<string[]>(() => {
  const set = new Set<string>()
  ;(r.value?.itemResults ?? []).forEach((i) => {
    if ((i.result === '错' || i.result === '卡') && i.cause) set.add(i.cause)
  })
  return Array.from(set)
})

// 复练建议文案：优先 teacherNote；否则由错因拼装
const advice = computed(() => {
  if (r.value?.teacherNote?.trim()) return r.value.teacherNote.trim()
  if (causes.value.length) return `建议下次思维题复练：${causes.value.join('、')}`
  return ''
})
</script>

<template>
  <div class="lr card" v-loading="loading">
    <h2 class="gh"><span class="tick"></span>上次课回收</h2>

    <template v-if="r">
      <p class="lr-sub">
        <span v-if="sessionDate">{{ shortDate(sessionDate) }} · </span>
        课堂 {{ stats.total }} 题 · 对 {{ stats.right }}
        <span v-if="stats.wrong"> · 错 {{ stats.wrong }}</span>
        <span v-if="stats.stuck"> · 卡 {{ stats.stuck }}</span>
      </p>

      <div v-if="causes.length" class="lr-chips">
        <span v-for="(c, i) in causes" :key="i" class="chip warn">{{ c }}</span>
      </div>

      <p v-if="advice" class="lr-advice">{{ advice }}</p>
    </template>

    <p v-else-if="!loading" class="lr-empty">
      {{ noSession ? '该对象暂无已上场次' : '暂无回收记录' }}
    </p>
  </div>
</template>

<style scoped>
.lr { background: #fff; border: 1px solid var(--bk-line); border-radius: 12px; padding: 15px 16px; }
.gh { font-size: 13.5px; font-weight: 800; display: flex; align-items: center; gap: 8px; margin: 0 0 10px; }
.tick { width: 4px; height: 14px; border-radius: 2px; background: var(--bk-teal); flex: none; }
.lr-sub { font-size: 12px; color: #5f716d; margin: 0 0 8px; line-height: 1.6; }
.lr-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
.chip { font-size: 11.5px; border-radius: 6px; padding: 1px 8px; line-height: 19px; }
.chip.warn { color: #b45309; background: #fdf3e7; }
.lr-advice { font-size: 12px; color: var(--bk-teal-deep); margin: 0; line-height: 1.55; }
.lr-empty { font-size: 12px; color: #b7c4c0; font-style: italic; margin: 0; }
</style>
