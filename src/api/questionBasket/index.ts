import request from '@/http/request'
import type { QuestionDetail, QuestionItem } from '@/api/question'
import { normalizeQuestionScore } from './numeric'

export const BASKET_PAGE_SIZE = 50
export const BASKET_BATCH_SIZE = 100
export const BASKET_MAX_SIZE = 500

export interface SelectionReference {
  questionId: string
  sourceBookId?: string
  sourceItemId?: string
}

export interface BasketEntry extends SelectionReference {
  entryKey: string
  basketEntryId: string
  question: QuestionDetail
}

export interface BasketEntryReference {
  entryKey: string
  basketEntryId: string
}

export interface BasketQuestion extends QuestionDetail {
  entryKey: string
  basketEntryId: string
  sourceBookId?: string
  sourceItemId?: string
  basketNamespace?: string
}

export interface BasketPage {
  list: BasketEntry[]
  total: number
  pageIndex: number
  pageSize: number
}

export function selectionKey(q: Pick<QuestionItem, 'id' | 'sourceItemId'>): string {
  return q.sourceItemId ? `shelf:${q.sourceItemId}` : `q:${q.id}`
}

export function selectionReference(q: QuestionItem): SelectionReference {
  return {
    questionId: q.id,
    ...(q.sourceBookId ? { sourceBookId: q.sourceBookId } : {}),
    ...(q.sourceItemId ? { sourceItemId: q.sourceItemId } : {}),
  }
}

export function basketQuestion(entry: BasketEntry): BasketQuestion {
  return {
    ...normalizeQuestionScore(entry.question),
    id: entry.questionId,
    entryKey: entry.entryKey,
    basketEntryId: entry.basketEntryId,
    sourceBookId: entry.sourceBookId,
    sourceItemId: entry.sourceItemId,
  }
}

const BASE = '/teacher/question/basket'

export async function getBasketKeys(namespace: string, signal?: AbortSignal): Promise<string[]> {
  const result = await request.get<{ entryKeys: string[] }, { entryKeys: string[] }>(`${BASE}/keys`, {
    params: { namespace },
    signal,
  })
  if (
    !Array.isArray(result.entryKeys) ||
    result.entryKeys.length > BASKET_MAX_SIZE ||
    result.entryKeys.some((key) => typeof key !== 'string' || !key) ||
    new Set(result.entryKeys).size !== result.entryKeys.length
  ) {
    throw new Error('试题栏成员数据不完整，请重新载入')
  }
  return result.entryKeys
}

export const getBasketEntries = (namespace: string, pageIndex: number, signal?: AbortSignal) =>
  request.get<BasketPage, BasketPage>(`${BASE}/entries`, {
    params: { namespace, pageIndex, pageSize: BASKET_PAGE_SIZE },
    signal,
  })

export const addBasketEntries = (namespace: string, items: SelectionReference[]) =>
  request.post<{ addedCount: number }, { addedCount: number }>(`${BASE}/entries`, {
    namespace,
    items,
  })

export const removeBasketEntries = (namespace: string, entryKeys: string[]) =>
  request.post<void, void>(`${BASE}/remove`, { namespace, entryKeys })

export const removeBasketEntryVersions = (namespace: string, entries: BasketEntryReference[]) =>
  request.post<void, void>(`${BASE}/remove-entries`, { namespace, entries })

export const emptyBasketEntries = (namespace: string) =>
  request.post<void, void>(`${BASE}/empty`, { namespace })
