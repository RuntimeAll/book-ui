/**
 * PRD-C-212 增量 — 页内登录弹窗全局状态（维护者拍板：去掉独立 /login 页，登录原地弹框）。
 *
 * 模块级单例状态：任何地方 `useLoginDialog().open(...)` 即弹（弹窗本体 <LoginDialog/> 挂在 App.vue，
 * AppLayout 内外的页面——含 /register——都能唤起）。
 * 登录成功后的去向：open 时传了 redirect 就整页刷到该 hash，否则原地整页刷新
 * （reload 是既有登录时序契约：写 auth 后仅改 hash 会被守卫踢，且能顺带把游客态静默降级的数据全部重拉）。
 */
import { ref } from 'vue'

export interface LoginDialogOpenOpts {
  /** 登录成功后要去的 hash 路径（如 '/desk'）；缺省 = 原地刷新当前页 */
  redirect?: string
  /** 预填用户名（注册完跳回登录的场景） */
  username?: string
}

const visible = ref(false)
const afterLoginPath = ref<string | null>(null)
const presetUsername = ref('')

export function useLoginDialog() {
  function open(opts?: LoginDialogOpenOpts) {
    afterLoginPath.value = opts?.redirect ?? null
    if (opts?.username) presetUsername.value = opts.username
    visible.value = true
  }
  function close() {
    visible.value = false
  }
  return { visible, afterLoginPath, presetUsername, open, close }
}
