/**
 * usePrepEntry — 「去备课」入口编排。
 *
 * 🔴 PRD-003 D7：旧备课语境（prepContext 横幅 + 卷位定位）整套退役。
 *   「去备课」现只做一件事：跳课程计划页（/desk/plans）并定位/展开对应课次；
 *   课次的材料（专项）在计划页课次行的「本课材料」位维护（P6）。
 *
 * 排课总览场次卡 / 明日待备卡 / 场次抽屉的「去备课」共用本编排。
 */
import { useRouter } from 'vue-router'

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

  async function goPrepForLesson(input: PrepEntryInput): Promise<void> {
    const query: Record<string, string> = { from: input.from ?? 'overview' }
    if (input.targetId) query.targetId = String(input.targetId)
    if (input.lessonId) query.lessonId = String(input.lessonId)
    if (input.planId) query.planId = String(input.planId)
    await router.push({ path: '/desk/plans', query })
  }

  return { goPrepForLesson }
}
