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
  /**
   * PRD-002 新增 — 个人资料字段（BE current 端点扩字段回填）。
   * sex：0 男 / 1 女 / null 未设置；grade：任教年级；school：学校。
   */
  sex: number | null
  grade: string | null
  school: string | null
}

export const getCurrentUser = () =>
  request.post<CurrentUserVO, CurrentUserVO>('/teacher/user/current')

/** PRD-002 段③ — 更新个人资料入参（userId 由 BE 从登录态取，不从 body 收，防越权） */
export interface UpdateProfilePayload {
  /** 真实姓名（必填）→ 落 sys_user.nick_name */
  realName: string
  /** 性别 0 男 / 1 女 / null */
  sex: number | null
  /** 任教年级（必填）→ 落 sys_user.grade */
  grade: string
  /** 学校 → 落 sys_user.school */
  school: string | null
}

/**
 * PRD-002 段③ — 更新当前登录老师的个人资料
 * POST /teacher/user/update（登录态内页）
 *
 * - userId 从登录态取（BE LoginHelper/StpUtil），不传 body
 * - 校验失败（realName / grade 空）→ BE 400 + 校验信息（request.ts 拦截器走错误分支）
 * - 成功 → R<Void>（message="操作成功"）
 */
export const updateProfile = (payload: UpdateProfilePayload) =>
  request.post<void, void>('/teacher/user/update', payload)

/** U 卡 段⑧ — 注册入参 */
export interface RegisterTeacherPayload {
  userName: string
  password: string
  nickName?: string
  /** PRD-A-005 T1 — 图形验证码值（captchaEnabled=true 时必传）；BE 复用若依 captcha 校验 */
  code?: string
  /** PRD-A-005 T1 — 验证码 uuid（与 code 配对） */
  uuid?: string
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
