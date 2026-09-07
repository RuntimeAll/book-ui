import { computed, onScopeDispose, ref, shallowRef } from 'vue'
import {
  getBookOutline,
  getNodeItems,
  type ShelfItemPage,
  type ShelfOutlineNode,
  type ShelfOutlineVO,
  type ShelfReadingItem,
} from '@/api/shelf'

const READING_PAGE_SIZE = 20
const BULK_PAGE_SIZE = 100

interface NodePageState {
  detail?: ShelfItemPage['node']
  rows: ShelfReadingItem[]
  pageNum: number
  total: number
  hasMore: boolean
  loading: boolean
  error: boolean
}

export interface ShelfFlatNode {
  node: ShelfOutlineNode
  depth: number
  questionCount: number
}

/** Per-view data ownership. A new book invalidates every queued and in-flight read. */
export function useShelfReader() {
  const book = shallowRef<ShelfOutlineVO | null>(null)
  const loading = ref(false)
  const error = ref(false)
  const pages = ref<Record<string, NodePageState>>({})
  let generation = 0
  let controller = new AbortController()
  let queue: Promise<void> = Promise.resolve()
  const pending = new Map<string, Promise<void>>()

  const flatNodes = computed<ShelfFlatNode[]>(() => {
    const flat: ShelfFlatNode[] = []
    const stack = (book.value?.tree ?? []).map((node) => ({ node, depth: 0 })).reverse()
    while (stack.length) {
      const entry = stack.pop()!
      flat.push({ ...entry, questionCount: entry.node.questionCount })
      for (const node of [...entry.node.children].reverse()) {
        stack.push({ node, depth: entry.depth + 1 })
      }
    }
    return flat
  })
  const nodeById = computed(() =>
    Object.fromEntries(flatNodes.value.map(({ node }) => [node.id, node])),
  )

  function reset() {
    generation++
    controller.abort()
    controller = new AbortController()
    queue = Promise.resolve()
    pending.clear()
    book.value = null
    pages.value = {}
    error.value = false
    loading.value = false
  }

  async function load(bookId: string) {
    reset()
    const version = generation
    loading.value = true
    try {
      const outline = await getBookOutline(bookId, controller.signal)
      if (generation !== version) return false
      book.value = outline
      return true
    } catch (cause) {
      if (generation !== version) return false
      error.value = true
      console.warn('[shelf-reader] Outline failed', cause)
      return false
    } finally {
      if (generation === version) loading.value = false
    }
  }

  /** Serialize visible-node reads so observer bursts cannot launch one request per chapter. */
  function loadNode(nodeId: string, nextPage = false): Promise<void> {
    const node = nodeById.value[nodeId]
    if (!node || !node.itemCount) return Promise.resolve()
    const state = pages.value[nodeId]
    if (pending.has(nodeId)) return pending.get(nodeId)!
    if (state && !state.error && ((!nextPage && state.pageNum > 0) || !state.hasMore)) {
      return Promise.resolve()
    }
    const version = generation
    const bookId = book.value!.id
    const signal = controller.signal
    const current = state ?? {
      rows: [],
      pageNum: 0,
      total: node.itemCount,
      hasMore: true,
      loading: false,
      error: false,
    }
    pages.value[nodeId] = { ...current, loading: true, error: false }
    const task = queue.then(async () => {
      if (version !== generation) return
      try {
        const page = await getNodeItems(
          bookId,
          nodeId,
          {
            pageNum: current.pageNum + 1,
            pageSize: READING_PAGE_SIZE,
          },
          signal,
        )
        if (version !== generation) return
        const latest = pages.value[nodeId] ?? current
        const rows = new Map(latest.rows.map((item) => [item.id, item]))
        for (const item of page.rows) rows.set(item.id, item)
        pages.value[nodeId] = {
          detail: page.node,
          rows: [...rows.values()],
          pageNum: page.pageNum,
          total: page.total,
          hasMore: page.hasMore,
          loading: false,
          error: false,
        }
      } catch (cause) {
        if (version !== generation) return
        pages.value[nodeId] = { ...(pages.value[nodeId] ?? current), loading: false, error: true }
        console.warn('[shelf-reader] Node page failed', cause)
      } finally {
        if (version === generation) pending.delete(nodeId)
      }
    })
    pending.set(nodeId, task)
    queue = task
    return task
  }

  /** Explicit whole-subtree operations read every page, never just the mounted content. */
  async function* readSubtree(nodeId: string): AsyncGenerator<ShelfReadingItem[]> {
    const root = nodeById.value[nodeId]
    if (!root || !book.value) return
    const version = generation
    const bookId = book.value.id
    const signal = controller.signal
    const stack = [root]
    while (stack.length) {
      const node = stack.pop()!
      if (node.itemCount) {
        let pageNum = 1
        let hasMore = true
        let expectedTotal: number | undefined
        const seen = new Set<string>()
        while (hasMore) {
          if (version !== generation) throw new Error('Book changed during selection')
          const page = await getNodeItems(
            bookId,
            node.id,
            { pageNum, pageSize: BULK_PAGE_SIZE },
            signal,
          )
          if (version !== generation) throw new Error('Book changed during selection')
          if (
            page.pageNum !== pageNum ||
            (expectedTotal !== undefined && page.total !== expectedTotal)
          ) {
            throw new Error('Chapter contents changed during selection; retry')
          }
          expectedTotal = page.total
          for (const row of page.rows) {
            if (seen.has(row.id)) throw new Error('Repeated chapter item during selection; retry')
            seen.add(row.id)
          }
          if (page.hasMore && page.rows.length === 0) throw new Error('Empty non-terminal page')
          yield page.rows
          hasMore = page.hasMore
          pageNum++
        }
        if (seen.size !== expectedTotal) throw new Error('Incomplete chapter contents; retry')
      }
      stack.push(...[...node.children].reverse())
    }
  }

  async function refreshItem(item: ShelfReadingItem) {
    if (book.value?.id !== item.bookId) return
    const state = pages.value[item.nodeId]
    if (!state) return
    const index = state.rows.findIndex((row) => row.id === item.id)
    if (index < 0) return
    const version = generation
    const page = await getNodeItems(
      item.bookId,
      item.nodeId,
      {
        pageNum: Math.floor(index / READING_PAGE_SIZE) + 1,
        pageSize: READING_PAGE_SIZE,
      },
      controller.signal,
    )
    if (generation !== version) return
    const refreshed = page.rows.find((row) => row.id === item.id)
    if (!refreshed) throw new Error('Item moved or was removed; reload the book')
    const latest = pages.value[item.nodeId]
    if (latest) latest.rows = latest.rows.map((row) => (row.id === item.id ? refreshed : row))
  }

  onScopeDispose(reset)
  return {
    book,
    loading,
    error,
    pages,
    flatNodes,
    nodeById,
    load,
    loadNode,
    readSubtree,
    refreshItem,
  }
}
