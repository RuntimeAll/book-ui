/**
 * usePaperBasket — 试卷篮全局共享状态 composable (R 卡段②)
 *
 * 设计：module-scoped singleton（state 在模块顶层声明，多组件调 usePaperBasket()
 * 返回同一份 reactive 引用）→ 卷库列表页 / FAB / dialog 实时联动。
 *
 * 镜像复刻 useQuestionBasket.ts（试题筐）— 改 question_id → paper_id /
 * QuestionItem → PaperListItem / 端点前缀 /teacher/question → /teacher/exam/paper。
 *
 * 持久化：localStorage 双 key
 *   - LS_PAPER_BASKET_IDS:   number[]                       (Set<number> serialize)
 *   - LS_PAPER_BASKET_CACHE: [number, PaperListItem][]      (Map serialize)
 *
 * 网络：5 端点 (PRD §3.4 契约 / MSG-006 BE 完工证据)
 *   - POST /teacher/exam/paper/addBasket/{id}
 *   - POST /teacher/exam/paper/cancel/{id}
 *   - POST /teacher/exam/paper/queryBasket
 *   - POST /teacher/exam/paper/empty
 *   - POST /teacher/exam/paper/basketNum
 *
 * 关键策略：
 *   - 乐观更新：本地 state 先更新 + toast，API 失败仅 console.warn 不回滚
 *     (J 卡决策：信任 LS 不 sync BE，跨设备真同步另立专卡)
 *   - togglingIds 防连点
 *   - 上限 20（Q8 拍板）：addBasket 前自查 _basketIds.size < BASKET_MAX
 *   - 跨标签页同步：监听 storage 事件，其他 tab 改 LS 时本 tab reactive 同步
 *
 * 段② 仅交付 composable，段③④ FE worker 实装 PaperBasket/index.vue + papers/index.vue 时
 * 直接 import { usePaperBasket } from '@/composables/usePaperBasket' 调用。
 */
import { ref, computed, type Ref, type ComputedRef } from 'vue'
import { ElMessage } from 'element-plus'
import request from '@/http/request'
import type { PaperListItem } from '@/api/paper/index'

// ── 常量 ─────────────────────────────────────────────────────
const LS_PAPER_BASKET_IDS = 'book-ui:paper-basket-ids'
const LS_PAPER_BASKET_CACHE = 'book-ui:paper-basket-cache'
const BASKET_MAX = 20 // Q8 拍板：篮内上限 20

// ── BE 端点封装（PRD §3.4，BE PaperBasketController 已交付，MSG-006）──
// 段②约束：仅写 composables/usePaperBasket.ts 单文件，5 端点内嵌于此而非
// 散到 src/api/paper/index.ts（避免越权动它处）。若后续段③④ 复用频次高，
// 由组长决定是否重构提取到 api 层。

/** basketNum envelope 容三种返回风格（纯 number / {count} / {basketNum}）*/
export type PaperBasketNumResult =
  | number
  | { count: number }
  | { basketNum: number }

function apiBasketNum() {
  return request.post<PaperBasketNumResult, PaperBasketNumResult>(
    '/teacher/exam/paper/basketNum',
  )
}

function apiAdd(paperId: number) {
  return request.post<unknown, unknown>(`/teacher/exam/paper/addBasket/${paperId}`)
}

function apiCancel(paperId: number) {
  return request.post<unknown, unknown>(`/teacher/exam/paper/cancel/${paperId}`)
}

function apiQueryBasket() {
  return request.post<PaperListItem[], PaperListItem[]>(
    '/teacher/exam/paper/queryBasket',
  )
}

function apiEmpty() {
  return request.post<unknown, unknown>('/teacher/exam/paper/empty')
}

// ── localStorage 读写 ───────────────────────────────────────
function readBasketIdsFromStorage(): Set<number> {
  try {
    const raw = localStorage.getItem(LS_PAPER_BASKET_IDS)
    if (!raw) return new Set()
    const arr: number[] = JSON.parse(raw)
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

function writeBasketIdsToStorage(ids: Set<number>) {
  try {
    localStorage.setItem(LS_PAPER_BASKET_IDS, JSON.stringify([...ids]))
  } catch (e) {
    console.warn('[paper-basket] localStorage write ids failed', e)
  }
}

function readBasketCacheFromStorage(): Map<number, PaperListItem> {
  try {
    const raw = localStorage.getItem(LS_PAPER_BASKET_CACHE)
    if (!raw) return new Map()
    const arr: [number, PaperListItem][] = JSON.parse(raw)
    return new Map(Array.isArray(arr) ? arr : [])
  } catch {
    return new Map()
  }
}

function writeBasketCacheToStorage(cache: Map<number, PaperListItem>) {
  try {
    localStorage.setItem(
      LS_PAPER_BASKET_CACHE,
      JSON.stringify([...cache.entries()]),
    )
  } catch (e) {
    console.warn('[paper-basket] localStorage write cache failed', e)
  }
}

// ── module-scoped singleton state ───────────────────────────
const _basketIds = ref<Set<number>>(readBasketIdsFromStorage())
const _cache = new Map<number, PaperListItem>(readBasketCacheFromStorage())
const _togglingIds: Set<number> = new Set()
const _dialogVisible = ref(false)
let _initialized = false

// ── 派生 ─────────────────────────────────────────────────────
const _count = computed(() => _basketIds.value.size)

const _items = computed<PaperListItem[]>(() => {
  const items: PaperListItem[] = []
  _basketIds.value.forEach((id) => {
    const p = _cache.get(id)
    if (p) {
      items.push(p)
    } else {
      // BE 回包前的占位（id-only），dialog 渲染显示"加载中"
      items.push({
        id,
        name: `试卷 ID: ${id}（卷头加载中）`,
        questionCount: 0,
        score: 0,
        suggestTime: null,
        createTime: '',
        finishTime: null,
        hgScore: null,
        createUser: 0,
        directoryName: null,
        subjectId: '',
        paperType: 1,
        frameTextContentId: null,
        status: 1,
        sort: id,
      })
    }
  })
  return items
})

// ── 持久化 helper（每次 ids 变化触发）───────────────────────
function syncToStorage() {
  writeBasketIdsToStorage(_basketIds.value)
  // 只保留 basket 内的卷头 cache（避免无限增长）
  const filtered = new Map<number, PaperListItem>()
  _basketIds.value.forEach((id) => {
    const p = _cache.get(id)
    if (p) filtered.set(id, p)
  })
  writeBasketCacheToStorage(filtered)
}

// ── 跨标签页同步（其他 tab 改 LS 时本 tab reactive 同步）─────
function _onStorageEvent(e: StorageEvent) {
  if (e.key === LS_PAPER_BASKET_IDS) {
    _basketIds.value = readBasketIdsFromStorage()
  } else if (e.key === LS_PAPER_BASKET_CACHE) {
    const next = readBasketCacheFromStorage()
    _cache.clear()
    next.forEach((v, k) => _cache.set(k, v))
    // 触发 _items computed 重算（_basketIds 引用未变需手动 reassign 一次）
    _basketIds.value = new Set(_basketIds.value)
  }
}

// ── 同步 server 角标（启动 + 可主动调）────────────────────
async function syncFromServer(): Promise<void> {
  try {
    const res = await apiBasketNum()
    let serverCount = 0
    if (typeof res === 'number') {
      serverCount = res
    } else if (res && typeof res === 'object') {
      const r = res as Record<string, unknown>
      serverCount = Number(r['count'] ?? r['basketNum'] ?? 0)
    }
    // J 卡决策：信任本地 ids（BE basketNum 只返 number 无 id 列表，无法 reconcile）
    if (serverCount !== _basketIds.value.size) {
      console.info(
        '[paper-basket] server count',
        serverCount,
        'local size',
        _basketIds.value.size,
      )
    }
  } catch (e) {
    console.warn('[paper-basket] syncFromServer failed', e)
  }
}

// ── 拉服务端真实卷头列表（dialog 打开时调，补齐 _cache 占位）──
async function refreshFromServer(): Promise<void> {
  try {
    const list = await apiQueryBasket()
    if (Array.isArray(list)) {
      const newIds = new Set<number>()
      list.forEach((p) => {
        newIds.add(p.id)
        _cache.set(p.id, p)
      })
      // 用 BE 为准刷新 ids（BE queryBasket 是当前用户真实篮 — 软删卷会消失）
      _basketIds.value = newIds
      syncToStorage()
    }
  } catch (e) {
    console.warn('[paper-basket] refreshFromServer failed', e)
  }
}

// ── actions ──────────────────────────────────────────────────
async function add(paper: PaperListItem): Promise<void> {
  if (_togglingIds.has(paper.id)) return
  if (_basketIds.value.has(paper.id)) {
    ElMessage.info('该试卷已在试卷篮中')
    return
  }
  // Q8 上限 20 (BE 不强校验, FE 自查)
  if (_basketIds.value.size >= BASKET_MAX) {
    ElMessage.warning(`试卷篮最多 ${BASKET_MAX} 张，请先移除部分试卷`)
    return
  }
  _togglingIds.add(paper.id)
  try {
    const newSet = new Set(_basketIds.value)
    newSet.add(paper.id)
    _basketIds.value = newSet
    _cache.set(paper.id, paper)
    syncToStorage()
    ElMessage.success('已加入试卷篮')
    apiAdd(paper.id).catch((e) =>
      console.warn('[paper-basket] addBasket notify failed (local state OK):', e),
    )
  } finally {
    _togglingIds.delete(paper.id)
  }
}

async function remove(paperId: number): Promise<void> {
  if (_togglingIds.has(paperId)) return
  if (!_basketIds.value.has(paperId)) return
  _togglingIds.add(paperId)
  try {
    const newSet = new Set(_basketIds.value)
    newSet.delete(paperId)
    _basketIds.value = newSet
    _cache.delete(paperId)
    syncToStorage()
    ElMessage.success('已从试卷篮移除')
    apiCancel(paperId).catch((e) =>
      console.warn(
        '[paper-basket] cancelBasket notify failed (local state OK):',
        e,
      ),
    )
  } finally {
    _togglingIds.delete(paperId)
  }
}

async function clear(): Promise<void> {
  _basketIds.value = new Set()
  _cache.clear()
  writeBasketIdsToStorage(new Set())
  writeBasketCacheToStorage(new Map())
  ElMessage.success('已清空试卷篮')
  apiEmpty().catch((e) =>
    console.warn('[paper-basket] empty notify failed (local state OK):', e),
  )
}

function isLoading(paperId: number): boolean {
  return _togglingIds.has(paperId)
}

function openDialog() {
  _dialogVisible.value = true
}

function closeDialog() {
  _dialogVisible.value = false
}

// ── 暴露接口 ────────────────────────────────────────────────
export interface UsePaperBasket {
  /** 篮内 paper id 集合（reactive，只读引用，写走 add/remove/clear）*/
  basketIds: Readonly<Ref<Set<number>>>
  /** 篮内卷数 = basketIds.size */
  count: ComputedRef<number>
  /** 篮内卷头列表（按 _basketIds 顺序，未命中 cache 时返占位）*/
  items: ComputedRef<PaperListItem[]>
  /** 加入试卷篮（乐观更新 + 上限 20 自查 + BE 通知）*/
  add: (paper: PaperListItem) => Promise<void>
  /** 移除单卷（乐观更新 + BE 通知）*/
  remove: (paperId: number) => Promise<void>
  /** 清空全篮（乐观更新 + BE 通知）*/
  clear: () => Promise<void>
  /** 正在 toggle 中的 paperId（防连点用，外部读取做按钮 disable）*/
  togglingIds: Set<number>
  /** 某 paperId 是否正在 toggle */
  isLoading: (paperId: number) => boolean
  /** dialog 显隐 reactive */
  dialogVisible: Ref<boolean>
  openDialog: () => void
  closeDialog: () => void
  /** 主动同步 BE 角标（仅 console 输出 diff，不修改本地 state）*/
  syncFromServer: () => Promise<void>
  /** 主动从 BE 拉真实卷头列表刷新 _cache + _basketIds（dialog 打开时调）*/
  refreshFromServer: () => Promise<void>
  /** 篮内上限（Q8 拍板 = 20）*/
  readonly BASKET_MAX: number
}

export function usePaperBasket(): UsePaperBasket {
  // 首次调用时挂 storage 事件监听器（singleton 仅挂一次）
  if (!_initialized) {
    _initialized = true
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', _onStorageEvent)
    }
    // J 卡决策沿用：不在 init 自动 sync BE
    //   - 原因：第二波部署后 FAB 角标"刚开始 X，过几秒变 Y"，
    //     根因是历史脏数据使 BE basket 跟本地 LS 不一致
    //   - 架构上 add/remove 已是乐观更新（本地优先），sync 反过来"以 BE 为准"是架构矛盾
    //   - 跨设备真同步另立专卡（带冲突解决 + 版本号）
    //   - syncFromServer / refreshFromServer 保留供 caller 手动 explicit 触发
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
    refreshFromServer,
    BASKET_MAX,
  }
}
