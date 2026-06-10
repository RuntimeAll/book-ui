<script setup lang="ts">
import { computed } from 'vue'
import MarkdownIt from 'markdown-it'
import katexPlugin from '@traptitech/markdown-it-katex'
import 'katex/dist/katex.min.css'

// ---------------------------------------------------------------------------
// PRD-C-009 — 富文本渲染：Markdown（## 标题 / **粗体** / 列表 / --- 分隔）+ LaTeX 数学公式
//   （$...$ 行内 / $$...$$ 行间）。举一反三 agent 的题面/解析含大量 $\sqrt{}$ $\frac{}{}$，
//   纯文本气泡会把源码直出（## ** $ 裸露），故走 markdown-it + katex 渲染成富文本。
//
// 🔴 content 来源 = 我方 agent 产出（受信），故直接 v-html；不渲染用户原始输入（用户气泡走纯文本）。
//   html:false 关闭原始 HTML 透传（防注入），仅认 markdown 语法 + katex 公式。
// ---------------------------------------------------------------------------

const props = defineProps<{ content: string }>()

const md = new MarkdownIt({ breaks: true, linkify: true, html: false })
md.use(katexPlugin, { throwOnError: false, errorColor: '#cf1322' })

const rendered = computed(() => md.render(props.content || ''))
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div class="md-math" v-html="rendered" />
</template>

<style scoped>
.md-math {
  font-size: 14px;
  line-height: 1.7;
  color: #1d2129;
  word-break: break-word;
}
.md-math :deep(h1),
.md-math :deep(h2),
.md-math :deep(h3) {
  margin: 10px 0 6px;
  font-weight: 700;
  line-height: 1.4;
}
.md-math :deep(h1) {
  font-size: 17px;
}
.md-math :deep(h2) {
  font-size: 16px;
}
.md-math :deep(h3) {
  font-size: 15px;
  color: #4080ff;
}
.md-math :deep(p) {
  margin: 6px 0;
}
.md-math :deep(strong) {
  font-weight: 700;
  color: #1d2129;
}
.md-math :deep(hr) {
  border: none;
  border-top: 1px dashed #d6d9e0;
  margin: 12px 0;
}
.md-math :deep(ul),
.md-math :deep(ol) {
  margin: 6px 0;
  padding-left: 22px;
}
.md-math :deep(li) {
  margin: 3px 0;
}
.md-math :deep(code) {
  background: #f0f2f5;
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 13px;
}
.md-math :deep(.katex) {
  font-size: 1.04em;
}
/* 行间公式横向可滚，长公式不撑破气泡 */
.md-math :deep(.katex-display) {
  overflow-x: auto;
  overflow-y: hidden;
  padding: 4px 0;
}
</style>
