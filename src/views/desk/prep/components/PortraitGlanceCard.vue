<script setup lang="ts">
/**
 * PRD-C-213 FP20' 学生 / 班级肖像速览侧卡（构建器右侧只读摘要版）。
 * 摘要 = 特点 · 程度 · 培养目标一行；易错信号 chips（pending 虚线琥珀区分）。
 * 「本次选题已埋坑」呼应：从段 note 里含「埋坑」字样时提示（从简）。
 */
import { computed } from 'vue'
import { type ProfileJson, type PackSeg } from '@/api/teacher/schedule'

const props = defineProps<{
  profile: ProfileJson | null
  kindLabel?: string
  loading?: boolean
  /** 当前包各段（扫 note 里的埋坑呼应） */
  segs?: PackSeg[]
}>()

const p = computed(() => props.profile)
const kind = computed(() => props.kindLabel || '学生')

const summaryLine = computed(() => {
  const j = p.value
  if (!j) return ''
  const parts: string[] = []
  if (j.traits?.length) parts.push(j.traits.join(' · '))
  if (j.level?.desc) parts.push(j.level.desc)
  if (j.level?.target_layer) parts.push(`目标：${j.level.target_layer}`)
  return parts.join(' · ')
})

// 段 note 里含「埋坑」→ 提取呼应文案
const buriedTraps = computed<string[]>(() => {
  const out: string[] = []
  ;(props.segs ?? []).forEach((s) => {
    const note = s.note ?? ''
    const m = /埋坑[：:\s]*([^\n；;，,]+)/.exec(note)
    if (m && m[1]) out.push(m[1].trim())
  })
  return out
})
</script>

<template>
  <div class="glance card" v-loading="loading">
    <h2 class="gh"><span class="tick"></span>{{ kind }}肖像速览</h2>
    <template v-if="p">
      <p v-if="summaryLine" class="gl-sum">{{ summaryLine }}</p>
      <p v-else class="gl-empty">肖像未记录</p>

      <div v-if="p.error_signals?.length" class="gl-chips">
        <span
          v-for="(s, i) in p.error_signals"
          :key="i"
          class="chip"
          :class="{ pending: s.status === 'pending' }"
          :title="s.evidence"
        >
          <span v-if="s.status === 'pending'" class="pd">待确认</span>{{ s.tag }}
        </span>
      </div>
      <p v-else class="gl-note">暂无易错信号</p>

      <p v-if="buriedTraps.length" class="gl-trap">
        ✓ 本次选题已埋坑：{{ buriedTraps.join(' · ') }}
      </p>
    </template>
    <p v-else-if="!loading" class="gl-empty">
      无肖像上下文（散课或未关联对象时不显示）
    </p>
  </div>
</template>

<style scoped>
.glance { background: #fff; border: 1px solid var(--bk-line); border-radius: 12px; padding: 15px 16px; }
.gh { font-size: 13.5px; font-weight: 800; display: flex; align-items: center; gap: 8px; margin: 0 0 10px; }
.tick { width: 4px; height: 14px; border-radius: 2px; background: var(--bk-teal); flex: none; }
.gl-sum { font-size: 12px; color: #5f716d; line-height: 1.6; margin: 0 0 8px; }
.gl-empty { font-size: 12px; color: #b7c4c0; font-style: italic; margin: 0; }
.gl-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip { font-size: 11.5px; color: #5f716d; background: #eef1f0; border-radius: 6px; padding: 1px 8px; line-height: 19px; }
.chip.pending { color: #b45309; background: #fdf3e7; border: 1px dashed #e6b980; }
.pd { font-size: 10px; background: #b45309; color: #fff; border-radius: 4px; padding: 0 4px; line-height: 14px; margin-right: 3px; }
.gl-note { font-size: 11.5px; color: #8ba09a; margin: 0; }
.gl-trap { font-size: 11.5px; color: var(--bk-teal-deep); margin: 8px 0 0; line-height: 1.5; }
</style>
