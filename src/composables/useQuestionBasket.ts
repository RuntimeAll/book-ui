/**
 * useQuestionBasket — 试题栏全局共享状态 composable
 *
 * 设计：module-scoped singleton（state 在模块顶层声明，多页面调 useQuestionBasket()
 * 返回同一份 reactive 引用）→ 题库列表页 / 详情页 / 全局 FAB 实时联动。
 *
 * 持久化：localStorage 双 key
 *   - LS_BASKET_IDS: number[]                   (Set<number> serialize)
 *   - LS_BASKET_CACHE: [number, QuestionItem][] (Map<number, QuestionItem> serialize)
 *
 * 网络：addBasket / removeBasket / basketNum / genExamData
 *   - 乐观更新：本地 state 先更新 + toast，API 失败仅 console.warn 不回滚
 *   - togglingIds 防连点
 *
 * 抽离自第十二波前的 src/views/question/index.vue（行 32-72 持久化、行 253-410 state + actions）。
 */
import { ref, computed, type Ref, type ComputedRef } from 'vue'
import { ElMessage } from 'element-plus'
import router from '@/router/index'
import {
  basketNum,
  addBasket as apiAddBasket,
  removeBasket as apiRemoveBasket,
  genExamData,
  type QuestionItem,
} from '@/api/question/index'

// ── localStorage keys ───────────────────────────────────────
const LS_BASKET_IDS = 'book-ui:basket-ids'
const LS_BASKET_CACHE = 'book-ui:basket-cache'

function readBasketIdsFromStorage(): Set<number> {
  try {
    const raw = localStorage.getItem(LS_BASKET_IDS)
    if (!raw) return new Set()
    const arr: number[] = JSON.parse(raw)
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

function writeBasketIdsToStorage(ids: Set<number>) {
  try {
    localStorage.setItem(LS_BASKET_IDS, JSON.stringify([...ids]))
  } catch (e) {
    console.warn('[basket] localStorage write ids failed', e)
  }
}

function readBasketCacheFromStorage(): Map<number, QuestionItem> {
  try {
    const raw = localStorage.getItem(LS_BASKET_CACHE)
    if (!raw) return new Map()
    const arr: [number, QuestionItem][] = JSON.parse(raw)
    return new Map(Array.isArray(arr) ? arr : [])
  } catch {
    return new Map()
  }
}

function writeBasketCacheToStorage(cache: Map<number, QuestionItem>) {
  try {
    localStorage.setItem(LS_BASKET_CACHE, JSON.stringify([...cache.entries()]))
  } catch (e) {
    console.warn('[basket] localStorage write cache failed', e)
  }
}

// ── module-scoped singleton state ───────────────────────────
const _basketIds = ref<Set<number>>(readBasketIdsFromStorage())
const _cache = new Map<number, QuestionItem>(readBasketCacheFromStorage())
const _togglingIds: Set<number> = new Set()
const _dialogVisible = ref(false)
let _initialized = false

// ── 派生 ─────────────────────────────────────────────────────
const _count = computed(() => _basketIds.value.size)
const _items = computed<QuestionItem[]>(() => {
  const items: QuestionItem[] = []
  _basketIds.value.forEach((id) => {
    const q = _cache.get(id)
    if (q) {
      items.push(q)
    } else {
      items.push({
        id,
        questionType: 1,
        difficult: null,
        stemImg: null,
        stemText: `题目 ID: ${id}（题干数据加载中）`,
      } as QuestionItem)
    }
  })
  return items
})

// ── 持久化 helper（每次 ids 变化触发） ───────────────────────
function syncToStorage() {
  writeBasketIdsToStorage(_basketIds.value)
  // 只保留 basket 内的题目 cache（避免无限增长）
  const filtered = new Map<number, QuestionItem>()
  _basketIds.value.forEach((id) => {
    const q = _cache.get(id)
    if (q) filtered.set(id, q)
  })
  writeBasketCacheToStorage(filtered)
}

// ── 同步 server 角标（启动 + 可主动调） ─────────────────────
async function syncFromServer() {
  try {
    const res = await basketNum()
    let serverCount = 0
    if (typeof res === 'number') {
      serverCount = res
    } else if (res && typeof res === 'object') {
      const r = res as Record<string, unknown>
      serverCount = Number(r['count'] ?? r['basketNum'] ?? 0)
    }
    // 当前实现：信任本地 ids（misikt basketNum 只返数字无 id 列表）
    // 仅 console 用于调试
    if (serverCount !== _basketIds.value.size) {
      console.info('[basket] server count', serverCount, 'local size', _basketIds.value.size)
    }
  } catch (e) {
    console.warn('[basket] syncFromServer failed', e)
  }
}

// ── actions ──────────────────────────────────────────────────
async function add(q: QuestionItem): Promise<void> {
  if (_togglingIds.has(q.id)) return
  if (_basketIds.value.has(q.id)) return
  _togglingIds.add(q.id)
  try {
    const newSet = new Set(_basketIds.value)
    newSet.add(q.id)
    _basketIds.value = newSet
    _cache.set(q.id, q)
    syncToStorage()
    ElMessage.success('已加入试题栏')
    apiAddBasket(q.id).catch((e) =>
      console.warn('[basket] addBasket notify failed (local state OK):', e),
    )
  } finally {
    _togglingIds.delete(q.id)
  }
}

async function remove(id: number): Promise<void> {
  if (_togglingIds.has(id)) return
  if (!_basketIds.value.has(id)) return
  _togglingIds.add(id)
  try {
    const newSet = new Set(_basketIds.value)
    newSet.delete(id)
    _basketIds.value = newSet
    syncToStorage()
    ElMessage.success('已从试题栏移除')
    apiRemoveBasket(id).catch((e) =>
      console.warn('[basket] removeBasket notify failed (local state OK):', e),
    )
  } finally {
    _togglingIds.delete(id)
  }
}

async function clear(): Promise<void> {
  _basketIds.value = new Set()
  _cache.clear()
  writeBasketIdsToStorage(new Set())
  writeBasketCacheToStorage(new Map())
  ElMessage.success('已清空试题栏')
}

function isLoading(id: number): boolean {
  return _togglingIds.has(id)
}

function openDialog() {
  _dialogVisible.value = true
}

function closeDialog() {
  _dialogVisible.value = false
}

// ── composeAndDownload — 一键组卷，调 genExamData，存草稿，跳 /papers/edit ──
async function composeAndDownload(): Promise<void> {
  if (_items.value.length === 0) {
    ElMessage.warning('试题栏为空，请先加题')
    return
  }
  try {
    let examData: unknown = null
    try {
      examData = await genExamData()
    } catch (e) {
      console.warn('[compose] genExamData failed, using local basket data', e)
    }
    const paperDraft = {
      questions: _items.value.map((q) => ({ ...q, score: 0 })),
      examData,
      createdAt: new Date().toISOString(),
    }
    localStorage.setItem('paperDraft', JSON.stringify(paperDraft))
    _dialogVisible.value = false
    router.push('/papers/edit')
  } catch (e) {
    console.warn('[compose] composeAndDownload failed', e)
  }
}

// ── 暴露接口 ────────────────────────────────────────────────
export interface UseQuestionBasket {
  basketIds: Readonly<Ref<Set<number>>>
  count: ComputedRef<number>
  items: ComputedRef<QuestionItem[]>
  add: (q: QuestionItem) => Promise<void>
  remove: (id: number) => Promise<void>
  clear: () => Promise<void>
  togglingIds: Set<number>
  isLoading: (id: number) => boolean
  dialogVisible: Ref<boolean>
  openDialog: () => void
  closeDialog: () => void
  syncFromServer: () => Promise<void>
  composeAndDownload: () => Promise<void>
}

export function useQuestionBasket(): UseQuestionBasket {
  // J 卡 段① 选项 1：不再启动自动 sync BE — 信任本地 LS 为准。
  // 原因（详 PRD/2026-05-22-J-page-response-optimize/PRD.md §0.1）：
  //   - 用户反馈：第二波部署后 FAB 角标"刚开始 4，过几秒变 12"，
  //     原因是历史脏数据使 BE basket 跟本地 LS 不一致
  //   - 架构上 add/remove 已经是乐观更新（本地优先），sync 反过来"以 BE 为准"是架构矛盾
  //   - 跨设备真同步不在 V0 范围 — 未来要做立专门卡（带冲突解决 + 版本号）
  // syncFromServer 函数保留供 caller 手动 explicit 触发（如未来"刷新 basket"按钮）
  if (!_initialized) {
    _initialized = true
  }
  return {
    basketIds: _basketIds as Readonly<Ref<Set<number>>>,
    count: _count,
    items: _items,
    add,
    remove,
    clear,
    togglingIds: _togglingIds,
    isLoading,
    dialogVisible: _dialogVisible,
    openDialog,
    closeDialog,
    syncFromServer,
    composeAndDownload,
  }
}
