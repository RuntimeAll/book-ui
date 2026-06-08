import { onUnmounted, ref } from 'vue'
import axios from 'axios'

/**
 * useAbortableRequest — 列表请求竞态防护（PRD-A-013 M-10）
 *
 * 用途：列表筛选 / 切章节 / 切分类 / 快速搜索时, 旧请求未返新请求已发,
 * 旧 response 覆盖新数据导致 UI 串。本 composable 每次 run() 自动 abort 上一个请求。
 *
 * factory 模式（非 module-singleton）— 每个调用方各持自己的 AbortController, 互不干扰。
 * 业务侧把 fn(signal) 传进来, 用 signal 透传到 axios 的 { signal } 选项。
 *
 * 被取消的请求不抛业务错（axios 抛 AxiosError code='ERR_CANCELED'）, run 返回 null。
 *
 * 组件卸载时自动 abort 残留请求, 避免 onUnmounted 后还 setState 报警告。
 */
export function useAbortableRequest<T = unknown>() {
  const ctrl = ref<AbortController | null>(null)

  const isCanceledError = (err: unknown): boolean => {
    if (axios.isCancel(err)) return true
    const code = (err as { code?: string } | null)?.code
    return code === 'ERR_CANCELED' || code === 'ECONNABORTED'
  }

  /** 业务侧把 fn(signal) 传进来; 上一次未完成的请求会被 abort */
  const run = async <R = T>(fn: (signal: AbortSignal) => Promise<R>): Promise<R | null> => {
    ctrl.value?.abort()
    ctrl.value = new AbortController()
    const signal = ctrl.value.signal
    try {
      return await fn(signal)
    } catch (err) {
      if (isCanceledError(err)) return null
      throw err
    }
  }

  const abort = (): void => {
    ctrl.value?.abort()
    ctrl.value = null
  }

  onUnmounted(() => abort())

  return { run, abort, isCanceledError }
}
