import request from '@/http/request'

export interface CurrentUserVO {
  id: number
  userUuid: string
  userName: string
  realName: string
  role: number
  /**
   * U 卡新增 — 真实角色 role_key 集合（BE LoginHelper.getRolePermission()）。
   * 例：{'teacher'} / {'superadmin'} / {'admin', 'teacher'}。
   * FE 判 `roles.includes('teacher')` 决定登录后跳 /workspace；否则跳 /home。
   */
  roles: string[]
  phone: string
  imagePath: string
  member: boolean
}

export const getCurrentUser = () =>
  request.post<CurrentUserVO, CurrentUserVO>('/teacher/user/current')
