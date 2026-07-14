/**
 * richtext.ts — Markdown + LaTeX 富文本渲染工具
 *
 * 用途：AI 入库题的题干/答案/解析是 Markdown + $..$ / $$..$$ LaTeX 格式。
 * 老 misikt 题用图片（stemImg/answerImg/explainImg），走独立路径，本模块不涉及。
 *
 * 渲染顺序：
 *   1.  先把文本中的 $$...$$ 和 $..$ 替换为 KaTeX 渲染的 HTML 字符串（占位保护）
 *   1.5 交给 markdown-it 前兜底：补注入缺失的表格分隔行 + 关闭下划线强调（转义裸 _，保留 *）
 *   2.  再过 markdown-it（html: false 防注入）
 *   3.  输出原始 HTML 字符串，调用方必须通过 v-safe-html 指令渲染，禁裸 v-html
 *
 * 注意：KaTeX 的 throwOnError=false，遇到无效 LaTeX 降级渲染原文，不崩组件。
 */
import katex from 'katex'
// PRD-C-212 V0：katex CSS 从 main.ts 下沉到这里 —— 谁用本模块渲染公式，谁的 chunk 背这份 CSS
import 'katex/dist/katex.min.css'
import MarkdownIt from 'markdown-it'
import { normalizeMath } from '@/utils/mathNormalize'

// markdown-it 实例：html:false 防注入；linkify 自动识别 URL；breaks 换行=<br>
// 注：markdown-it 无「只关下划线强调、保留星号」的配置项，下划线强调改在预处理层
// 用 escapeUnderscoreEmphasis 转义裸 `_` 关闭（见 renderRichText Step 1.5）。
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

  // ── Step 0：净化口径与聊天页(MarkdownMath)对齐（P2，2026-06-18 SSOT util）──
  // 此前 renderRichText 只认 $...$，不做 \(\)→$ / 字面 \n→换行 / $ 外裸 \quad 清除，
  // 导致同一题聊天页正常、题库/卷库/PDF 面裸露。统一过 normalizeMath（与 BE 同口径）。
  text = normalizeMath(text)

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
        // strict:'ignore' 压掉 ℃/※ 等字符的『Unrecognized Unicode character』控制台噪声。
        // （豆腐块显示的彻底修属数据侧改写 ^\circ\mathrm{C}，非本项。）
        strict: 'ignore',
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
        // 同上：strict:'ignore' 降 ℃/※ 等 Unrecognized Unicode character 控制台噪声。
        strict: 'ignore',
      })
      return makePlaceholder(`<span class="math-inline">${rendered}</span>`)
    } catch {
      return makePlaceholder(`<span class="math-inline math-error">$${formula}$</span>`)
    }
  })

  // ── Step 1.5：交给 markdown-it 前的两处兜底（此时 LaTeX 已占位保护）──
  // (a) 表格分隔行兜底：GFM 表格要求表头行下方紧跟 | :--: | 分隔行，录题产物有时缺它，
  //     markdown-it 就把整块表格降级成普通段落（渲成字面『| 日期 | 2月10日 |』管道汤）。
  //     🔴 根因在录题侧（产物缺分隔行），此处按表头列数补注入仅前端兜底。
  result = injectMissingTableSeparators(result)
  // (b) 关闭下划线强调：markdown-it 默认把 `_`/`__` 当强调符，教师改题手打 `__答案__`
  //     会被吃成 <strong>粗体</strong>。本书填空全走 LaTeX \underline（无裸下划线），
  //     此为潜在触发面兜底——转义裸 `_` 关闭下划线强调，`*` 号强调保留。
  result = escapeUnderscoreEmphasis(result)

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

/**
 * 表格分隔行兜底：GFM 表格要求表头行下方紧跟 `| --- | --- |` 分隔行，
 * 录题产物有时缺它，markdown-it 会把整块降级成字面『管道汤』。
 * 这里检测「表头行（上一行不是表格行）+ 下一行是表格行但不是分隔行」，按列数补注入分隔行。
 * 此时 LaTeX 已占位保护，不会误伤公式内的 `|`。
 */
function injectMissingTableSeparators(src: string): string {
  const lines = src.split('\n')
  const isRow = (l: string): boolean => /^\s*\|.*\|\s*$/.test(l)
  const isSep = (l: string): boolean => /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(l)
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    out.push(line)
    if (isRow(line) && !isSep(line)) {
      const prev = i > 0 ? lines[i - 1] : ''
      const next = i + 1 < lines.length ? lines[i + 1] : ''
      // 表头判定：当前是表格行、上一行不是表格行（表格从这里起）、下一行是表格行但不是分隔行
      if (!isRow(prev) && isRow(next) && !isSep(next)) {
        const cols = line.split('|').length - 2 // `| a | b |` → 4 段 → 2 列
        if (cols >= 1) out.push('|' + ' --- |'.repeat(cols))
      }
    }
  }
  return out.join('\n')
}

/**
 * 关闭下划线强调：markdown-it 默认把 `_`/`__` 当强调符，教师改题手打 `__答案__`
 * 或填空 `______` 紧贴 CJK 会被吃成 `<strong>` 粗体 / 下划线消失。
 * 转义裸 `_` → `\_`（markdown 渲染为字面下划线），`*` 号强调保留。
 * 此时 LaTeX 已占位保护（￾MATH…￾ 内无下划线），不会误伤公式。
 */
function escapeUnderscoreEmphasis(src: string): string {
  return src.replace(/(?<!\\)_/g, '\\_')
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
