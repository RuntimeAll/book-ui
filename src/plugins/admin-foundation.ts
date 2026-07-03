/**
 * PRD-C-212 V0：管理台地基懒装载。
 *
 * PRD-C-211 移植的 plus-ui 管理中心依赖三件地基：
 *   1) virtual:svg-icons-register —— svg 雪碧图（menu 页 <svg-icon>/icon-select）
 *   2) @/plugins —— globalProperties（$modal/$tab/$download/useDict/handleTree…）
 *   3) @/directive —— v-hasPermi / v-hasRoles / v-copyText
 * 原先在 main.ts 全局加载，老师不进 /manage 也要买单；现改为 router 守卫
 * 首次进 /manage 时 await 本函数一次性动态装载（幂等，并发安全）。
 */
import type { App } from 'vue'

let installing: Promise<void> | null = null

export function ensureAdminFoundation(app: App): Promise<void> {
  if (!installing) {
    installing = (async () => {
      const [, pluginsMod, directivesMod] = await Promise.all([
        import('virtual:svg-icons-register'),
        import('@/plugins'),
        import('@/directive'),
      ])
      app.use(pluginsMod.default)
      directivesMod.default(app)
    })().catch((e) => {
      // 装载失败允许下次导航重试（例如 chunk 网络抖动），不留半装状态标志
      installing = null
      throw e
    })
  }
  return installing
}
