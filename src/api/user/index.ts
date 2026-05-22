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

/** U 卡 段⑧ — 注册入参 */
export interface RegisterTeacherPayload {
  userName: string
  password: string
  nickName?: string
}

/** U 卡 段⑧ — 注册响应（BE R<Map> 返） */
export interface RegisterTeacherResult {
  userId: number
  userName: string
}

/**
 * U 卡 段⑧ — 老师自助注册
 * POST /teacher/user/register（@SaIgnore，无需登录态）
 *
 * 错误处理：
 *  - 用户名重复 / 校验失败 → BE 返 {code:500, msg:"..."}（request.ts 拦截器走错误分支 ElMessage.error）
 *  - 成功 → 返 {userId, userName}
 */
export const registerTeacher = (payload: RegisterTeacherPayload) =>
  request.post<RegisterTeacherResult, RegisterTeacherResult>(
    '/teacher/user/register',
    payload,
  )
