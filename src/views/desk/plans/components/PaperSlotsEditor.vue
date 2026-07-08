<script setup lang="ts">
/**
 * PRD-B-101 专项卷位编辑器（plan.default_paper_slots 与 lesson.paper_slots 同构）。
 * v-model:PaperSlot[]，每位 = slot_seq / name / style / rules / note（配方元数据可编辑）。
 * 🔴 绑定字段（paper_id / manual_ready）此处不可编辑——绑卷走课次行「组这张卷 / 挂已有卷」。
 * 卷位可增删；删除绑着卷的位 = 卷解绑留库不删（BE 保证），此处仅改配方，绑定由课次行流程管。
 */
import { computed } from 'vue'
import type { PaperSlot } from '@/api/teacher/schedule'

const props = withDefaults(
  defineProps<{
    modelValue?: PaperSlot[]
  }>(),
  { modelValue: () => [] },
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: PaperSlot[]): void
}>()

const slots = computed<PaperSlot[]>(() => props.modelValue ?? [])

const kClass = (i: number) => (i === 0 ? 'w' : i === 1 ? 'm' : 's')

function commit(next: PaperSlot[]) {
  emit('update:modelValue', next)
}

function updateField(i: number, key: 'name' | 'style' | 'rules' | 'note', val: string) {
  commit(slots.value.map((s, idx) => (idx === i ? { ...s, [key]: val } : s)))
}

function nextSeq(): number {
  const max = slots.value.reduce((m, s) => Math.max(m, Number(s.slot_seq) || 0), 0)
  return max + 1
}

function addSlot() {
  commit([
    ...slots.value,
    { slot_seq: nextSeq(), name: '', style: '', rules: '', note: '', paper_id: null, manual_ready: false },
  ])
}

function removeSlot(i: number) {
  commit(slots.value.filter((_, idx) => idx !== i))
}

function useDefault() {
  commit([
    { slot_seq: 1, name: '概念辨析', style: '选择/判断为主 · 单点突破', rules: '', note: '', paper_id: null, manual_ready: false },
    { slot_seq: 2, name: '巩固提高', style: '解答为主 · 由浅入深', rules: '', note: '', paper_id: null, manual_ready: false },
    { slot_seq: 3, name: '课内同步', style: '收尾过关 · 简单不费脑', rules: '', note: '', paper_id: null, manual_ready: false },
  ])
}
</script>

<template>
  <div class="slot-editor">
    <div v-if="slots.length === 0" class="slot-empty">
      <span>暂无卷位</span>
      <el-button link type="primary" @click="useDefault">套用常用卷位</el-button>
      <el-button link @click="addSlot">或手动加一位</el-button>
    </div>

    <div v-for="(slot, i) in slots" :key="i" class="slot-item">
      <span class="slot-k" :class="kClass(i)">{{ slot.slot_seq ?? i + 1 }}</span>
      <div class="slot-fields">
        <el-input
          :model-value="slot.name"
          size="small"
          maxlength="30"
          placeholder="卷位名（如 概念辨析 / 巩固提高 / 课内同步）"
          class="slot-name"
          @update:model-value="(v: string) => updateField(i, 'name', v)"
        />
        <el-input
          :model-value="slot.style"
          size="small"
          maxlength="60"
          placeholder="出卷风格（如 选择为主·单点突破）"
          @update:model-value="(v: string) => updateField(i, 'style', v)"
        />
        <div class="slot-meta-row">
          <el-input
            :model-value="slot.rules"
            size="small"
            maxlength="40"
            placeholder="组卷规则（老师侧，不进卷面）"
            @update:model-value="(v: string) => updateField(i, 'rules', v)"
          />
          <el-input
            :model-value="slot.note"
            size="small"
            maxlength="60"
            placeholder="备注（老师侧，不进卷面）"
            @update:model-value="(v: string) => updateField(i, 'note', v)"
          />
        </div>
        <div v-if="slot.paper_id" class="slot-bound">已绑卷（在课次行「重组」解绑）</div>
      </div>
      <el-button link type="danger" title="删除卷位（绑着的卷解绑留库不删）" @click="removeSlot(i)">删除</el-button>
    </div>

    <div v-if="slots.length > 0" class="slot-actions">
      <el-button size="small" @click="addSlot">+ 加一个卷位</el-button>
    </div>
  </div>
</template>

<style scoped>
.slot-editor { display: flex; flex-direction: column; gap: 10px; width: 100%; }
.slot-empty { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #8ba09a; padding: 6px 0; flex-wrap: wrap; }
.slot-item { display: flex; align-items: flex-start; gap: 8px; }
.slot-k {
  flex: none; width: 22px; height: 22px; margin-top: 4px; border-radius: 6px; display: grid; place-items: center;
  font-size: 12px; font-weight: 700;
}
.slot-k.w { color: var(--bk-teal-deep); background: var(--bk-teal-soft); }
.slot-k.m { color: #fff; background: var(--bk-teal); }
.slot-k.s { color: #5f716d; background: #eef1f0; }
.slot-fields { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.slot-meta-row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.slot-bound { font-size: 11px; color: var(--bk-teal-deep); background: var(--bk-teal-soft); border-radius: 5px; padding: 1px 8px; align-self: flex-start; }
.slot-actions { padding-left: 30px; }
@media (max-width: 640px) { .slot-meta-row { grid-template-columns: 1fr; } }
</style>
