/**
 * PRD-C-212 增量 — 页内登录/注册弹窗全局状态（维护者拍板：独立 /login、/register 页全部下线，
 * 登录注册都原地弹框）。
 *
 * 模块级单例状态：任何地方 `useLoginDialog().open(...)` 即弹（弹窗本体 <LoginDialog/> 挂在 App.vue）。
 * 登录成功后的去向：open 时传了 redirect 就整页刷到该 hash，否则原地整页刷新
 * （reload 是既有登录时序契约：写 auth 后仅改 hash 会被守卫踢，且能顺带把游客态静默降级的数据全部重拉）。
 * 注册成功不刷页：弹窗内直接切回登录模式并预填用户名。
 */
import { ref } from 'vue'

export type AuthDialogMode = 'login' | 'register'

export interface LoginDialogOpenOpts {
  /** 打开成哪个模式；缺省 login */
  mode?: AuthDialogMode
  /** 登录成功后要去的 hash 路径（如 '/desk'）；缺省 = 原地刷新当前页 */
  redirect?: string
  /** 预填用户名（注册完切回登录的场景） */
  username?: string
}

const visible = ref(false)
const mode = ref<AuthDialogMode>('login')
const afterLoginPath = ref<string | null>(null)
const presetUsername = ref('')

export function useLoginDialog() {
  function open(opts?: LoginDialogOpenOpts) {
    mode.value = opts?.mode ?? 'login'
    afterLoginPath.value = opts?.redirect ?? null
    if (opts?.username) presetUsername.value = opts.username
    visible.value = true
  }
  function close() {
    visible.value = false
    // 关闭即清残留：陈旧 redirect 不该影响下一次打开（复现过：旧 redirect 把登录带去意外页）
    afterLoginPath.value = null
  }
  return { visible, mode, afterLoginPath, presetUsername, open, close }
}
