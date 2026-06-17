import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import request from '@/http/request'

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
  // PRD-A-013 T2 — 雪花 ID 必 string（对齐 CurrentUserVO.id）
  id: string
  userUuid?: string
  userName: string
  realName?: string
  role?: number
  /** U 卡新增 — 真实角色 role_key 集合，登录分流 + 菜单过滤用 */
  roles?: string[]
  phone?: string
  imagePath?: string
  member?: boolean
  /** PRD-002 新增 — 个人资料字段（current 端点回填） */
  sex?: number | null
  grade?: string | null
  school?: string | null
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

  // U 卡新增 — 真实角色列表（基于 userInfo.roles），FE 登录分流 + 菜单角色过滤 single source of truth
  const roles = computed(() => userInfo.value?.roles ?? [])
  const isTeacher = computed(() => roles.value.includes('teacher'))
  // PRD-A-015 — 超级管理员（角色 superadmin，对齐 BE LoginHelper.isSuperAdmin）。
  // 用于题目编辑权限：teacher 仅本人题，superadmin 可编辑所有题。
  const isSuperAdmin = computed(() => roles.value.includes('superadmin'))

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

  /**
   * U-hotfix（2026-05-23）— 退出登录。
   * 1. 调 BE POST /auth/logout 让 Sa-Token 服务端 token 失效（best-effort，失败不阻塞 FE 登出）
   * 2. clear() 清本地 LS + 重置 store
   * 调用方：AppLayout avatar dropdown / token 过期等场景。
   */
  async function logout(): Promise<void> {
    try {
      await request.post('/auth/logout')
    } catch (e) {
      console.warn('[user] BE logout failed (本地仍清理):', e)
    } finally {
      clear()
    }
  }

  return {
    auth,
    userInfo,
    isLoggedIn,
    accessToken,
    roles,
    isTeacher,
    isSuperAdmin,
    setAuth,
    setUserInfo,
    clear,
    logout,
  }
})
