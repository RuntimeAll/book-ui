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
