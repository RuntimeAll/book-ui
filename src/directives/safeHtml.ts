import DOMPurify, { type Config } from 'dompurify'
import type { Directive } from 'vue'

// PRD-A-013 H-3: 全局 v-safe-html 指令 — 替代裸 v-html, 强制走 DOMPurify 白名单过滤.
// 题干/笔记/富文本一律走这个; 原生 v-html 在本工程禁用.
// 白名单覆盖: 基础 HTML + 表格 + MathML(MathJax 兜底) + mjx-* 容器 + SVG(MathJax SVG 输出).
// 禁用: <script>/<iframe>/<object>/<embed>/<form> + 所有 on* 事件属性 + javascript: 协议.
const config: Config = {
  ALLOWED_TAGS: [
    'a', 'b', 'br', 'div', 'em', 'i', 'img', 'li', 'ol', 'p', 'span', 'strong', 'sub', 'sup', 'u', 'ul',
    'table', 'thead', 'tbody', 'tr', 'td', 'th',
    // MathML (MathJax 输入端兜底, sanitize 时尚未渲染, 此处冗余防御)
    'math', 'mrow', 'mi', 'mn', 'mo', 'msup', 'msub', 'mfrac', 'mroot', 'msqrt', 'mtext', 'mspace',
    // MathJax 渲染后的 mjx-* 容器(若 sanitize 发生在渲染后)
    'mjx-container', 'mjx-math', 'mjx-mi', 'mjx-mn', 'mjx-mo', 'mjx-mfrac', 'mjx-msqrt',
    // SVG (MathJax SVG 输出)
    'svg', 'g', 'path', 'text', 'use', 'rect', 'circle', 'line', 'polyline', 'polygon', 'tspan',
  ],
  ALLOWED_ATTR: [
    'href', 'src', 'alt', 'title', 'class', 'style',
    // SVG attrs
    'd', 'fill', 'stroke', 'stroke-width', 'transform', 'viewBox', 'width', 'height',
    'x', 'y', 'cx', 'cy', 'r', 'x1', 'x2', 'y1', 'y2', 'points',
    // KaTeX 拉伸式符号(根号/大括号/箭头)的 SVG 靠 preserveAspectRatio="xMinYMin slice" 撑形,
    // 缺它会被默认 meet 压扁成 0 高 → 根号 √ 不可见(2026-06-16 修)。
    'preserveAspectRatio',
    // mjx / a11y attrs
    'jax', 'aria-hidden', 'aria-label', 'role',
  ],
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
  FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'onsubmit', 'onkeydown', 'onkeyup', 'onkeypress'],
  // 禁止 javascript: 协议; 允许 http(s)/mailto/tel/ftp/data:image/*
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|ftp|data:image\/[a-z]+):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
}

export const safeHtml: Directive<HTMLElement, string | undefined | null> = {
  mounted(el, binding) {
    el.innerHTML = DOMPurify.sanitize(binding.value ?? '', config) as unknown as string
  },
  updated(el, binding) {
    el.innerHTML = DOMPurify.sanitize(binding.value ?? '', config) as unknown as string
  },
}
