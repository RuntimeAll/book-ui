import type { QuestionDetail } from '@/api/question'

/** 后端 BigDecimal 序列化为字符串；只在分数字段转换，不处理任何 ID。 */
export function scoreValue(value: unknown, fallback = 0): number {
  if (value == null) return fallback
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value))) {
    throw new Error('服务器返回了无效分值')
  }
  const score = Number(value)
  if (!Number.isFinite(score) || score < 0) throw new Error('服务器返回了无效分值')
  return score
}

export function normalizeQuestionScore<T extends QuestionDetail>(question: T): T {
  return question.score == null ? question : { ...question, score: scoreValue(question.score) }
}
