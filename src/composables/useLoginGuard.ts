/**
 * PRD-C-212 D5 — 游客态操作按钮统一登录引导。
 *
 * 用法：需登录的动作 handler 开头 `if (!(await ensureLogin())) return`。
 * 已登录直接放行；游客弹「登录后继续」确认框，确认跳 /login?redirect=当前页。
 */
import { ElMessageBox } from 'element-plus'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'

export function useLoginGuard() {
  const router = useRouter()
  const route = useRoute()
  const userStore = useUserStore()

  async function ensureLogin(tip = '登录后即可使用该功能'): Promise<boolean> {
    if (userStore.isLoggedIn) return true
    try {
      await ElMessageBox.confirm(tip, '登录后继续', {
        confirmButtonText: '去登录',
        cancelButtonText: '再看看',
        type: 'info',
      })
    } catch {
      return false
    }
    router.push({ path: '/login', query: { redirect: route.fullPath } })
    return false
  }

  return { ensureLogin }
}
