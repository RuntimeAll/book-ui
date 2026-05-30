/**
 * useBasketWorkbench — 三栏组卷工作台数据层 (PRD-001 T6)
 *
 * 职责：把"试卷篮里的若干整卷"打散成"题级工作台数据源"。
 *
 * 数据流（关键发现 #1/#2，规划期已钉死纯前端）：
 *   usePaperBasket().items (PaperListItem[]，只含卷头)
 *     → 对每张已选卷 paperId 调一次 getPaperDetail (= misikt 的 /select)
 *     → 每卷返 PaperDetailVo { sections[].questions: PaperSourceQuestion[] }，
 *        题 VO 自带 questionType / difficult / stemImg / questionKnowledges / freeTags 等完整字段
 *     → 合并所有卷的所有 section 的所有题 → 按题 id 去重（保首次出现顺序）
 *     → 派生：① questions 全量去重题列表（中栏 / 快速组卷 / 试卷分析共用）
 *             ② knowledgeGroups 考点聚合（左栏）— 走题 VO 自带 questionKnowledges，
 *                不走 biz_question.subject_id（关键发现 #2）
 *             ③ papers 各卷分解（试卷分析「各套卷对比」用）
 *
 * 纯前端：所有聚合 / 筛选 / 分析都在内存里算，除 N 次 detail 外不发任何请求。
 * 注：getPaperDetail 已存在于 @/api/question（E 卡产物），直接复用，无需在 @/api/paper 重造。
 */
import { ref, computed, type Ref, type ComputedRef } from 'vue'
import { getPaperDetail, type PaperSourceQuestion } from '@/api/question/index'
import { usePaperBasket } from '@/composables/usePaperBasket'

export interface KnowledgeGroup {
  /** 知识点 id（knowledgeId，VARCHAR；缺失时退化为 name） */
  id: string
  /** 知识点名 */
  name: string
  /** 命中该考点的题数 */
  count: number
}

export interface WorkbenchPaper {
  paperId: number
  paperName: string
  questions: PaperSourceQuestion[]
}

export interface UseBasketWorkbench {
  /** 加载中 */
  loading: Ref<boolean>
  /** 各卷分解（原始，未跨卷去重）— 试卷分析「各套卷对比」用 */
  papers: Ref<WorkbenchPaper[]>
  /** 全量去重题列表（中栏 / 快速组卷 / 试卷分析共用） */
  questions: Ref<PaperSourceQuestion[]>
  /** 考点聚合（左栏）— 按 knowledgeId 分组计数，count desc */
  knowledgeGroups: ComputedRef<KnowledgeGroup[]>
  /** 已选卷数（= usePaperBasket.count） */
  paperCount: ComputedRef<number>
  /** 加载失败的卷 id（detail 报错 / 空返） */
  failedPaperIds: Ref<number[]>
  /** 遍历篮内卷，逐卷 detail → 合并去重 → 重算派生 */
  load: () => Promise<void>
}

/**
 * 取一道题的知识点数组（兼容 questionKnowledges 缺失）。
 * detail 题 VO 的 questionKnowledges 只回 source='U'（用户轨），不回 'S'（标准库轨）—
 * 若实测考点偏稀疏，先查 U 轨标注（manual 执行期实测项），非前端聚合 bug。
 */
function knowledgesOf(q: PaperSourceQuestion) {
  return Array.isArray(q.questionKnowledges) ? q.questionKnowledges : []
}

export function useBasketWorkbench(): UseBasketWorkbench {
  const basket = usePaperBasket()

  const loading = ref(false)
  const papers = ref<WorkbenchPaper[]>([])
  const questions = ref<PaperSourceQuestion[]>([])
  const failedPaperIds = ref<number[]>([])

  const paperCount = computed(() => basket.count.value)

  const knowledgeGroups = computed<KnowledgeGroup[]>(() => {
    const map = new Map<string, KnowledgeGroup>()
    for (const q of questions.value) {
      // 同一题对同一知识点只计一次
      const seen = new Set<string>()
      for (const k of knowledgesOf(q)) {
        const id = String(k.knowledgeId ?? k.knowledgeName ?? '').trim()
        if (!id || seen.has(id)) continue
        seen.add(id)
        const name = (k.knowledgeName || k.knowledgeId || id) as string
        const exist = map.get(id)
        if (exist) {
          exist.count += 1
        } else {
          map.set(id, { id, name, count: 1 })
        }
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count)
  })

  async function load(): Promise<void> {
    const ids = basket.items.value.map((p) => p.id)
    if (ids.length === 0) {
      papers.value = []
      questions.value = []
      failedPaperIds.value = []
      return
    }
    loading.value = true
    failedPaperIds.value = []
    try {
      // 并行逐卷 detail（篮内上限 20，并发可控）
      const results = await Promise.allSettled(ids.map((id) => getPaperDetail(id)))

      const loadedPapers: WorkbenchPaper[] = []
      const failed: number[] = []

      results.forEach((res, idx) => {
        const paperId = ids[idx]
        if (res.status !== 'fulfilled' || !res.value) {
          failed.push(paperId)
          return
        }
        const detail = res.value
        const flat: PaperSourceQuestion[] = []
        const sections = Array.isArray(detail.sections) ? detail.sections : []
        for (const section of sections) {
          const qs = Array.isArray(section.questions) ? section.questions : []
          for (const q of qs) {
            if (q && q.id != null) flat.push(q)
          }
        }
        loadedPapers.push({
          paperId,
          paperName: detail.paperName || `试卷 ${paperId}`,
          questions: flat,
        })
      })

      // 跨卷合并去重（按题 id，保首次出现顺序）
      const seen = new Set<number>()
      const merged: PaperSourceQuestion[] = []
      for (const p of loadedPapers) {
        for (const q of p.questions) {
          const qid = Number(q.id)
          if (!qid || seen.has(qid)) continue
          seen.add(qid)
          merged.push(q)
        }
      }

      papers.value = loadedPapers
      questions.value = merged
      failedPaperIds.value = failed
    } finally {
      loading.value = false
    }
  }

  return {
    loading,
    papers,
    questions,
    knowledgeGroups,
    paperCount,
    failedPaperIds,
    load,
  }
}
