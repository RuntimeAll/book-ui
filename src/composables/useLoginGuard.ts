/**
 * PRD-C-212 D5 — 游客态操作按钮统一登录引导。
 *
 * 用法：需登录的动作 handler 开头 `if (!(await ensureLogin())) return`。
 * 已登录直接放行；游客弹「登录后继续」确认框，确认后原地弹登录框
 * （独立 /login 页已下线；登录成功整页刷新当前页，个人化数据自然重拉）。
 */
import { ElMessageBox } from 'element-plus'
import { useUserStore } from '@/store/user'
import { useLoginDialog } from '@/composables/useLoginDialog'

export function useLoginGuard() {
  const userStore = useUserStore()
  const loginDialog = useLoginDialog()

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
    loginDialog.open()
    return false
  }

  return { ensureLogin }
}
