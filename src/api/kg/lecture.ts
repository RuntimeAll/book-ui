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

/** 一个课时挂的一份讲义源（教辅套 × 个人） */
export interface LectureSource {
  bookId: string
  bookName: string
  /** 0=官方；否则个人用户 id（P2） */
  owner: number
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
 */
export function getLecture(subjectId: string, bookId = 'CC7S'): Promise<LectureDoc> {
  return request.get<LectureDoc, LectureDoc>('/teacher/kg/lecture', {
    params: { subjectId, bookId },
  })
}
