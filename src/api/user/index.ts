import request from '@/http/request'

export interface CurrentUserVO {
  id: number
  userUuid: string
  userName: string
  realName: string
  role: number
  phone: string
  imagePath: string
  member: boolean
}

export const getCurrentUser = () =>
  request.post<CurrentUserVO, CurrentUserVO>('/teacher/user/current')
