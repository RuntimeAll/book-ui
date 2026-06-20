<script setup lang="ts">
import { computed } from 'vue'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { normalizeMath } from '@/utils/mathNormalize'

// ---------------------------------------------------------------------------
// InlineMath — 行内富文本（纯文本 + $...$ 行内公式）轻量渲染（P3，2026-06-18）。
//   用于母题卡/变式卡的 DNA 维 chip（难点/副考点/模型/标签/场景）：这些字段是短文本，
//   但可能含 $x^2$ / \frac / \quad 等 LaTeX，纯插值会裸露。本组件只渲染行内数学，
//   不走 markdown（不产 <p>/标题/列表），适合 chip 内嵌。
//
//   渲染口径与聊天页/题库一致：先过 SSOT normalizeMath（\(\)→$、$ 外裸 \quad 清除等），
//   再把 $...$ 段交 KaTeX 行内渲染；其余文本 HTML 转义后原样输出（不开 markdown，防注入）。
//   content 来源 = 我方 agent 产出/已入库 DNA（受信）；KaTeX throwOnError=false 降级原文不崩。
// ---------------------------------------------------------------------------

const props = defineProps<{ content: string | number | null | undefined }>()

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// 切分 $...$ 行内段：偶数下标 = 段外文本（HTML 转义），奇数下标 = 公式（KaTeX 渲染）
const INLINE_MATH_RE = /(\$[^\n$]+?\$)/g

const rendered = computed(() => {
  const raw = props.content == null ? '' : String(props.content)
  if (!raw) return ''
  const norm = normalizeMath(raw)
  const parts = norm.split(INLINE_MATH_RE)
  return parts
    .map((part, i) => {
      if (i % 2 === 1) {
        // 奇数下标 = $...$ 公式段
        const formula = part.slice(1, -1).trim()
        try {
          return katex.renderToString(formula, {
            displayMode: false,
            throwOnError: false,
            output: 'html',
          })
        } catch {
          return escapeHtml(part)
        }
      }
      return escapeHtml(part)
    })
    .join('')
})
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -->
  <span class="inline-math" v-html="rendered" />
</template>

<style scoped>
.inline-math :deep(.katex) {
  font-size: 1em;
}
</style>
