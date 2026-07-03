/**
 * PRD-C-207 讲义（片段汇聚）浏览 API
 *
 * 讲义 = 挂 KG 节点的原子片段（biz_kg_lecture_frag）；服务端按 subject_id 前缀树序汇聚成一份 doc。
 * 接口契约（BE，/teacher/** 走 misikt envelope，拦截器 code===1 解包后此处拿 response 内层）：
 *   GET /teacher/kg/lecture?subjectId=&bookId=      → { node:{id,name,level}, bookId, docJson:object|null }
 *   GET /teacher/kg/lecture-catalog?bookId=         → { volumeId, lessons:[{lessonId,lessonName,sources[]}] }
 *
 * example 节点仍复用既有 /teacher/kg/questions（见 api/kg/doc.ts getKgQuestions）。
 */
import request from '@/http/request'

/** 一个课时挂的一份讲义源（教辅套 × owner；权限模型 v2：owner=创建者，官方=uid1） */
export interface LectureSource {
  bookId: string
  bookName: string
  /** 创建者 uid；1=官方（超管账号） */
  owner: number
  /** 创建者昵称（来源切换器标签） */
  ownerName?: string
}

/** 目录里的一个课时（含其全部讲义源） */
export interface CatalogLesson {
  /** 课时 L4 节点 id（如 901001002002） */
  lessonId: string
  lessonName: string
  sources: LectureSource[]
}

export interface LectureCatalog {
  /** 册根 id（如 901） */
  volumeId: string | null
  lessons: CatalogLesson[]
}

export interface LectureNode {
  id: string
  name: string
  /** 1册2章3节4课时5知识点 */
  level: number
}

export interface LectureDoc {
  node: LectureNode | null
  bookId: string
  /** 汇聚好的 Tiptap doc；null = 该节点下无片段 */
  docJson: object | null
}

/**
 * 讲义目录：某书所在册内每课时挂了哪些讲义源（左树灰置 + 来源切换器）。
 * @param bookId 教辅套 id（默认 CC7S）
 */
export function getLectureCatalog(bookId = 'CC7S'): Promise<LectureCatalog> {
  return request.get<LectureCatalog, LectureCatalog>('/teacher/kg/lecture-catalog', {
    params: { bookId },
  })
}

/**
 * 取某 KG 节点（课时 L4 常用）的完整讲义 = 自身 + 子孙片段按树序汇聚。
 * @param subjectId 挂载锚 KG 节点 id
 * @param bookId    教辅套 id（默认 CC7S）
 * @param owner     指定讲义源（来源切换器；缺省=默认视图 我的>本部门管理员>官方）
 */
export function getLecture(subjectId: string, bookId = 'CC7S', owner?: number): Promise<LectureDoc> {
  return request.get<LectureDoc, LectureDoc>('/teacher/kg/lecture', {
    params: { subjectId, bookId, ...(owner != null ? { owner } : {}) },
  })
}

// ── P2 写侧 / 管理（权限模型 v2 = only-one/权限与内容归属模型-定版.md） ──

/** 待保存片段（IR）；contentJson=该节点自己的 Tiptap doc */
export interface LectureFragSave {
  subjectId: string
  title?: string
  contentJson: object
  /** '0'正常 / '1'草稿（草稿仅本人可见） */
  status?: string
}

export interface SaveFragsResult {
  ok: boolean
  owner: number
  results: { subjectId: string; action: 'created' | 'updated' | 'fail'; reason?: string }[]
  stats: { ok: number; fail: number }
}

/**
 * 批量保存片段（upsert，需登录）。owner 缺省=存自己名下；
 * 传 owner=管理员改本部门成员的（BE 按写校验序判权，官方 uid1 仅本人）。
 */
export function saveLectureFrags(bookId: string, frags: LectureFragSave[], owner?: number): Promise<SaveFragsResult> {
  return request.post<SaveFragsResult, SaveFragsResult>('/teacher/kg/lecture-frag', {
    bookId, frags, ...(owner != null ? { owner } : {}),
  })
}

/** 管理：下架/删除某 owner 某前缀的片段（prefix 至少到节 9 位） */
export function removeLectureFrags(bookId: string, owner: number, subjectPrefix: string): Promise<{ ok: boolean; removed: number }> {
  return request.post<{ ok: boolean; removed: number }, { ok: boolean; removed: number }>(
    '/teacher/kg/lecture-frag/remove', { bookId, owner, subjectPrefix })
}

/** 管理页：成员（superadmin=全部 / org_admin=本部门；其余 BE 403） */
export interface ManageMember {
  userId: number
  userName: string
  nickName: string
  deptId: number | null
  deptName: string | null
  /** 逗号拼接的 role_key（superadmin,org_admin,teacher…） */
  roleKeys: string | null
}
export function getManageMembers(): Promise<ManageMember[]> {
  return request.get<ManageMember[], ManageMember[]>('/teacher/kg/manage/members')
}

/** 管理页：讲义清单（owner×课时聚合） */
export interface ManageLecture {
  lessonId: string
  lessonName: string
  bookId: string
  owner: number
  ownerName: string
  fragCount: number
  updatedAt: string | null
}
export function getManageLectures(): Promise<ManageLecture[]> {
  return request.get<ManageLecture[], ManageLecture[]>('/teacher/kg/manage/lectures')
}
