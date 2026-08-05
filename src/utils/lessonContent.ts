/**
 * PRD-018 D14 · 上课内容拆条（**FE 侧规则唯一实现处**）。
 *
 * > 2026-08-05 用户拍板：「课程内容展示增加格式，弄好看一点，里面的排版太乱了」。
 *
 * 台账/导出单里的「内容」是老师随手记的一长串，真实数据两种形态：
 * ```
 *   ① 思维题：大数的计算及灵活运用｜同步：大数的认识和改写｜拓展奥数：定义新运算、错题回顾
 *   ② 1.100 以内的加减　2.100 以内的退位加减　3.找规律
 * ```
 * 挤成一坨谁也读不下去 —— 拆成条、把「XX：」认成分类标签，家长扫一眼就知道这节讲了几块。
 *
 * 🔴 **规则与 BE `TuitionAccountService.parseContentSegs` 一一对应**（导出 PNG 走 Java 那份）。
 *    改这里必须同步改那边，否则「屏上分三行、单子上还是一坨」。
 * 🔴 **只做展示层拆分，一个字都不改**：拆不出来就原样单条返回，绝不猜、绝不补标点。
 * 🔴 误拆防线（血的教训在数据里）：
 *    - 「1.100 以内的加减」的 `.` 是**序号点**，`100` 是正文 —— 序号必须在**串首或空白之后**才算；
 *    - 「圆周率 3.14」「9:00 上课」不能被当成序号/标签 —— 故要求 ≥2 条、首个序号在串首、
 *      序号递增，标签长 2–8 字且非纯数字。
 */

/** 内容里的一条。 */
export interface ContentSeg {
  /** 序号形态的条目号（「1.100 以内的加减」的 '1'）；无则 null */
  ord: string | null
  /** 「XX：」分类标签（「思维题：大数的计算」的 '思维题'）；无则 null */
  label: string | null
  /** 正文（已去掉序号与标签前缀） */
  text: string
}

/** 「N.」条目标记：串首 或 前面是空白（含全角空格 　）才算。 */
const NUM_ITEM = /(?:^|(?<=[\s　]))(\d{1,2})\s*[.．、]\s*/g

/** 分类标签上限字数（「拓展奥数」4 字；更长多半是句子里正好有个冒号）。 */
const LABEL_MAX = 8

/** 认「XX：」分类标签（长 2–8 字、非纯数字、后面还有正文才算）。 */
function labelOf(ord: string | null, text: string): ContentSeg {
  let i = text.indexOf('：')
  if (i < 0) i = text.indexOf(':')
  if (i >= 2 && i <= LABEL_MAX && i + 1 < text.length) {
    const label = text.slice(0, i).trim()
    const body = text.slice(i + 1).trim()
    if (label && body && !/^\d+$/.test(label)) return { ord, label, text: body }
  }
  return { ord, label: null, text }
}

/** 「N.」形态拆条；不成立（少于 2 条 / 首个序号不在串首 / 序号不递增）返 []。 */
function numberedSegs(s: string): ContentSeg[] {
  const marks: { start: number; textStart: number; ord: number }[] = []
  NUM_ITEM.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = NUM_ITEM.exec(s)) !== null) {
    marks.push({ start: m.index, textStart: m.index + m[0].length, ord: parseInt(m[1], 10) })
  }
  if (marks.length < 2 || marks[0].start !== 0) return []
  for (let i = 1; i < marks.length; i++) {
    // 序号不递增 = 多半是小数/时刻被误命中（如「买 2.5 斤 和 1.5 斤」）
    if (marks[i].ord <= marks[i - 1].ord) return []
  }
  const out: ContentSeg[] = []
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : s.length
    const text = s.slice(marks[i].textStart, end).trim()
    if (text) out.push(labelOf(String(marks[i].ord), text))
  }
  return out.length < 2 ? [] : out
}

/**
 * 拆条主入口。空串 / null → `[]`（调用方渲染「—」）；拆不出来 → 单条原样。
 */
export function parseLessonContent(raw: string | null | undefined): ContentSeg[] {
  if (!raw || !raw.trim()) return []
  const s = raw.trim()
  if (s.includes('｜') || s.includes('|')) {
    const out = s
      .split(/[｜|]/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => labelOf(null, p))
    return out.length ? out : [labelOf(null, s)]
  }
  const numbered = numberedSegs(s)
  if (numbered.length) return numbered
  return [labelOf(null, s)]
}

/**
 * 是否值得分行渲染（单条纯文本就照原样一行，别为一句话套一层结构）。
 */
export function isMultiSeg(segs: ContentSeg[]): boolean {
  return segs.length > 1 || (segs.length === 1 && (!!segs[0].label || !!segs[0].ord))
}
