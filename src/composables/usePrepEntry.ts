/**
 * usePrepEntry — 「去备课」入口编排（PRD-B-101 B2b / D6·D11）
 *
 * 排课总览场次卡 / 明日待备卡 / 场次抽屉的「去备课」共用：
 *   - 有空卷位 → 开备课语境定位【第一个空卷位】+ 跳题库挑题（继承态卷位先物化，否则绑定端点定位不到）。
 *   - 全绑 或 零卷位 → 保持跳课程计划页定位展开对应课次（零卷位课次用户现建卷位再组，D11）。
 *   - 解析失败（找不到计划/课次）→ 兜底跳课程计划页定位。
 *
 * 课次行「组这张卷」不走此编排（plans 页已持有 lesson/slot/planDetail，直接 store.open）。
 */
import { useRouter } from 'vue-router'
import { usePrepContextStore } from '@/store/prepContext'
import {
  pagePlans,
  getPlan,
  upsertLessons,
  type PlanLessonVO,
  type PlanLessonBo,
} from '@/api/teacher/schedule'

function slotBound(paperId?: string | null): boolean {
  return !!(paperId && String(paperId).trim() !== '')
}

export interface PrepEntryInput {
  targetId?: string
  lessonId?: string
  planId?: string
  studentName?: string
  lessonDate?: string
  from?: string
}

export function usePrepEntry() {
  const router = useRouter()
  const ctx = usePrepContextStore()

  // 继承态卷位先物化（写课次即拥有自有卷位，绑定端点才定位得到）
  async function materializeIfInherited(planId: string, lesson: PlanLessonVO): Promise<void> {
    if (!lesson.paperSlotsInherited) return
    const bo: PlanLessonBo = {
      id: lesson.id,
      title: lesson.title,
      lessonSeq: lesson.lessonSeq,
      lessonType: lesson.lessonType,
      tag: lesson.tag,
      sourceRef: lesson.sourceRef,
      thinkingAction: lesson.thinkingAction,
      layerTarget: lesson.layerTarget,
      parentCopy: lesson.parentCopy,
      kgNodeIds: lesson.kgNodeIds,
      paperSlots: (lesson.paperSlots ?? []).map((s) => ({ ...s })),
    }
    await upsertLessons(planId, [bo])
  }

  // resolvedPlanId：解析阶段已定位的计划 id（多计划学生时唯一正确来源，优先于 input.planId）。
  // 无解析结果才回退 input.planId；两者皆空时 plans 页按 targetId best-effort（单计划场景仍准）。
  function fallbackToPlans(input: PrepEntryInput, resolvedPlanId?: string) {
    const query: Record<string, string> = { from: input.from ?? 'overview' }
    if (input.targetId) query.targetId = String(input.targetId)
    if (input.lessonId) query.lessonId = String(input.lessonId)
    const planId = resolvedPlanId ?? input.planId
    if (planId) query.planId = String(planId)
    router.push({ path: '/desk/plans', query })
  }

  async function goPrepForLesson(input: PrepEntryInput): Promise<void> {
    const { lessonId, targetId } = input
    let resolved: { planId: string; lesson: PlanLessonVO } | null = null
    try {
      if (lessonId) {
        const candPlanIds: string[] = []
        if (input.planId) {
          candPlanIds.push(String(input.planId))
        } else {
          const page = await pagePlans({ pageNum: 1, pageSize: 100 })
          ;(page?.rows ?? [])
            .filter((p) => !targetId || String(p.targetId ?? '') === String(targetId))
            .forEach((p) => candPlanIds.push(p.id))
        }
        for (const pid of candPlanIds) {
          const detail = await getPlan(pid)
          const lesson = detail?.lessons?.find((l) => l.id === lessonId)
          if (lesson) {
            resolved = { planId: pid, lesson }
            break
          }
        }
      }
    } catch (e) {
      console.warn('[prep-entry] resolve plan/lesson failed', e)
    }

    if (resolved) {
      const slots = resolved.lesson.paperSlots ?? []
      const empty = slots.find((s) => !slotBound(s.paper_id))
      if (empty) {
        try {
          await materializeIfInherited(resolved.planId, resolved.lesson)
        } catch (e) {
          console.warn('[prep-entry] materialize slots failed', e)
        }
        ctx.open({
          planId: resolved.planId,
          targetId: targetId ? String(targetId) : '',
          lessonId: resolved.lesson.id,
          lessonTitle: resolved.lesson.title,
          studentName: input.studentName ?? '',
          lessonDate: input.lessonDate ?? '',
          slots: slots.map((s) => ({ ...s })),
          slotSeq: Number(empty.slot_seq),
        })
        router.push({ name: 'QuestionIndex' })
        return
      }
    }
    // 全绑 / 零卷位 / 解析失败 → 跳课程计划页定位（用已解析的 planId 修多计划学生定位错计划）
    fallbackToPlans(input, resolved?.planId)
  }

  return { goPrepForLesson }
}
