import { defineStore } from 'pinia'
import { ref } from 'vue'
import request from '@/http/request'

/**
 * 字典 store（PRD-C-204）—— 把 sys_dict 的枚举（题型/难度/来源…）作为 SSOT 拉到前端缓存，
 * 题卡/筛选条/徽标统一读字典，不再各组件硬编码散落 `{1:'选择题',...}`。
 *
 * 字典维护在后端 sys_dict_data（超管可改）；前端按 dictType 懒加载 + 进程内缓存。
 * /system/dict/data/type/{type} 走 RuoYi 原 envelope（request 拦截器已并入 /system/ 分支）。
 */
export interface DictItem {
  dictValue: string
  dictLabel: string
  dictSort?: number
  /** el-tag 类型（RuoYi sys_dict_data.list_class：primary/success/info/warning/danger），驱动徽标颜色 */
  listClass?: string
}

export const useDictStore = defineStore('dict', () => {
  // dictType -> 该字典的条目列表
  const cache = ref<Record<string, DictItem[]>>({})
  // 进行中的请求，防并发重复拉
  const loading = ref<Record<string, Promise<DictItem[]>>>({})

  async function load(dictType: string): Promise<DictItem[]> {
    if (cache.value[dictType]) return cache.value[dictType]
    const pending = loading.value[dictType]
    if (pending) return pending
    const p = request
      .get<DictItem[], DictItem[]>(`/system/dict/data/type/${dictType}`)
      .then((list) => {
        const arr = (Array.isArray(list) ? list : []).map((d) => ({
          dictValue: String(d.dictValue),
          dictLabel: d.dictLabel,
          dictSort: d.dictSort,
          listClass: d.listClass,
        }))
        cache.value[dictType] = arr
        return arr
      })
      .catch(() => {
        cache.value[dictType] = []
        return [] as DictItem[]
      })
      .finally(() => {
        delete loading.value[dictType]
      })
    loading.value[dictType] = p
    return p
  }

  /** 同步取已缓存的字典列表（未加载则返空数组并触发后台加载）。 */
  function list(dictType: string): DictItem[] {
    if (!cache.value[dictType] && !loading.value[dictType]) void load(dictType)
    return cache.value[dictType] ?? []
  }

  /** 取某值的中文标签（缓存未命中回落原值；后台异步补缓存，下次渲染即生效）。 */
  function label(dictType: string, value: string | number | null | undefined): string {
    if (value === null || value === undefined) return ''
    const arr = list(dictType)
    const hit = arr.find((d) => d.dictValue === String(value))
    return hit ? hit.dictLabel : String(value)
  }

  /**
   * 取某值的 el-tag 类型（字典 list_class）；缓存未命中 / 字典未配 list_class 回落 fallback。
   * 徽标颜色统一走字典 SSOT，超管在字典管理里改 list_class 即生效，不再各组件硬编码。
   */
  function tagType(
    dictType: string,
    value: string | number | null | undefined,
    fallback = 'info',
  ): string {
    if (value === null || value === undefined) return fallback
    const arr = list(dictType)
    const hit = arr.find((d) => d.dictValue === String(value))
    return hit && hit.listClass ? hit.listClass : fallback
  }

  return { cache, load, list, label, tagType }
})

// 常用字典 type 常量（与后端 sys_dict_type 对齐）
export const DICT_QUESTION_TYPE = 'biz_question_type'
export const DICT_QUESTION_DIFFICULTY = 'biz_question_difficulty'
export const DICT_QUESTION_SOURCE = 'biz_question_source'
// 🔴 biz_question.source_type 列专用字典（1中考真题/2模拟/3期末/4月考/5单元/6自编/9其他）。
//    注意与上面 DICT_QUESTION_SOURCE(biz_question_source) 是两套不同约定，别混（source_type 列只认这个）。
export const DICT_QUESTION_SOURCE_TYPE = 'biz_question_source_type'
// biz_question.label_status 打标状态（0未标/1AI已标/2已审核/3争议）
export const DICT_QUESTION_LABEL_STATUS = 'biz_question_label_status'
// biz_question.annotate_status 标注完成度（0未标/1已标全/2部分）
export const DICT_QUESTION_ANNOTATE_STATUS = 'biz_question_annotate_status'
// 题目考察类型 dim2（概念辨析/直接计算/…，string 码 = label）
export const DICT_QUESTION_ASSESSMENT_TYPE = 'biz_question_assessment_type'
