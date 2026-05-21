import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

// localStorage key — 命名空间化，避免和其他 app 撞
const STORAGE_KEY = 'book-ui:auth'

/**
 * RuoYi /auth/login 成功后返回的 token 包（已被 request.ts 拦截器拆出 data 段）。
 * 字段对齐 PRD §3.2 登录响应契约。
 */
export interface AuthState {
  access_token: string
  expire_in?: number
  refresh_token?: string
  client_id?: string
  scope?: string
}

/**
 * 当前用户信息 — 后续 /teacher/user/current 拉回来 set 进来。
 * 字段对齐 src/api/user/index.ts 的 CurrentUserVO。
 */
export interface UserInfo {
  id: number
  userUuid?: string
  userName: string
  realName?: string
  role?: number
  phone?: string
  imagePath?: string
  member?: boolean
}

function loadFromStorage(): AuthState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as AuthState) : null
  } catch {
    return null
  }
}

function saveToStorage(payload: AuthState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // 忽略 quota / 隐私模式异常
  }
}

/**
 * 用户登录态 store（setup store 风格）。
 *
 * - auth：access_token + 元信息，持久化到 localStorage（刷新页面不丢）
 * - userInfo：内存态，刷新后由首屏调 /teacher/user/current 重新填充
 *
 * Y2 卡 2a 波 — 第 2b 波会扩 axios 请求拦截器读 accessToken 拼 Authorization。
 */
export const useUserStore = defineStore('user', () => {
  const auth = ref<AuthState | null>(loadFromStorage())
  const userInfo = ref<UserInfo | null>(null)

  const isLoggedIn = computed(() => !!auth.value?.access_token)
  const accessToken = computed(() => auth.value?.access_token ?? '')

  function setAuth(payload: AuthState): void {
    auth.value = payload
    saveToStorage(payload)
  }

  function setUserInfo(info: UserInfo): void {
    userInfo.value = info
  }

  function clear(): void {
    auth.value = null
    userInfo.value = null
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // ignore
    }
  }

  return {
    auth,
    userInfo,
    isLoggedIn,
    accessToken,
    setAuth,
    setUserInfo,
    clear,
  }
})
