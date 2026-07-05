<script setup lang="ts">
/**
 * PRD-C-213 FP16/FP17 — 三段式模板编辑器（plan.default_seg_template 与 lesson.seg_template 同构）。
 * v-model:SegTemplateItem[]，段数 2-4 可增删；每段 = name / style / topic。
 * 契约：批0 §二 seg_template schema（lesson 空则继承 plan）。
 */
import { computed } from 'vue'
import type { SegTemplateItem } from '@/api/teacher/schedule'

const props = withDefaults(
  defineProps<{
    modelValue?: SegTemplateItem[]
  }>(),
  { modelValue: () => [] },
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: SegTemplateItem[]): void
}>()

const segs = computed<SegTemplateItem[]>(() => props.modelValue ?? [])

// 段序对应视觉档：第 1 段思维（w）/第 2 段专项（m）/其余课内（s）
const kClass = (i: number) => (i === 0 ? 'w' : i === 1 ? 'm' : 's')

function commit(next: SegTemplateItem[]) {
  emit('update:modelValue', next)
}

function updateField(i: number, key: keyof SegTemplateItem, val: string) {
  const next = segs.value.map((s, idx) => (idx === i ? { ...s, [key]: val } : s))
  commit(next)
}

function addSeg() {
  if (segs.value.length >= 4) return
  commit([...segs.value, { name: '', style: '', topic: '' }])
}

function removeSeg(i: number) {
  if (segs.value.length <= 2) return
  commit(segs.value.filter((_, idx) => idx !== i))
}

function useDefault() {
  commit([
    { name: '思维题', style: '开场1道·单点突破·一题一坑', topic: '' },
    { name: '奥数专项', style: '书挑题·★分层', topic: '' },
    { name: '课内同步', style: '收尾过关·简单不费脑', topic: '' },
  ])
}
</script>

<template>
  <div class="seg-editor">
    <div v-if="segs.length === 0" class="seg-empty">
      <span>暂无分段模板</span>
      <el-button link type="primary" @click="useDefault">套用三段式默认</el-button>
    </div>

    <div v-for="(seg, i) in segs" :key="i" class="seg-item">
      <span class="seg-k" :class="kClass(i)">{{ i + 1 }}</span>
      <div class="seg-fields">
        <el-input
          :model-value="seg.name"
          size="small"
          placeholder="段名（如 思维题 / 奥数专项 / 课内同步）"
          class="seg-name"
          @update:model-value="(v: string) => updateField(i, 'name', v)"
        />
        <el-input
          :model-value="seg.style"
          size="small"
          placeholder="节奏说明（如 开场1道·单点突破）"
          @update:model-value="(v: string) => updateField(i, 'style', v)"
        />
        <el-input
          :model-value="seg.topic"
          size="small"
          placeholder="该段主题（可空，细备时定）"
          @update:model-value="(v: string) => updateField(i, 'topic', v)"
        />
      </div>
      <el-button
        link
        type="danger"
        :disabled="segs.length <= 2"
        title="至少保留 2 段"
        @click="removeSeg(i)"
      >
        删除
      </el-button>
    </div>

    <div v-if="segs.length > 0" class="seg-actions">
      <el-button size="small" :disabled="segs.length >= 4" @click="addSeg">+ 加一段（最多 4）</el-button>
    </div>
  </div>
</template>

<style scoped>
.seg-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.seg-empty {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: #8ba09a;
  padding: 6px 0;
}
.seg-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.seg-k {
  flex: none;
  width: 22px;
  height: 22px;
  margin-top: 4px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  font-size: 12px;
  font-weight: 700;
}
.seg-k.w { color: var(--bk-teal-deep); background: var(--bk-teal-soft); }
.seg-k.m { color: #fff; background: var(--bk-teal); }
.seg-k.s { color: #5f716d; background: #eef1f0; }
.seg-fields {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.seg-actions {
  padding-left: 30px;
}
</style>
