// ---------------------------------------------------------------------------
// 题组编辑器「规范排版」—— 纯 FE 行级文本 normalize。
//
// 🔴 边界（必须遵守）：只调换行 / 下划线 / 补括号，**不动选项语义**（不重排、不改字、
//    不解析数学）。解析不出（拿不准是选择/填空/判断）→ 原样返回，绝不报错（降级）。
//    normalize 后填回编辑框，老师可再改，保存仍走 edit-item（BE 再净化一道）。
//
// 三类处理：
//   ① 选择题：每个选项（A. / B、/ C） 独立成行（题干与选项之间留一空行）。
//   ② 填空题：把连续的下划线 / 全角空格占位 统一成标准下划线「____」（4 个半角下划线）。
//   ③ 判断题：题干尾部若无判断括号 → 补「（  ）」。
// 题型判定优先用 qtype（BE 给的题型名），不可靠时按题干文本特征兜底。
// ---------------------------------------------------------------------------

/** 标准填空下划线（4 个半角下划线） */
const BLANK = '____'

/** 选项前缀：行首 A-H + 分隔符（. 、 ． 都算），后跟内容 */
const OPTION_RE = /([A-H])\s*[.．、:：)）]\s*/g

function isChoice(stem: string, qtype: string): boolean {
  if (/选择|单选|多选/.test(qtype)) return true
  // 文本兜底：含至少 A、B 两个选项标记
  return /(^|[\s，。；、])A\s*[.．、:：)）]/.test(stem) && /(^|[\s，。；、])B\s*[.．、:：)）]/.test(stem)
}

function isBlank(stem: string, qtype: string): boolean {
  if (/填空/.test(qtype)) return true
  // 文本兜底：含连续下划线占位
  return /_{2,}|＿{2,}/.test(stem)
}

function isJudge(stem: string, qtype: string): boolean {
  return /判断|对错|正误/.test(qtype)
}

/** 填空：连续下划线 / 全角下划线 / 连续全角空格占位 → 统一标准下划线 */
function normalizeBlanks(text: string): string {
  return text
    .replace(/[_＿]{2,}/g, BLANK) // 已有的连续下划线统一长度
    .replace(/　{3,}/g, BLANK) // 3+ 全角空格当填空占位
}

/**
 * 选择题：把内联的选项拆成独立行。
 * 做法：在每个选项前缀前插换行（除非已在行首）；题干与首个选项之间补一空行。
 * 不重排选项、不改选项内容（只调换行）。
 */
function normalizeChoice(text: string): string {
  // 规整后的：在选项标记前断行
  let out = text.replace(
    /\s*(?=[A-H]\s*[.．、:：)）]\s*\S)/g,
    (m, offset: number) => {
      // 行首（offset 0 或前一字符已是换行）不加多余换行
      if (offset === 0) return ''
      return '\n'
    }
  )
  // 折叠多余空行（最多保留一个空行），去掉行尾空白
  out = out
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l, i, arr) => !(l === '' && arr[i - 1] === '')) // 连续空行折叠
    .join('\n')
  return out
}

/** 判断题：题干尾若无判断括号则补「（  ）」 */
function normalizeJudge(text: string): string {
  const trimmed = text.replace(/\s+$/, '')
  // 已含判断括号（半/全角空括号或带对错符）→ 不重复补
  if (/[（(]\s*[）)]\s*$/.test(trimmed) || /[（(].{0,3}[）)]\s*$/.test(trimmed)) return text
  return `${trimmed}（  ）`
}

/**
 * 规范排版主入口。
 * @param stem  题干原文（markdown + 可能内联 LaTeX）
 * @param qtype BE 给的题型名（可空）
 * @returns 规范化后的题干；判定不出 / 无需调整 → 原样返回
 */
export function normalizeStem(stem: string, qtype = ''): string {
  if (typeof stem !== 'string' || !stem.trim()) return stem
  const qt = qtype || ''
  try {
    if (isChoice(stem, qt)) {
      // 选择题：先统一可能的填空占位（题干里也可能有空），再拆选项行
      return normalizeChoice(normalizeBlanks(stem))
    }
    if (isJudge(stem, qt)) {
      return normalizeJudge(normalizeBlanks(stem))
    }
    if (isBlank(stem, qt)) {
      return normalizeBlanks(stem)
    }
    // 判定不出题型：保守只做下划线统一（无下划线则原样）
    return normalizeBlanks(stem)
  } catch {
    return stem // 任何异常都降级原样返回
  }
}

// ---------------------------------------------------------------------------
// 结构化编辑器支撑：选择题 stem ↔ 题干 + 选项A-D 拆/拼。
//
// 🔴 canonical（与 BE formatter / normalizeStem 一致）：
//   题干以「（ ）」收尾 + 空一行 + 每个选项独立成行「A. xxx」「B. xxx」…，answer=字母。
//   存储一行一项；2×2 是渲染层的事，不写进存储文本。
// 解析端只认行级 + 内联两种形态（与 OPTION_RE 一致），拆不出 → 整段当题干、选项空（降级不丢内容）。
// ---------------------------------------------------------------------------

/** 行首选项前缀（拆分用，锚行首；分隔符 . 、 ． ： ) 都算） */
const OPTION_LINE_RE = /^\s*([A-H])\s*[.．、:：)）]\s*(.*)$/

export interface ParsedChoice {
  /** 题干（已去掉选项段；保留尾部「（ ）」原样） */
  stem: string
  /** 选项内容数组（去掉「A.」前缀，纯内容），按 A-D… 顺序 */
  options: string[]
}

/**
 * 把 canonical 选择题 stem 拆成 题干 + 选项。
 * 优先按「整行就是一个选项」拆（canonical 一行一项）；若选项内联在一行（旧数据），
 * 先用 normalizeChoice 拆成多行再解析。拆不出选项 → options=[]、stem=原文（降级）。
 */
export function parseChoiceStem(stem: string): ParsedChoice {
  if (typeof stem !== 'string' || !stem.trim()) return { stem: stem || '', options: [] }
  // 先规范成「一行一项」，让内联选项也能按行解析
  const lines = normalizeChoice(normalizeBlanks(stem)).split('\n')
  const stemLines: string[] = []
  const options: string[] = []
  let seenOption = false
  for (const line of lines) {
    const m = line.match(OPTION_LINE_RE)
    if (m) {
      seenOption = true
      options.push(m[2].trim())
    } else if (!seenOption) {
      stemLines.push(line)
    } else {
      // 选项之后又出现非选项行（多见于选项内容换行续写）→ 接到上一个选项
      if (options.length && line.trim()) {
        options[options.length - 1] = `${options[options.length - 1]} ${line.trim()}`.trim()
      }
    }
  }
  if (!options.length) return { stem, options: [] } // 拆不出 → 整段当题干（降级）
  return { stem: stemLines.join('\n').replace(/\s+$/, ''), options }
}

/**
 * 把 题干 + 选项 回拼成 canonical stem（与 normalizeStem 选择题分支一致）：
 *   题干（保证以「（ ）」收尾）+ 空行 + 「A. opt0」「B. opt1」…（每项独立成行）。
 * 空选项不丢字母（保留「C.」空内容，让老师知道缺哪项）。
 */
export function assembleChoiceStem(stem: string, options: string[]): string {
  const letters = 'ABCDEFGH'
  let head = (stem || '').replace(/\s+$/, '')
  // 题干尾补「（ ）」：已有任意空/带字括号则不补
  if (!/[（(]\s*[）)]\s*$/.test(head) && !/[（(].{0,3}[）)]\s*$/.test(head)) {
    head = `${head}（ ）`
  }
  const optLines = options.map((o, i) => `${letters[i] || '?'}. ${(o || '').trim()}`)
  return `${head}\n\n${optLines.join('\n')}`
}

// ---------------------------------------------------------------------------
// smartMath —— 智能输入：把老师的自然写法转成 $...$ LaTeX（降低 raw LaTeX 门槛）。
//
// 🔴 边界：① 已在 $...$ 内的片段绝不重复转（先按 $ 切段，只处理偶数段=数学区外的文本）；
//          ② 转不了的原样保留，不破坏已有 LaTeX；③ 纯排版/语义安全 —— 只把明确的数学
//             写法（分数/上标/根号/比较符）包成行内公式，普通文字一律不动。
// 失焦/输入时调用，预览立等可见。
// ---------------------------------------------------------------------------

/**
 * 把「数学片段」（不在 $ 内的文本）里的常见写法逐 token 转 LaTeX，**每个 token 单独包 $...$**。
 * 🔴 只包被识别为数学的最小 token（不整段包），中文/普通文字留在公式外，避免把整句塞进 KaTeX。
 *    转不了的原样保留。已是 $...$ 的不会进到这里（smartMath 已切段）。
 */
function convertMathSegment(seg: string): string {
  let s = seg

  // ① 根号：sqrt(3) / sqrt{3} / sqrt3 → $\sqrt{3}$（(?<!\\) 防二次匹配已转出的 \sqrt{}）
  s = s.replace(/(?<!\\)sqrt\s*\(\s*([^()]+?)\s*\)/gi, (_m, x: string) => `$\\sqrt{${x.trim()}}$`)
  s = s.replace(/(?<!\\)sqrt\s*\{\s*([^{}]+?)\s*\}/gi, (_m, x: string) => `$\\sqrt{${x.trim()}}$`)
  s = s.replace(/(?<!\\)sqrt\s*([0-9a-zA-Z]+)/gi, (_m, x: string) => `$\\sqrt{${x}}$`)

  // ② 分数：a/b → $\frac{a}{b}$（两侧为数/单字母/简单 LaTeX 片段；纯多字母如 km/h、and/or 不转）
  s = s.replace(
    /(?<![$\w\\])([A-Za-z0-9]+)\s*\/\s*([A-Za-z0-9]+)(?![$\w])/g,
    (m: string, a: string, b: string) => {
      if (/^[A-Za-z]{2,}$/.test(a) && /^[A-Za-z]{2,}$/.test(b)) return m // km/h、and/or 不动
      return `$\\frac{${a}}{${b}}$`
    }
  )

  // ③ 指数：x^2 / x^{ab} / 2^10 → $x^{2}$（base 为数/字母，避免吃已在公式内的）
  s = s.replace(
    /(?<![$\\])([0-9A-Za-z])\^\{([^{}]+)\}/g,
    (_m, base: string, exp: string) => `$${base}^{${exp}}$`
  )
  s = s.replace(
    /(?<![$\\])([0-9A-Za-z])\^([0-9A-Za-z]+)/g,
    (_m, base: string, exp: string) => `$${base}^{${exp}}$`
  )

  // ④ 比较符：x<=10 → $x \le 10$（捕获符号两侧完整的数/变量 token，避免只吃一位）
  s = s.replace(
    /(\$?[A-Za-z0-9{}\\^]*)\s*(<=|>=|!=)\s*([A-Za-z0-9{}\\^-]*\$?)/g,
    (_m, l: string, op: string, r: string) => {
      const sym = op === '<=' ? '\\le' : op === '>=' ? '\\ge' : '\\ne'
      // 去掉两侧紧邻 token 可能已有的 $（与已转出的相邻 token 合并），统一重新包一层
      const lt = l.replace(/\$/g, '').trim()
      const rt = r.replace(/\$/g, '').trim()
      return `$${lt}${lt ? ' ' : ''}${sym}${rt ? ' ' : ''}${rt}$`
    }
  )

  // 合并相邻 $...$$...$（连续转出的 token）中间多余的 $$ → 留空格（实际不再产生，保险兜底）
  s = s.replace(/\$\s*\$/g, ' ')
  return s
}

/**
 * 智能输入主入口：把 text 里数学区外（不在 $...$ 内）的自然写法转成行内 $...$ LaTeX。
 * 按 $ 切段：偶数段 = 区外（可转），奇数段 = 已在 $...$ 内（原样保留、不重复包）。
 * $ 数为奇数（未闭合）→ 末段按区外处理。整体转不了 / 异常 → 原样返回。
 */
export function smartMath(text: string): string {
  if (typeof text !== 'string' || !text) return text
  try {
    const parts = text.split('$')
    if (parts.length === 1) return convertMathSegment(text)
    let out = ''
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        out += convertMathSegment(parts[i])
      } else {
        out += `$${parts[i]}$`
      }
    }
    return out
  } catch {
    return text // 任何异常降级原样返回
  }
}
