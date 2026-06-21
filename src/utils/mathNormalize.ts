/**
 * mathNormalize.ts — 富文本 LaTeX 净化的单一事实源（SSOT）
 *
 * 背景（A1/P2，2026-06-18）：举一反三 / 入库题的富文本在「聊天页(MarkdownMath)」「题库/卷库/PDF
 *   (richtext.renderRichText)」两套渲染面分别走过两份不一致的净化，导致同一题某些面正常、某些面裸露。
 *   现把净化口径收敛到本文件，两处渲染面共用，且与 toolkit BE `_sanitize_rich_text`（variant.py）
 *   口径一致（同样的「$...$ 外裸间距命令 → 空格」规则）。
 *
 * 净化项：
 *   1. \( x \) / \[ x \] → $x$ / $$x$$（markdown-it / katex 插件只认 $，且 markdown 会把 \( 反斜杠当转义吃掉）
 *   2. 字面 \n（反斜杠+n 两字符，非真换行）→ 真换行；\n 后跟小写字母的不动（\neq \nabla 等 LaTeX 命令）
 *   3. 🔴 出现在 $...$ **外** 的裸 LaTeX 间距命令（\quad \qquad \, \; \! \:）→ 普通空格；
 *      $...$ **内** 的一律原样交 KaTeX。opus 把选项写成一行 `A. 37° \quad B. 53°` 时 \quad 在 $ 外
 *      → KaTeX 不渲染、裸露，本步清除。
 */

// 切分 $$...$$ / $...$ 数学段：split 后偶数下标 = 段外文本，奇数下标 = 数学段（含定界符）。
const MATH_SPLIT_RE = /(\$\$[\s\S]+?\$\$|\$[^\n$]+?\$)/g
// 裸间距命令：\quad \qquad（后接非字母边界，防误伤 \quadword）+ \, \; \! \:
const BARE_SPACING_RE = /\\(?:qquad|quad)(?![a-zA-Z])|\\[,;!:]/g

// 🔴 2026-06-21（PRD-A-018 用户终审，数据库挖真值定位）：LLM 产 $...$ 时**闭合 $ 前留空格**，
//   如 `$\angle 1 = 44^\circ $`。@traptitech/markdown-it-katex 的行内规则要求闭合 $ 前**不能是
//   空白**（防误匹配 `$5 ... $10$` 货币）→ 整个 $...$ 不被识别为公式、裸显示源码（含 $）。这是
//   本次公式裸显示的**真根因**（衣架题无尾空格故正常，EO 题有尾空格故挂）。修 = trim 掉 $...$ 内首尾空白。
// 兼带防御：① 无参几何符号命令粘住大写标签（$\angleBOD$→$\angle BOD$，理论可能虽本次数据未出现）；
//   ② 数学段内裸 ° → ^\circ（KaTeX 数学模式不认裸 °）。
const GLUED_GEOM_RE = /\\(angle|triangle|parallel|nparallel|perp|cong|simeq|odot)(?=[A-Z])/g
const BARE_DEGREE_RE = /°/g

/** 修 $...$ **内**的常见 LLM LaTeX 脏写：trim 首尾空白(真根因)、粘连几何命令补空格、裸 ° → ^\circ。段外不碰。 */
export function fixGluedInsideMath(src: string): string {
  const parts = src.split(MATH_SPLIT_RE)
  for (let i = 1; i < parts.length; i += 2) {
    const seg = parts[i] // 奇数下标 = 数学段（含 $ 定界符）
    const dd = seg.startsWith('$$')
    const inner = dd ? seg.slice(2, -2) : seg.slice(1, -1)
    // 先补空格/转°，最后 trim（°→^\circ 会带尾空格，trim 收尾防再次顶到闭合 $）
    const fixed = inner.replace(GLUED_GEOM_RE, '\\$1 ').replace(BARE_DEGREE_RE, '^\\circ ').trim()
    parts[i] = fixed ? (dd ? `$$${fixed}$$` : `$${fixed}$`) : seg
  }
  return parts.join('')
}

/** 把 $...$ 外的裸 LaTeX 间距命令替成普通空格；$...$ 内原样。与 BE _strip_bare_spacing_outside_math 同口径。 */
export function stripBareSpacingOutsideMath(src: string): string {
  const parts = src.split(MATH_SPLIT_RE)
  for (let i = 0; i < parts.length; i += 2) {
    // 偶数下标 = 数学段外文本（split 捕获组使奇数下标为数学段）
    if (parts[i]) parts[i] = parts[i].replace(BARE_SPACING_RE, ' ')
  }
  return parts.join('')
}

/**
 * 富文本 LaTeX 归一化（SSOT）。MarkdownMath.vue 与 richtext.ts 共用。
 * 注意：段外只处理裸间距命令；段内只修「LLM 脏写」(粘连几何命令、裸 °)，其余原样交 KaTeX。
 */
export function normalizeMath(src: string): string {
  if (!src) return ''
  const s = src
    .replace(/\\\[\s*([\s\S]+?)\s*\\\]/g, (_, expr: string) => `$$${expr}$$`)
    .replace(/\\\(\s*([\s\S]+?)\s*\\\)/g, (_, expr: string) => `$${expr}$`)
    .replace(/\\n(?![a-z])/g, '\n')
  return fixGluedInsideMath(stripBareSpacingOutsideMath(s))
}
