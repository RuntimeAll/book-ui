/**
 * richtext.ts — Markdown + LaTeX 富文本渲染工具
 *
 * 用途：AI 入库题的题干/答案/解析是 Markdown + $..$ / $$..$$ LaTeX 格式。
 * 老 misikt 题用图片（stemImg/answerImg/explainImg），走独立路径，本模块不涉及。
 *
 * 渲染顺序：
 *   1. 先把文本中的 $$...$$ 和 $..$ 替换为 KaTeX 渲染的 HTML 字符串（占位保护）
 *   2. 再过 markdown-it（html: false 防注入）
 *   3. 输出原始 HTML 字符串，调用方必须通过 v-safe-html 指令渲染，禁裸 v-html
 *
 * 注意：KaTeX 的 throwOnError=false，遇到无效 LaTeX 降级渲染原文，不崩组件。
 */
import katex from 'katex'
import MarkdownIt from 'markdown-it'

// markdown-it 实例：html:false 防注入；linkify 自动识别 URL；breaks 换行=<br>
const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: false,
  breaks: true,
})

/**
 * 把 Markdown + LaTeX 文本渲染为 HTML 字符串。
 * 返回值必须配合 v-safe-html 指令使用，禁止裸 v-html。
 */
export function renderRichText(text: string): string {
  if (!text) return ''

  // ── Step 1：LaTeX 替换（先替换块公式再替换行内公式，避免 $$ 被 $ 误匹配）──
  // 使用占位字典：把渲染后的 HTML 先存字典，防止 markdown-it 对 HTML 内容做二次转义
  const placeholders: Record<string, string> = {}
  let counter = 0

  // 占位符不能含 \x00（markdown-it 会 nullify 控制字符）；改用合法 Unicode 私用区字符序列
  const makePlaceholder = (html: string): string => {
    const key = `￾MATH${counter++}￾`
    placeholders[key] = html
    return key
  }

  // 块公式 $$...$$ → display mode
  let result = text.replace(/\$\$([\s\S]+?)\$\$/g, (_match, formula: string) => {
    try {
      const rendered = katex.renderToString(formula.trim(), {
        displayMode: true,
        throwOnError: false,
        output: 'html',
      })
      return makePlaceholder(`<span class="math-block">${rendered}</span>`)
    } catch {
      return makePlaceholder(`<span class="math-block math-error">$$${formula}$$</span>`)
    }
  })

  // 行内公式 $..$ → inline mode（排除 $$ 已处理过的）
  result = result.replace(/\$([^\n$]+?)\$/g, (_match, formula: string) => {
    try {
      const rendered = katex.renderToString(formula.trim(), {
        displayMode: false,
        throwOnError: false,
        output: 'html',
      })
      return makePlaceholder(`<span class="math-inline">${rendered}</span>`)
    } catch {
      return makePlaceholder(`<span class="math-inline math-error">$${formula}$</span>`)
    }
  })

  // ── Step 2：markdown-it 渲染（此时 LaTeX 已变为占位符，不会被转义）──
  result = md.render(result)

  // ── Step 3：还原 LaTeX 占位符 ──
  for (const [key, html] of Object.entries(placeholders)) {
    // 占位符可能被 markdown-it 包在 <p> 里，直接字符串替换即可
    result = result.replace(key, html)
  }

  // ── Step 4：PRD-A-015 档 L — 受控内联样式标记 → HTML ──
  // RichTextBlock 工具栏插入的标记（markdown 无原生语法的字号/颜色/上下标）。
  // 用 ⟦⟧ 私用分隔符，markdown-it 视作普通文本透传，此处在最终 HTML 上还原。
  // 值受正则约束（仅 hex 颜色 / 数字字号）+ v-safe-html DOMPurify 兜底，无注入面。
  result = applyInlineMarkers(result)

  return result
}

/** 受控内联样式标记 → HTML（颜色/字号/上下标）。值经正则严格约束。 */
function applyInlineMarkers(html: string): string {
  return html
    .replace(
      /⟦c:(#[0-9a-fA-F]{3,8})⟧([\s\S]*?)⟦\/c⟧/g,
      (_m, color: string, inner: string) => `<span style="color:${color}">${inner}</span>`,
    )
    .replace(/⟦s:(\d{1,3})⟧([\s\S]*?)⟦\/s⟧/g, (_m, size: string, inner: string) => {
      const px = Math.min(48, Math.max(10, Number(size)))
      return `<span style="font-size:${px}px">${inner}</span>`
    })
    .replace(/⟦sup⟧([\s\S]*?)⟦\/sup⟧/g, (_m, inner: string) => `<sup>${inner}</sup>`)
    .replace(/⟦sub⟧([\s\S]*?)⟦\/sub⟧/g, (_m, inner: string) => `<sub>${inner}</sub>`)
}
