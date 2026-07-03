/**
 * PRD-C-211 —— plus-ui $tab 插件的薄 stub。
 * book-ui 没有页签(tagsView)体系；移植页只用到 closeOpenPage/closePage（分配角色/分配用户
 * 页保存后"关当前页回列表"）。其余方法保留签名为 no-op，避免运行时 undefined。
 */
import router from '@/router'
import type { RouteLocationRaw } from 'vue-router'

export default {
  async refreshPage(): Promise<void> {
    router.go(0)
  },
  // 关闭当前页，打开新页（无页签体系 = 直接跳转）
  closeOpenPage(obj?: RouteLocationRaw): void {
    if (obj !== undefined) {
      router.push(obj)
    } else {
      router.back()
    }
  },
  // 关闭当前页（无页签体系 = 回上一页）
  async closePage(): Promise<void> {
    router.back()
  },
  closeAllPage(): void {},
  closeLeftPage(): void {},
  closeRightPage(): void {},
  closeOtherPage(): void {},
  openPage(url: string, title?: string, query?: Record<string, unknown>): Promise<unknown> {
    return router.push({ path: url, query: { ...query, title } })
  },
  updatePage(): void {},
}
