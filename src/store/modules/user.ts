/**
 * PRD-C-211 系统管理移植 —— plus-ui user store 适配层。
 *
 * 移植来的系统管理页面/指令/插件按 plus-ui 习惯 `import { useUserStore } from '@/store/modules/user'`
 * 取 userId / roles / permissions（v-hasPermi、编辑自己判断等）。book-ui 自己的登录态在
 * `@/store/user`（token+userInfo），没有 permissions —— 本 store 进管理区时调 RuoYi 原生
 * `GET /getInfo` 拉一次（roles + permissions + user），只做管理页消费，不接管登录态。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import request from '@/utils/request'
import { useUserStore as useBookUserStore } from '@/store/user'

interface GetInfoUser {
  userId: string | number
  userName: string
  nickName?: string
  deptId?: string | number
}

export const useUserStore = defineStore('admin-user', () => {
  const userId = ref<string | number>('')
  const userName = ref('')
  const nickName = ref('')
  const deptId = ref<string | number>('')
  const roles = ref<string[]>([])
  const permissions = ref<string[]>([])
  const loaded = ref(false)

  /** 进 /manage 前守卫调用；已加载则直接返回（切页不重复拉） */
  async function fetchInfo(force = false): Promise<void> {
    if (loaded.value && !force) return
    const res = (await request({ url: '/system/user/getInfo', method: 'get' })) as unknown as {
      data: { user: GetInfoUser; roles: string[]; permissions: string[] }
    }
    const d = res.data
    userId.value = d.user?.userId ?? ''
    userName.value = d.user?.userName ?? ''
    nickName.value = d.user?.nickName ?? ''
    deptId.value = d.user?.deptId ?? ''
    roles.value = d.roles ?? []
    permissions.value = d.permissions ?? []
    loaded.value = true
  }

  function reset(): void {
    userId.value = ''
    userName.value = ''
    nickName.value = ''
    deptId.value = ''
    roles.value = []
    permissions.value = []
    loaded.value = false
  }

  /** plus-ui request.ts 401 分支会调 logout —— 代理到 book-ui 登录态 */
  async function logout(): Promise<void> {
    reset()
    await useBookUserStore().logout()
  }

  return { userId, userName, nickName, deptId, roles, permissions, loaded, fetchInfo, reset, logout }
})

export default useUserStore
