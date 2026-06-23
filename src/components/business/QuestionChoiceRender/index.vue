<script setup lang="ts">
/**
 * QuestionChoiceRender — 「题干 + 选项」统一渲染组件（Bug 2/4·2026-06-23）
 *
 * 🔴 基准 = 题库（my-question / QuestionCard → QuestionContent → renderRichText）。
 *   题库渲染一道选择题（无 blockJson 老题/AI 题）= 把整段 stem 文本（题干 + ABCD 选项内联）
 *   过 renderRichText（normalizeMath → KaTeX + markdown-it）当【一整块富文本流】渲染，
 *   不做 parseChoiceStem 两列网格。本组件把这套抽出来，让「举一反三变式卡 / 母题卡」复用，
 *   三处选择题题干+选项排版一字不差地一致。
 *
 * 用法：传入完整 stem（题干 + 选项，AI 产出的 markdown+LaTeX 文本）即可。
 *   - 与题库 QuestionContent.richtext 分支同管线（renderRichText + v-safe-html DOMPurify）。
 *   - 不接管填空/解答题的特化渲染逻辑——调用方对非选择题仍用原 MarkdownMath（见 VariantCard）。
 *   - blockJson 结构题不走这里（走 QuestionBlockRender，A-015 网格编辑器产物，别破坏）。
 *
 * 安全：走 v-safe-html 指令（DOMPurify 白名单），禁裸 v-html。
 */
import { computed } from 'vue'
import { renderRichText } from '@/utils/richtext'

const props = defineProps<{
  /** 完整题面文本（题干 + 选项内联），markdown + $...$ LaTeX */
  stem: string | null | undefined
}>()

const html = computed<string>(() => renderRichText(props.stem || ''))
</script>

<template>
  <!-- 与题库 QuestionContent 富文本分支同 class（qc-richtext）+ 同管线，保证排版一致 -->
  <div
    v-safe-html="html"
    class="qc-richtext qcr-root"
  />
</template>

<style scoped>
/* 🔴 与 QuestionContent.qc-richtext 对齐（题库基准）：字号走 --md-font-size（useFontScale 注入，
   与题库列表卡 / 变式编辑器同源），未设处回落 14px；行高/换行同题库。 */
.qcr-root {
  font-size: var(--md-font-size, 14px);
  line-height: 1.6;
  color: var(--el-text-color-primary, #1d2129);
  word-break: break-word;
}

/* markdown-it 输出的 p 默认带 margin，收紧（与题库 QuestionContent 一致） */
.qcr-root :deep(p) {
  margin: 0 0 0.5em;
}
.qcr-root :deep(p:last-child) {
  margin-bottom: 0;
}
.qcr-root :deep(ol),
.qcr-root :deep(ul) {
  padding-left: 1.5em;
  margin: 0.4em 0;
}

/* 块公式横向可滚（与题库一致） */
.qcr-root :deep(.math-block) {
  display: block;
  overflow-x: auto;
  padding: 4px 0;
}
.qcr-root :deep(.math-inline) {
  display: inline;
  vertical-align: middle;
}
.qcr-root :deep(.math-error) {
  color: #c9cdd4;
  font-style: italic;
  font-size: 0.9em;
}
</style>
