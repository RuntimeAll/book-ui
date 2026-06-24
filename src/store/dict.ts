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

  return { cache, load, list, label }
})

// 常用字典 type 常量（与后端 sys_dict_type 对齐）
export const DICT_QUESTION_TYPE = 'biz_question_type'
export const DICT_QUESTION_DIFFICULTY = 'biz_question_difficulty'
export const DICT_QUESTION_SOURCE = 'biz_question_source'
