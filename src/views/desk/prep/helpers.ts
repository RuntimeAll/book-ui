// PRD-C-213 备课包页 · 页内共享纯函数 / 常量（只服务 prep/ 目录，红线：不新建全局 util）。

import type { PackSeg, SegTemplateItem, StarLevel } from '@/api/teacher/schedule'
import type { QuestionItem, QuestionDetail } from '@/api/question/index'
import type { QuestionPoolItem } from '@/api/teacher/schedule'

/**
 * 段内题目的展示元信息（题干摘要 + 星级 + 来源），本地缓存。
 * pack.segs 只存 question_id[]，摘要靠 picker 装题时就地填 / 载入包时批量补齐。
 */
export interface SegQMeta {
  id: string
  /** 富文本/纯文本题干（喂 QuestionContent 的 text） */
  stem?: string | null
  /** 题干图（老题图片渲染回落） */
  stemImg?: string | null
  /** 挂题星级 '1'|'2'|'3'（层数≠难度，缺省则不显示星） */
  starLevel?: StarLevel | null
  /** 来源（source_ref / 卷名） */
  sourceRef?: string | null
  /** 专项标签 topic_tag */
  topicTag?: string | null
  questionType?: number | null
  difficult?: number | null
}

/**
 * 从课次 seg_template 生成的兜底三段骨架（无法拿到课次数据时用）。
 * 契约 §二 seg_template 样例：思维题 / 奥数专项 / 课内同步。
 */
export const DEFAULT_SEG_TEMPLATE: SegTemplateItem[] = [
  { name: '思维题', style: '开场 1 道 · 单点突破 · 一题一坑', topic: '' },
  { name: '奥数专项', style: '书挑题 · ★ 分层', topic: '' },
  { name: '课内同步', style: '收尾过关 · 简单不费脑', topic: '' },
]

/** seg_template / 空骨架 → 空 pack.segs（question_ids 全空） */
export function segsFromTemplate(tpl: SegTemplateItem[] | undefined | null): PackSeg[] {
  const src = tpl && tpl.length ? tpl : DEFAULT_SEG_TEMPLATE
  return src.map((t) => ({
    name: t.name || '',
    style: t.style || '',
    question_ids: [],
    rules: '',
    note: t.topic ? `主题：${t.topic}` : '',
  }))
}

/** 段序号 → 色调 class（① teal-soft / ② teal 实心 / ③+ 灰） */
export function segKClass(i: number): 'w' | 'm' | 's' {
  return i === 0 ? 'w' : i === 1 ? 'm' : 's'
}

/** 圈号前缀（①②③④） */
const CIRCLED = ['①', '②', '③', '④', '⑤']
export function segMark(i: number): string {
  return CIRCLED[i] ?? `${i + 1}.`
}

/** 星级码 → ★ 串（'2' → ★★）；缺省返空串 */
export function starText(lv?: StarLevel | null): string {
  if (!lv) return ''
  const n = Number(lv)
  return n > 0 ? '★'.repeat(n) : ''
}

/** QuestionItem（题库检索结果）→ SegQMeta */
export function metaFromQuestionItem(q: QuestionItem): SegQMeta {
  const anyQ = q as QuestionItem & {
    starLevel?: string | null
    sourceRef?: string | null
    topicTag?: string | null
  }
  return {
    id: String(q.id),
    stem: q.stemTextContent ?? q.stemText ?? null,
    stemImg: q.stemImg ?? null,
    starLevel: (anyQ.starLevel as StarLevel) ?? null,
    sourceRef: anyQ.sourceRef ?? q.examPaperName ?? null,
    topicTag: anyQ.topicTag ?? null,
    questionType: q.questionType ?? null,
    difficult: q.difficult ?? null,
  }
}

/** QuestionPoolItem（私有题池结果）→ SegQMeta */
export function metaFromPoolItem(q: QuestionPoolItem): SegQMeta {
  return {
    id: String(q.id),
    stem: q.stem ?? null,
    stemImg: null,
    starLevel: q.starLevel ?? null,
    sourceRef: q.sourceRef ?? null,
    topicTag: q.topicTag ?? null,
    questionType: q.questionType != null ? Number(q.questionType) : null,
    difficult: q.difficulty != null ? Number(q.difficulty) : null,
  }
}

/**
 * QuestionDetail（按 ids 批量补齐）→ SegQMeta。
 * ⚠️ star_level / source_ref / topic_tag 是 biz_question ALTER 新列，
 * /teacher/question/list 是否回填未定 → 防御式读取，缺则降级（不显星/来源）。
 */
export function metaFromDetail(q: QuestionDetail): SegQMeta {
  const anyQ = q as QuestionDetail & {
    starLevel?: string | null
    sourceRef?: string | null
    topicTag?: string | null
  }
  return {
    id: String(q.id),
    stem: q.stemTextContent ?? q.stemText ?? null,
    stemImg: q.stemImg ?? null,
    starLevel: (anyQ.starLevel as StarLevel) ?? null,
    sourceRef: anyQ.sourceRef ?? q.examPaperName ?? null,
    topicTag: anyQ.topicTag ?? null,
    questionType: q.questionType ?? null,
    difficult: q.difficult ?? null,
  }
}
