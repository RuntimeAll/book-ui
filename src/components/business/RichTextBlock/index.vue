<script setup lang="ts">
/**
 * RichTextBlock — 轻量富文本输入块（PRD-A-015 档 L）
 *
 * = el-input(textarea) + 一排工具栏。点按钮把选中文字包裹成标记，渲染端 richtext.ts 解析：
 *   加粗  **x**         (markdown 原生)
 *   斜体  *x*           (markdown 原生)
 *   上标  ⟦sup⟧x⟦/sup⟧  → <sup>
 *   下标  ⟦sub⟧x⟦/sub⟧  → <sub>
 *   公式  $x$           (KaTeX)
 *   颜色  ⟦c:#hex⟧x⟦/c⟧ → <span style="color">
 *   字号  ⟦s:px⟧x⟦/s⟧   → <span style="font-size">
 *
 * 🔒 存储仍是 schema 锁定的 md:string（含上述受控标记），字段不变；C 线共享渲染器自动支持。
 * 安全：渲染走 v-safe-html(DOMPurify)，span/style/sup/sub 已在白名单，color/font-size 受 CSS 过滤。
 */
import { ref } from 'vue'
import { ElInput } from 'element-plus'

const props = withDefaults(
  defineProps<{
    modelValue: string
    rows?: number
    placeholder?: string
  }>(),
  { rows: 3, placeholder: '支持 Markdown + $...$ 公式，可用工具栏加粗/字号/颜色' },
)
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()

const inputRef = ref<InstanceType<typeof ElInput>>()
// 记录最近一次选区（el-color-picker / el-select 弹层会抢焦点，需提前存）
const lastSel = ref<{ start: number; end: number }>({ start: 0, end: 0 })

function getTa(): HTMLTextAreaElement | undefined {
  return inputRef.value?.textarea ?? undefined
}
function recordSel() {
  const ta = getTa()
  if (ta) lastSel.value = { start: ta.selectionStart, end: ta.selectionEnd }
}

/** 用 before/after 包裹当前选区（无选区则插入占位词），写回 v-model 并恢复选区 */
function wrap(before: string, after: string, placeholder = '文字') {
  const ta = getTa()
  const { start, end } = lastSel.value
  const val = props.modelValue ?? ''
  const hasSel = end > start
  const sel = hasSel ? val.slice(start, end) : placeholder
  const next = val.slice(0, start) + before + sel + after + val.slice(end)
  emit('update:modelValue', next)
  // 恢复焦点 + 选中包裹后的内容
  requestAnimationFrame(() => {
    if (!ta) return
    ta.focus()
    const ns = start + before.length
    ta.setSelectionRange(ns, ns + sel.length)
    lastSel.value = { start: ns, end: ns + sel.length }
  })
}

const SIZE_OPTIONS = [
  { label: '小', value: 14 },
  { label: '中', value: 18 },
  { label: '大', value: 24 },
]
function applyColor(color: string | null) {
  if (color) wrap(`⟦c:${color}⟧`, '⟦/c⟧')
}
function applySize(px: number) {
  wrap(`⟦s:${px}⟧`, '⟦/s⟧')
}
</script>

<template>
  <div class="rtb">
    <!-- 工具栏：纯按钮 @mousedown.prevent 保焦点；弹层组件靠 lastSel -->
    <div class="rtb-toolbar">
      <button type="button" class="rtb-btn" title="加粗" @mousedown.prevent @click="wrap('**', '**')">
        <b>B</b>
      </button>
      <button type="button" class="rtb-btn" title="斜体" @mousedown.prevent @click="wrap('*', '*')">
        <i>I</i>
      </button>
      <button type="button" class="rtb-btn" title="上标" @mousedown.prevent @click="wrap('⟦sup⟧', '⟦/sup⟧')">
        x<sup>2</sup>
      </button>
      <button type="button" class="rtb-btn" title="下标" @mousedown.prevent @click="wrap('⟦sub⟧', '⟦/sub⟧')">
        x<sub>2</sub>
      </button>
      <button type="button" class="rtb-btn" title="行内公式" @mousedown.prevent @click="wrap('$', '$')">
        √x
      </button>
      <span class="rtb-divider" />
      <el-select
        :model-value="undefined"
        size="small"
        placeholder="字号"
        style="width: 76px"
        @visible-change="(v: boolean) => v && recordSel()"
        @change="applySize"
      >
        <el-option v-for="s in SIZE_OPTIONS" :key="s.value" :label="s.label" :value="s.value" />
      </el-select>
      <el-color-picker
        size="small"
        :show-alpha="false"
        @focus="recordSel"
        @change="applyColor"
      />
    </div>

    <el-input
      ref="inputRef"
      :model-value="modelValue"
      type="textarea"
      :rows="rows"
      :placeholder="placeholder"
      @update:model-value="(v: string) => emit('update:modelValue', v)"
      @select="recordSel"
      @mouseup="recordSel"
      @keyup="recordSel"
      @blur="recordSel"
    />
  </div>
</template>

<style scoped>
.rtb {
  width: 100%;
}
.rtb-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}
.rtb-btn {
  min-width: 28px;
  height: 26px;
  padding: 0 6px;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  background: #fff;
  color: #4e5969;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  transition: all 0.15s;
}
.rtb-btn:hover {
  border-color: #1e8a8a;
  color: #1e8a8a;
  background: #f0f7f7;
}
.rtb-btn sup,
.rtb-btn sub {
  font-size: 9px;
}
.rtb-divider {
  width: 1px;
  height: 18px;
  background: #e5e6eb;
  margin: 0 2px;
}
</style>
