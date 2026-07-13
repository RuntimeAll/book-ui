<script setup lang="ts">
/**
 * QuestionContent — 题目内容统一渲染组件（题干 / 答案 / 解析共用）
 *
 * 判定链（用户拍板：能力判定，不按来源判定）：
 *   1. text 非空  → 富文本渲染（Markdown + KaTeX LaTeX）
 *   2. imgUrl 非空 → 图片（misikt 老题现状 / 录题裁图题的 stem_img_url）
 *   3. 都空       → 灰色占位"暂无内容"
 *
 * 🔴 PRD-A-024 批2·前端补尾：text 与 imgUrl 都有时**两者都渲染**（富文本在上、题图在下），
 *   不再文本优先吞掉图 —— 录题裁图入库题带 stemText + stem_img_url，旧「文本 XOR 图」逻辑
 *   会让真题图不可见（图存 biz_question_image/stem_img_url 却渲染不出）。仅增显本就该显的题图，
 *   text-only 题（stem_img_url 为空，占绝大多数）行为零变化。
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

// 独立判定：有文本渲富文本，有图渲图，两者都有则都渲（PRD-A-024 批2·前端补尾）；都空占位。
const hasText = computed<boolean>(() => !!props.text && props.text.trim().length > 0)
const hasImg = computed<boolean>(() => !!props.imgUrl)

// 富文本渲染（只在有文本时计算）
const renderedHtml = computed<string>(() => {
  if (!hasText.value) return ''
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
    v-if="hasText"
    v-safe-html="renderedHtml"
    class="qc-richtext"
  />

  <!-- 图片路径：misikt 老题（无文本）+ 录题裁图题（文本+图共显，图在文本下方） -->
  <img
    v-if="hasImg"
    :src="imgUrl!"
    :alt="alt"
    :style="imgStyle"
    class="qc-img"
    :class="{ 'qc-img--after-text': hasText }"
    loading="lazy"
    referrerpolicy="no-referrer"
    @error="(e: Event) => ((e.target as HTMLImageElement).style.display = 'none')"
  />

  <!-- 都空：灰色占位 -->
  <span
    v-if="!hasText && !hasImg"
    class="qc-empty"
  >暂无内容</span>
</template>

<style scoped>
/* ── 富文本区 ── */
.qc-richtext {
  /* 题面基准字号固定 16px（原「小/中/大」字号档 2026-06-30 废除）。 */
  font-size: 16px;
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

/* ── 表格区 ── */
/* markdown-it 默认 preset 开启 GFM 表格：`| a | b |` 渲染成 <table>（DOMPurify 白名单放行
   table/thead/tbody/tr/th/td）。此前 .qc-richtext 作用域内无任何 table CSS，浏览器默认
   border:0 / padding:0 / border-collapse:separate，表头与数据行挤成一行 run-on 文本
   （如 Q25 原料仓库进出数量表），列对不齐读不出对应关系。加在本组件=题干/答案/解析各页
   全局生效，优于只在 book.vue .prose 局部补。 */
.qc-richtext :deep(table) {
  border-collapse: collapse;
  width: auto;
  max-width: 100%;
  margin: 0.5em 0;
}

.qc-richtext :deep(th),
.qc-richtext :deep(td) {
  border: 1px solid var(--el-border-color, #dcdfe6);
  padding: 4px 8px;
  text-align: center;
}

.qc-richtext :deep(th) {
  background: var(--el-fill-color-light, #f5f7fa);
  font-weight: 600;
}

/* ── 图片区 ── */
.qc-img {
  max-width: 100%;
  height: auto;
  display: block;
  border-radius: 6px;
}

/* 文本+图共显时，题图与文本间留白（PRD-A-024 批2·前端补尾） */
.qc-img--after-text {
  margin-top: 8px;
}

/* ── 空占位 ── */
.qc-empty {
  font-size: 13px;
  color: #c9cdd4;
}
</style>
