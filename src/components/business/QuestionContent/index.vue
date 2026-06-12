<script setup lang="ts">
/**
 * QuestionContent — 题目内容统一渲染组件（题干 / 答案 / 解析共用）
 *
 * 判定链（用户拍板：能力判定，不按来源判定）：
 *   1. text 非空  → 富文本渲染（Markdown + KaTeX LaTeX）
 *   2. imgUrl 非空 → 图片（misikt 老题现状）
 *   3. 都空       → 灰色占位"暂无内容"
 *
 * 未来同题两者都有时文本优先（此注释即为约定，不做切换按钮）。
 *
 * 安全：text 路径的渲染结果经 v-safe-html 指令走 DOMPurify 白名单过滤，
 * 禁止裸 v-html。图片路径同原有组件行为：referrerpolicy + onerror 隐藏。
 */
import { computed } from 'vue'
import { renderRichText } from '@/utils/richtext'

const props = withDefaults(
  defineProps<{
    /** 富文本内容（Markdown + LaTeX），非空时优先渲染 */
    text?: string | null
    /** 图片 URL，text 为空时渲染 */
    imgUrl?: string | null
    /** 图片 alt 文本 */
    alt?: string
    /**
     * 图片最大高度，默认 none（详情页不限高；列表卡片可传 '220px' 收紧）
     * 传 'none' 或不传 = 不限制
     */
    imgMaxHeight?: string
  }>(),
  {
    text: null,
    imgUrl: null,
    alt: '题目内容',
    imgMaxHeight: 'none',
  },
)

// 判定链：text 非空 → 富文本；否则 imgUrl 非空 → 图片；都空 → 占位
const mode = computed<'richtext' | 'image' | 'empty'>(() => {
  if (props.text && props.text.trim().length > 0) return 'richtext'
  if (props.imgUrl) return 'image'
  return 'empty'
})

// 富文本渲染（只在 mode=richtext 时计算）
const renderedHtml = computed<string>(() => {
  if (mode.value !== 'richtext') return ''
  return renderRichText(props.text!)
})

const imgStyle = computed(() => {
  if (props.imgMaxHeight && props.imgMaxHeight !== 'none') {
    return { maxHeight: props.imgMaxHeight }
  }
  return {}
})
</script>

<template>
  <!-- 富文本路径：v-safe-html 强制 DOMPurify 过滤，禁裸 v-html -->
  <div
    v-if="mode === 'richtext'"
    v-safe-html="renderedHtml"
    class="qc-richtext"
  />

  <!-- 图片路径：misikt 老题，沿用原有行为 -->
  <img
    v-else-if="mode === 'image'"
    :src="imgUrl!"
    :alt="alt"
    :style="imgStyle"
    class="qc-img"
    loading="lazy"
    referrerpolicy="no-referrer"
    @error="(e: Event) => ((e.target as HTMLImageElement).style.display = 'none')"
  />

  <!-- 都空：灰色占位 -->
  <span
    v-else
    class="qc-empty"
  >暂无内容</span>
</template>

<style scoped>
/* ── 富文本区 ── */
.qc-richtext {
  /* 字号走 --md-font-size（useFontScale 注入，与变式编辑器 MarkdownMath 同源），
     未设变量处回落 14px（聊天/其它处不受影响）。随「小/中/大」档位等比缩放。 */
  font-size: var(--md-font-size, 14px);
  line-height: 1.6;
  color: var(--el-text-color-primary, #1d2129);
  word-break: break-word;
}

/* markdown-it 输出的 p 标签默认有 margin，收紧避免和父容器 padding 重叠 */
.qc-richtext :deep(p) {
  margin: 0 0 0.5em;
}

.qc-richtext :deep(p:last-child) {
  margin-bottom: 0;
}

.qc-richtext :deep(ol),
.qc-richtext :deep(ul) {
  padding-left: 1.5em;
  margin: 0.4em 0;
}

/* 块公式：水平可滚，防数学式超宽溢出 */
.qc-richtext :deep(.math-block) {
  display: block;
  overflow-x: auto;
  padding: 4px 0;
}

/* 行内公式：保持 inline 对齐 */
.qc-richtext :deep(.math-inline) {
  display: inline;
  vertical-align: middle;
}

/* LaTeX 渲染错误降级样式（KaTeX throwOnError=false 降级原文显示） */
.qc-richtext :deep(.math-error) {
  color: #c9cdd4;
  font-style: italic;
  font-size: 0.9em;
}

/* ── 图片区 ── */
.qc-img {
  max-width: 100%;
  height: auto;
  display: block;
  border-radius: 6px;
}

/* ── 空占位 ── */
.qc-empty {
  font-size: 13px;
  color: #c9cdd4;
}
</style>
