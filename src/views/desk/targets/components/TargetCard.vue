<script setup lang="ts">
/**
 * PRD-C-213 FP12 · 对象卡片（学生 / 班级统一卡）。
 * 展示：姓名 + 对象色 · 年级学科 · 已排/已上/请假计数（班级=学员数）· 进度条 ·
 *      下一课行（日期时间 + 课次 + prep pill）· 绑定计划(FP13) · 家长电话掩码。
 * 归档卡置灰。点击 → 选中进详情。
 */
import { computed } from 'vue'
import { TARGET_TYPE_LABEL, type TargetCardVO } from '@/api/teacher/schedule'
import {
  avatarChar,
  shortDate,
  weekdayCn,
  relativeDay,
  shortTime,
  progressPct,
  FALLBACK_COLOR,
} from '../helpers'

const props = defineProps<{
  card: TargetCardVO
  selected?: boolean
}>()

const emit = defineEmits<{
  (e: 'select', id: string): void
  (e: 'edit', id: string): void
}>()

const color = computed(() => props.card.color || FALLBACK_COLOR)
const isClass = computed(() => props.card.targetType === '1')
const archived = computed(() => props.card.archived === '1')

const pct = computed(() => {
  const c = props.card
  if (c.progressTotal && c.progressTotal > 0) return progressPct(c.progressDone, c.progressTotal)
  // 无计划时退化用 已上/已排 估进度
  return progressPct(c.doneCount, c.scheduledCount)
})

const next = computed(() => props.card.nextSession || null)
</script>

<template>
  <div
    class="stu-card"
    :class="{ sel: selected, archived }"
    :style="{ borderTopColor: color }"
    @click="emit('select', card.id)"
  >
    <div class="stu-top">
      <span class="stu-ava" :style="{ background: color, borderRadius: isClass ? '10px' : '12px' }">{{
        avatarChar(card.name)
      }}</span>
      <div class="stu-who">
        <b
          >{{ card.name }}
          <span v-if="isClass" class="mini-badge">班课</span>
          <span v-if="archived" class="mini-badge grey">已归档</span>
        </b>
        <!-- R1a：grade=BE 推导串；学科显示中文标签（subject 现为字典码） -->
        <span class="sub">{{ [card.grade, card.subjectLabel || card.subject].filter(Boolean).join(' · ') || '—' }}</span>
      </div>
      <el-button class="edit-btn" size="small" text @click.stop="emit('edit', card.id)">编辑</el-button>
    </div>

    <div class="stu-meta">
      <span>已排 <b>{{ card.scheduledCount ?? 0 }}</b> 次</span>
      <span>已上 <b>{{ card.doneCount ?? 0 }}</b> 次</span>
      <span v-if="isClass">学员 <b>{{ card.studentCount ?? 0 }}</b> 人</span>
      <span v-else>请假 <b>{{ card.leaveCount ?? 0 }}</b></span>
    </div>

    <div class="prog"><i :style="{ width: pct + '%', background: color }" /></div>

    <!-- FP13 绑定计划 -->
    <div v-if="card.planName" class="plan-line">
      <span class="plan-name">{{ card.planName }}</span>
      <span v-if="card.progressTotal" class="plan-prog"
        >{{ card.progressDone ?? 0 }} / {{ card.progressTotal }}</span
      >
    </div>

    <!-- 下一课 -->
    <div class="next" v-if="next">
      下一课 ·
      <b>{{ shortDate(next.sessionDate) }} {{ relativeDay(next.sessionDate) || weekdayCn(next.sessionDate) }}
        {{ shortTime(next.startTime) }}</b>
      <span v-if="next.title" class="next-title">{{ next.title }}</span>
    </div>
    <div class="next dim" v-else>暂无后续排课</div>
    <span class="type-tag">{{ TARGET_TYPE_LABEL[card.targetType] }}</span>
  </div>
</template>

<style scoped>
.stu-card {
  position: relative;
  padding: 16px 18px 14px;
  background: #fff;
  border: 1px solid var(--bk-line);
  border-top: 3px solid var(--bk-line);
  border-radius: 12px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.stu-card:hover {
  box-shadow: 0 4px 14px rgba(19, 49, 43, 0.08);
}
.stu-card:hover .edit-btn {
  opacity: 1;
}
.stu-card.sel {
  border-color: var(--bk-teal);
  box-shadow: 0 4px 14px rgba(15, 118, 110, 0.12);
}
.stu-card.archived {
  opacity: 0.55;
  filter: grayscale(0.4);
}
.stu-top {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.stu-ava {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  color: #fff;
  font-weight: 800;
  font-size: 15px;
  flex: none;
}
.stu-who {
  min-width: 0;
  flex: 1;
}
.stu-who b {
  font-size: 15px;
  color: var(--bk-ink);
  display: flex;
  align-items: center;
  gap: 5px;
}
.stu-who .sub {
  font-size: 12px;
  color: #5f716d;
  display: block;
}
.mini-badge {
  font-size: 10.5px;
  font-weight: 600;
  color: #7d8f8b;
  background: #eef1f0;
  border-radius: 99px;
  padding: 0 7px;
  line-height: 17px;
}
.mini-badge.grey {
  color: #b45309;
  background: #fdf3e7;
}
.edit-btn {
  flex: none;
  opacity: 0;
  transition: opacity 0.15s;
}
.stu-meta {
  font-size: 12px;
  color: #5f716d;
  display: flex;
  gap: 12px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.stu-meta b {
  color: var(--bk-ink);
  font-variant-numeric: tabular-nums;
}
.prog {
  height: 6px;
  border-radius: 3px;
  background: #eef3f1;
  overflow: hidden;
  margin-bottom: 8px;
}
.prog i {
  display: block;
  height: 100%;
  border-radius: 3px;
}
.plan-line {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  font-size: 11.5px;
}
.plan-name {
  color: var(--bk-teal-deep);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plan-prog {
  color: #8ba09a;
  font-variant-numeric: tabular-nums;
  flex: none;
  margin-left: auto;
}
.next {
  font-size: 11.5px;
  color: #8ba09a;
}
.next b {
  color: var(--bk-teal-deep);
}
.next-title {
  color: #5f716d;
  margin-left: 4px;
}
.next.dim {
  color: #b7c4c0;
}
.type-tag {
  position: absolute;
  top: 12px;
  right: 14px;
  font-size: 10px;
  color: #b7c4c0;
}
</style>
