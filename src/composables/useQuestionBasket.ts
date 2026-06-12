/**
 * useQuestionBasket — 试题栏全局共享状态 composable
 *
 * ╔══ PRD-A-010 T3 合并审查标记（🔴 本卡仅标记重叠、不真合）═══════════════════╗
 * ║ basket 三件套职责与重叠边界：                                              ║
 * ║  • useQuestionBasket（本文件，题级 / 试题栏）                              ║
 * ║  • usePaperBasket（卷级 / 试卷篮）  ← 与本文件【高度重叠】                  ║
 * ║  • useBasketWorkbench（工作台数据层）← usePaperBasket 的【消费者】，职责正交 ║
 * ║                                                                            ║
 * ║ 【重叠边界】本文件 与 usePaperBasket 是同一套 module-singleton + LS 双 key  ║
 * ║   + 乐观更新模式的镜像复刻。逐一对称的部分（合并时可抽 createBasket<T> 泛型   ║
 * ║   工厂消重）：                                                              ║
 * ║     readBasketIdsFromStorage / writeBasketIdsToStorage                      ║
 * ║     readBasketCacheFromStorage / writeBasketCacheToStorage                  ║
 * ║     _basketIds / _cache / _togglingIds / _dialogVisible / _count / _items   ║
 * ║     syncToStorage / syncFromServer / add / remove / clear / isLoading       ║
 * ║     openDialog / closeDialog（签名仅实体泛型 QuestionItem↔PaperListItem 不同）║
 * ║   本文件【独有】：addMany（批量加入）、composeAndDownload（一键组卷跳转）。  ║
 * ║   usePaperBasket【独有】：BASKET_MAX=20 上限自查、跨 tab storage 事件同步、   ║
 * ║     refreshFromServer（BE 为准刷新）、apiEmpty/cancel。                      ║
 * ║                                                                            ║
 * ║ 【为什么本卡不合】二者都在生产路径使用（题库/详情/FAB ↔ 卷库/FAB/dialog），  ║
 * ║   非死代码。贸然抽泛型工厂会触动两条独立业务流的回归面（PRD-A-001 删旧组件   ║
 * ║   漏隐性职责返工的同类风险）。真合需单独立卡：先抽 createBasket<T,EmptyItem> ║
 * ║   工厂收敛 LS/state/CRUD，再让两 composable 各自注入差异（上限/跨tab/端点/   ║
 * ║   addMany/compose），配 book-test 双篮回归绿后切换。                        ║
 * ╚════════════════════════════════════════════════════════════════════════════╝
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

// PRD-A-013 T2 — id 雪花全工程 string；LS 旧数据可能是 number 数组，
// 解析时统一 String(...) 规范化保兼容（用户旧版升新版不丢篮）。
function readBasketIdsFromStorage(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_BASKET_IDS)
    if (!raw) return new Set()
    const arr: unknown[] = JSON.parse(raw)
    return new Set(Array.isArray(arr) ? arr.map((x) => String(x)) : [])
  } catch {
    return new Set()
  }
}

function writeBasketIdsToStorage(ids: Set<string>) {
  try {
    localStorage.setItem(LS_BASKET_IDS, JSON.stringify([...ids]))
  } catch (e) {
    console.warn('[basket] localStorage write ids failed', e)
  }
}

function readBasketCacheFromStorage(): Map<string, QuestionItem> {
  try {
    const raw = localStorage.getItem(LS_BASKET_CACHE)
    if (!raw) return new Map()
    const arr: [unknown, QuestionItem][] = JSON.parse(raw)
    if (!Array.isArray(arr)) return new Map()
    // 旧 LS key 可能是 number，统一 String 规范化
    return new Map(arr.map(([k, v]) => [String(k), { ...v, id: String(v.id) }]))
  } catch {
    return new Map()
  }
}

function writeBasketCacheToStorage(cache: Map<string, QuestionItem>) {
  try {
    localStorage.setItem(LS_BASKET_CACHE, JSON.stringify([...cache.entries()]))
  } catch (e) {
    console.warn('[basket] localStorage write cache failed', e)
  }
}

// ── module-scoped singleton state ───────────────────────────
// PRD-A-013 T2 — Set/Map key 改 string（雪花 ID）
const _basketIds = ref<Set<string>>(readBasketIdsFromStorage())
const _cache = new Map<string, QuestionItem>(readBasketCacheFromStorage())
const _togglingIds: Set<string> = new Set()
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
  // PRD-A-013 T2 — Map key string（雪花）
  const filtered = new Map<string, QuestionItem>()
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
/**
 * 加入试题栏。
 * @param opts.silent 抑制默认「已加入试题栏」toast（PRD-C-014 T2：举一反三透明入库要自定义
 *   文案「已收录并加入试题篮」/「已加入试题篮」，由调用方自行 toast；篮 API 失败需调用方感知
 *   → silent 模式下 await BE add 并在失败时 throw，调用方据此「篮不计数 + 报错气泡」）。
 */
async function add(q: QuestionItem, opts?: { silent?: boolean }): Promise<void> {
  if (_togglingIds.has(q.id)) return
  if (_basketIds.value.has(q.id)) return
  _togglingIds.add(q.id)
  try {
    if (opts?.silent) {
      // 透明入库（T2）：先 await BE add，成功才本地计数 + 由调用方自定义 toast；失败 throw 回调用方。
      await apiAddBasket(q.id)
      const newSet = new Set(_basketIds.value)
      newSet.add(q.id)
      _basketIds.value = newSet
      _cache.set(q.id, q)
      syncToStorage()
      return
    }
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

/**
 * 批量加入（PRD-001 回归补丁 — 快速组卷 / 中栏"全部加入"复用）。
 * 过滤掉已在篮内的，单条汇总 toast（避免 N 条刷屏），返回实际新增数。
 */
async function addMany(questions: QuestionItem[]): Promise<number> {
  const toAdd = questions.filter((q) => !_basketIds.value.has(q.id))
  if (toAdd.length === 0) {
    ElMessage.info('所选题目均已在试题栏中')
    return 0
  }
  const newSet = new Set(_basketIds.value)
  toAdd.forEach((q) => {
    newSet.add(q.id)
    _cache.set(q.id, q)
  })
  _basketIds.value = newSet
  syncToStorage()
  ElMessage.success(`已加入 ${toAdd.length} 题到试题栏`)
  toAdd.forEach((q) =>
    apiAddBasket(q.id).catch((e) =>
      console.warn('[basket] addBasket notify failed (local state OK):', e),
    ),
  )
  return toAdd.length
}

/**
 * 批量移除（PRD-001 回归补丁 — 快速组卷 / 中栏"全部移除"复用）。
 * 只移除在篮内的，单条汇总 toast，返回实际移除数。
 */
// PRD-A-013 T2 — ids 雪花 string[]
async function removeMany(ids: string[]): Promise<number> {
  const toRemove = ids.filter((id) => _basketIds.value.has(id))
  if (toRemove.length === 0) {
    ElMessage.info('这些题目不在试题栏中')
    return 0
  }
  const newSet = new Set(_basketIds.value)
  toRemove.forEach((id) => newSet.delete(id))
  _basketIds.value = newSet
  syncToStorage()
  ElMessage.success(`已从试题栏移除 ${toRemove.length} 题`)
  toRemove.forEach((id) =>
    apiRemoveBasket(id).catch((e) =>
      console.warn('[basket] removeBasket notify failed (local state OK):', e),
    ),
  )
  return toRemove.length
}

// PRD-A-013 T2 — id 雪花 string
async function remove(id: string): Promise<void> {
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

// PRD-A-013 T2 — id 雪花 string
function isLoading(id: string): boolean {
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
// PRD-A-013 T2 — 雪花 ID 全工程 string；Set / Map key + 函数签名联动改 string。
export interface UseQuestionBasket {
  basketIds: Readonly<Ref<Set<string>>>
  count: ComputedRef<number>
  items: ComputedRef<QuestionItem[]>
  add: (q: QuestionItem, opts?: { silent?: boolean }) => Promise<void>
  /** 批量加入（过滤已在篮 + 单条汇总 toast），返回实际新增数 */
  addMany: (questions: QuestionItem[]) => Promise<number>
  /** 批量移除（只移在篮内 + 单条汇总 toast），返回实际移除数 */
  removeMany: (ids: string[]) => Promise<number>
  remove: (id: string) => Promise<void>
  clear: () => Promise<void>
  togglingIds: Set<string>
  isLoading: (id: string) => boolean
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
    basketIds: _basketIds as Readonly<Ref<Set<string>>>,
    count: _count,
    items: _items,
    add,
    addMany,
    removeMany,
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
