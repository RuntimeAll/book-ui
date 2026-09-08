import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { defineStore, storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import { useUserStore } from '@/store/user'
import type { QuestionItem } from '@/api/question'
import { createClientUuid } from '@/utils/clientUuid'
import {
  addBasketEntries,
  basketQuestion,
  BASKET_BATCH_SIZE,
  BASKET_MAX_SIZE,
  BASKET_PAGE_SIZE,
  emptyBasketEntries,
  getBasketEntries,
  getBasketKeys,
  removeBasketEntries,
  removeBasketEntryVersions,
  selectionKey,
  selectionReference,
  type BasketQuestion,
  type BasketEntryReference,
} from '@/api/questionBasket'

const SYNC_KEY = 'book-ui:question-basket:v2:changed'

const useQuestionBasketStore = defineStore('question-basket-v2', () => {
  const user = useUserStore()
  const currentNamespace = ref('default')
  const items = shallowRef<BasketQuestion[]>([])
  const count = ref(0)
  const pageIndex = ref(1)
  const loading = ref(false)
  const error = ref('')
  const dialogVisible = ref(false)
  const togglingIds = ref(new Set<string>())
  const knownKeys = ref(new Set<string>())
  const revision = ref(0)
  const identity = computed(() => `${user.accessToken}\n${user.userInfo?.id ?? ''}`)
  let generation = 0
  let readSequence = 0
  let controller: AbortController | undefined
  let queue: Promise<unknown> = Promise.resolve()
  const basketIds = computed(
    () =>
      new Set(
        [...knownKeys.value].flatMap((key) => (key.startsWith('q:') ? [key, key.slice(2)] : [key])),
      ),
  )

  function context() {
    if (!user.isLoggedIn || !user.userInfo?.id) throw new Error('请先登录后使用试题栏')
    return { generation, namespace: currentNamespace.value, userId: user.userInfo.id }
  }

  function notifyChanged(ctx: ReturnType<typeof context>) {
    const value = { userId: ctx.userId, namespace: ctx.namespace, nonce: createClientUuid() }
    channel?.postMessage(value)
    try {
      localStorage.setItem(SYNC_KEY, JSON.stringify(value))
    } catch {
      // 只发失效通知，服务端已保存；无存储权限时由焦点刷新兜底。
    }
  }

  async function syncFromServer(page = pageIndex.value): Promise<void> {
    if (!user.isLoggedIn || !user.userInfo?.id) return
    const ctx = context()
    const seq = ++readSequence
    controller?.abort()
    controller = new AbortController()
    loading.value = true
    error.value = ''
    try {
      const [result, keys] = await Promise.all([
        getBasketEntries(ctx.namespace, page, controller.signal),
        getBasketKeys(ctx.namespace, controller.signal),
      ])
      if (ctx.generation !== generation || seq !== readSequence) return
      if (page > 1 && result.list.length === 0 && result.total > 0) {
        await syncFromServer(Math.ceil(result.total / BASKET_PAGE_SIZE))
        return
      }
      items.value = result.list.map((entry) => ({
        ...basketQuestion(entry),
        basketNamespace: ctx.namespace,
      }))
      count.value = result.total
      pageIndex.value = result.total === 0 ? 1 : page
      // 成员键独立于正文分页，每次替换而非累积，才能识别其他页的加入和移除。
      knownKeys.value = new Set(keys)
    } catch (e) {
      if (ctx.generation !== generation || seq !== readSequence) return
      error.value = e instanceof Error ? e.message : '试题栏加载失败'
      throw e
    } finally {
      if (ctx.generation === generation && seq === readSequence) loading.value = false
    }
  }

  function reloadQuietly() {
    void syncFromServer().catch(() => {
      /* error 由面板展示，焦点刷新不重复弹窗。 */
    })
  }

  function invalidate() {
    revision.value++
    reloadQuietly()
  }

  function receiveChange(value: unknown) {
    if (!value || typeof value !== 'object') return
    const event = value as { userId?: unknown; namespace?: unknown }
    if (event.userId === user.userInfo?.id && event.namespace === currentNamespace.value)
      invalidate()
  }

  const channel =
    typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('question-basket-v2') : undefined
  if (channel) channel.onmessage = (event) => receiveChange(event.data)
  function onStorage(event: StorageEvent) {
    if (event.key === 'book-ui:auth') {
      // 跨标签切账号后同步重建 auth 内存和请求拦截器。
      window.location.reload()
    } else if (!channel && event.key === SYNC_KEY && event.newValue) {
      try {
        receiveChange(JSON.parse(event.newValue))
      } catch {
        /* 非法通知不影响业务数据。 */
      }
    }
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener('focus', invalidate)
  onScopeDispose(() => {
    controller?.abort()
    channel?.close()
    window.removeEventListener('storage', onStorage)
    window.removeEventListener('focus', invalidate)
  })

  watch(
    [identity, currentNamespace],
    () => {
      generation++
      readSequence++
      controller?.abort()
      items.value = []
      knownKeys.value = new Set()
      togglingIds.value = new Set()
      count.value = 0
      pageIndex.value = 1
      error.value = ''
      loading.value = false
      revision.value++
      reloadQuietly()
    },
    { immediate: true, flush: 'sync' },
  )

  async function mutate<T>(
    keys: string[],
    action: (namespace: string, assertCurrent: () => void) => Promise<T>,
  ): Promise<T> {
    const ctx = context()
    const assertCurrent = () => {
      if (ctx.generation !== generation) throw new Error('账号或试题栏已切换，请重试')
    }
    const execute = async () => {
      assertCurrent()
      togglingIds.value = new Set([...togglingIds.value, ...keys])
      try {
        const result = await action(ctx.namespace, assertCurrent)
        notifyChanged(ctx)
        if (ctx.generation !== generation) throw new Error('操作已保存，当前账号或试题栏已切换')
        revision.value++
        try {
          await syncFromServer()
        } catch {
          ElMessage.warning('操作已保存，试题栏刷新失败，请点击重试重新读取')
        }
        return result
      } catch (e) {
        if (ctx.generation === generation) {
          notifyChanged(ctx)
          revision.value++
          error.value = e instanceof Error ? e.message : '试题栏操作失败'
          ElMessage.error(error.value)
          reloadQuietly()
        }
        throw e
      } finally {
        if (ctx.generation === generation) {
          togglingIds.value = new Set([...togglingIds.value].filter((key) => !keys.includes(key)))
        }
      }
    }
    const pending = queue.then(execute, execute)
    queue = pending.catch(() => undefined)
    return pending
  }

  async function addMany(questions: QuestionItem[], silent = false): Promise<number> {
    const unique = [...new Map(questions.map((q) => [selectionKey(q), q])).values()]
    if (unique.length > BASKET_MAX_SIZE) throw new Error(`试题栏最多 ${BASKET_MAX_SIZE} 题`)
    if (!unique.length) return 0
    const added = await mutate(unique.map(selectionKey), async (ns, assertCurrent) => {
      let addedCount = 0
      try {
        for (let offset = 0; offset < unique.length; offset += BASKET_BATCH_SIZE) {
          assertCurrent()
          const batch = unique.slice(offset, offset + BASKET_BATCH_SIZE).map(selectionReference)
          addedCount += (await addBasketEntries(ns, batch)).addedCount
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : '请求失败'
        throw new Error(
          `已确认新增 ${addedCount} 题，其余批次未确认：${reason}。正在重读服务端状态，可安全重试未完成选择。`,
        )
      }
      return addedCount
    })
    if (!silent) {
      if (added) ElMessage.success(`已加入 ${added} 题到试题栏`)
      else ElMessage.info('所选题目已在试题栏中')
    }
    return added
  }

  async function add(q: QuestionItem, opts?: { silent?: boolean }): Promise<void> {
    await addMany([q], opts?.silent)
  }

  async function removeMany(ids: string[], silent = false): Promise<number> {
    const keys = [...new Set(ids.map((id) => (id.includes(':') ? id : `q:${id}`)))]
    if (!keys.length) return 0
    await mutate(keys, async (ns, assertCurrent) => {
      for (let offset = 0; offset < keys.length; offset += BASKET_BATCH_SIZE) {
        assertCurrent()
        await removeBasketEntries(ns, keys.slice(offset, offset + BASKET_BATCH_SIZE))
      }
    })
    if (!silent) ElMessage.success('已从试题栏移除')
    return keys.length
  }

  async function remove(id: string): Promise<void> {
    await removeMany([id])
  }

  async function removeSubmittedEntries(entries: BasketEntryReference[]): Promise<void> {
    if (!entries.length) return
    if (entries.length > BASKET_MAX_SIZE || entries.some((entry) => !entry.basketEntryId))
      throw new Error('试题栏记录版本缺失，未清理已提交题目')
    await mutate(
      entries.map((entry) => entry.entryKey),
      async (ns, assertCurrent) => {
        for (let offset = 0; offset < entries.length; offset += BASKET_BATCH_SIZE) {
          assertCurrent()
          await removeBasketEntryVersions(ns, entries.slice(offset, offset + BASKET_BATCH_SIZE))
        }
      },
    )
  }

  async function clear(): Promise<void> {
    await mutate(['*'], emptyBasketEntries)
    ElMessage.success('已清空试题栏')
  }

  // 仅显式组卷操作读取完整有界集合；面板始终消费服务端当前页。
  async function loadForComposition(): Promise<BasketQuestion[]> {
    const ctx = context()
    const result: BasketQuestion[] = []
    let total: number | undefined
    for (let page = 1; page <= Math.ceil(BASKET_MAX_SIZE / BASKET_PAGE_SIZE); page++) {
      const data = await getBasketEntries(ctx.namespace, page)
      if (ctx.generation !== generation) throw new Error('账号或试题栏已切换，请重试')
      if (data.total > BASKET_MAX_SIZE || (total !== undefined && data.total !== total)) {
        throw new Error('试题栏已变化，请重新载入')
      }
      total = data.total
      result.push(
        ...data.list.map((entry) => ({ ...basketQuestion(entry), basketNamespace: ctx.namespace })),
      )
      if (result.length >= total) break
      if (!data.list.length) throw new Error('试题栏数据不完整，请重新载入')
    }
    if (result.length !== total || new Set(result.map((q) => q.entryKey)).size !== result.length) {
      throw new Error('试题栏已变化，请重新载入')
    }
    return result
  }

  function has(q: QuestionItem): boolean {
    return knownKeys.value.has(selectionKey(q))
  }
  function isLoading(id: string): boolean {
    return (
      togglingIds.value.has('*') || togglingIds.value.has(id) || togglingIds.value.has(`q:${id}`)
    )
  }
  function switchNamespace(ns: string) {
    currentNamespace.value = ns || 'default'
  }
  function openDialog() {
    dialogVisible.value = true
    reloadQuietly()
  }
  function closeDialog() {
    dialogVisible.value = false
  }
  return {
    items,
    count,
    basketIds,
    pageIndex,
    loading,
    error,
    revision,
    currentNamespace,
    togglingIds,
    dialogVisible,
    add,
    addMany,
    remove,
    removeMany,
    removeSubmittedEntries,
    clear,
    has,
    isLoading,
    switchNamespace,
    openDialog,
    closeDialog,
    syncFromServer,
    loadForComposition,
  }
})

export function useQuestionBasket() {
  const store = useQuestionBasketStore()
  const refs = storeToRefs(store)
  return {
    ...refs,
    get togglingIds() {
      return new Set(
        [...store.togglingIds].flatMap((key) =>
          key.startsWith('q:') ? [key, key.slice(2)] : [key],
        ),
      )
    },
    pageSize: BASKET_PAGE_SIZE,
    add: store.add,
    addMany: store.addMany,
    remove: store.remove,
    removeMany: store.removeMany,
    removeSubmittedEntries: store.removeSubmittedEntries,
    clear: store.clear,
    has: store.has,
    isLoading: store.isLoading,
    switchNamespace: store.switchNamespace,
    openDialog: store.openDialog,
    closeDialog: store.closeDialog,
    syncFromServer: store.syncFromServer,
    hydrateMissingBlockJson: store.syncFromServer,
    loadForComposition: store.loadForComposition,
  }
}

export type UseQuestionBasket = ReturnType<typeof useQuestionBasket>
