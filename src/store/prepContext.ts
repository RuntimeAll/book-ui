/**
 * usePrepContextStore — 备课语境状态（PRD-B-101 B2b / AC2·AC4 / V2·V3·V4）
 *
 * 语境 = 老师"当前正在备哪节课的哪张专项卷"的工作会话上下文。开启后：
 *   - 常驻横幅（AppLayout）显示「学生·日期·课次·卷位」+配方摘要，全站可见。
 *   - 试题栏（useQuestionBasket）切到该课次卷位的独立命名空间仓（default ↔ lesson:{id}:slot{n}）。
 *   - 组卷工作台「创建试卷」自动带 lessonId+slotSeq（卷型=备课卷 + 绑该卷位），卷名预填「课次·卷位」。
 *
 * 三口子退出语境：退出（横幅按钮）/ 完成（创建成功弹层）/ 跨天过期（openedDate≠今天自动失效）。
 *
 * 持久化：sessionStorage（语境是"当前工作会话"性质，非跨会话资产；刷新不丢、跨天失效）。
 * 🔴 basket 命名空间切换是本 store 的副作用：open/switchToNextEmptySlot → 切语境仓；
 *   exit/complete/跨天过期 → 切回 default 仓。basket 的分仓数据本身在 localStorage（刷新不丢）。
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useQuestionBasket } from '@/composables/useQuestionBasket'
import type { PaperSlot } from '@/api/teacher/schedule'

const SS_KEY = 'book-ui:prep-context'

function todayStr(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function slotBound(s: PaperSlot | undefined | null): boolean {
  return !!(s && s.paper_id && String(s.paper_id).trim() !== '')
}

/** 开启语境入参（slots=课次卷位快照，用于「组下一张」定位下一空位） */
export interface OpenPrepPayload {
  planId?: string
  targetId?: string
  lessonId: string
  lessonTitle?: string
  studentName?: string
  lessonDate?: string
  slots?: PaperSlot[]
  slotSeq: number
}

export const usePrepContextStore = defineStore('prep-context', () => {
  const planId = ref('')
  const targetId = ref('')
  const lessonId = ref('')
  const lessonTitle = ref('')
  const studentName = ref('')
  const lessonDate = ref('')
  const slotSeq = ref(0)
  const slotName = ref('')
  const slotStyle = ref('')
  const slotRules = ref('')
  const slotNote = ref('')
  const slots = ref<PaperSlot[]>([])
  const openedDate = ref('')

  // active = 有课次 + 有卷位序号（slotSeq>0）
  const active = computed(() => !!lessonId.value && slotSeq.value > 0)
  const namespace = computed(() =>
    active.value ? `lesson:${lessonId.value}:slot${slotSeq.value}` : 'default',
  )
  // 组卷创建卷名预填「课次·卷位」（家长/学生不可见词不进此处：仅课次标题+卷位名，均老师命名）
  const paperNamePrefill = computed(() =>
    [lessonTitle.value, slotName.value].filter(Boolean).join('·'),
  )
  // 配方摘要（老师侧横幅可见，不受家长/学生可见词限制）
  const configSummary = computed(() =>
    [slotStyle.value, slotRules.value, slotNote.value].filter((x) => x && String(x).trim()).join(' · '),
  )
  // 下一个空卷位（序号更大且未绑卷）——供「组下一张」
  const nextEmptySlot = computed<PaperSlot | null>(
    () =>
      slots.value.find((s) => Number(s.slot_seq) > slotSeq.value && !slotBound(s)) ?? null,
  )
  const hasNextEmptySlot = computed(() => !!nextEmptySlot.value)

  function persist() {
    try {
      if (!active.value) {
        sessionStorage.removeItem(SS_KEY)
        return
      }
      sessionStorage.setItem(
        SS_KEY,
        JSON.stringify({
          planId: planId.value,
          targetId: targetId.value,
          lessonId: lessonId.value,
          lessonTitle: lessonTitle.value,
          studentName: studentName.value,
          lessonDate: lessonDate.value,
          slotSeq: slotSeq.value,
          slotName: slotName.value,
          slotStyle: slotStyle.value,
          slotRules: slotRules.value,
          slotNote: slotNote.value,
          slots: slots.value,
          openedDate: openedDate.value,
        }),
      )
    } catch (e) {
      console.warn('[prep-context] persist failed', e)
    }
  }

  // 用卷位快照回填当前卷位的名/风格/规则/备注
  function applySlotFields(seq: number) {
    const s = slots.value.find((x) => Number(x.slot_seq) === Number(seq))
    slotSeq.value = Number(seq)
    slotName.value = s?.name ?? slotName.value
    slotStyle.value = s?.style ?? ''
    slotRules.value = s?.rules ?? ''
    slotNote.value = s?.note ?? ''
  }

  function clearState() {
    planId.value = ''
    targetId.value = ''
    lessonId.value = ''
    lessonTitle.value = ''
    studentName.value = ''
    lessonDate.value = ''
    slotSeq.value = 0
    slotName.value = ''
    slotStyle.value = ''
    slotRules.value = ''
    slotNote.value = ''
    slots.value = []
    openedDate.value = ''
  }

  /** 开启语境（题库/课次行入口调用）→ 切试题栏语境仓 */
  function open(p: OpenPrepPayload) {
    planId.value = p.planId ?? ''
    targetId.value = p.targetId ?? ''
    lessonId.value = p.lessonId
    lessonTitle.value = p.lessonTitle ?? ''
    studentName.value = p.studentName ?? ''
    lessonDate.value = p.lessonDate ?? ''
    slots.value = (p.slots ?? []).map((s) => ({ ...s }))
    // slotName 先取入参卷位（applySlotFields 从快照回填，快照缺则保留）
    slotName.value = slots.value.find((s) => Number(s.slot_seq) === Number(p.slotSeq))?.name ?? ''
    applySlotFields(p.slotSeq)
    openedDate.value = todayStr()
    persist()
    useQuestionBasket().switchNamespace(namespace.value)
  }

  /**
   * 切到下一个空卷位（创建成功弹层「组下一张」）。
   * 把当前卷位在快照里标记为已绑（避免回头再被当空位），再定位下一空位。
   * 返回 false = 无空位（弹层不显示此按钮）。
   */
  function switchToNextEmptySlot(): boolean {
    const nx = nextEmptySlot.value
    if (!nx) return false
    const cur = slots.value.find((s) => Number(s.slot_seq) === slotSeq.value)
    if (cur) cur.paper_id = cur.paper_id || 'bound'
    applySlotFields(nx.slot_seq)
    persist()
    useQuestionBasket().switchNamespace(namespace.value)
    return true
  }

  /** 退出语境（横幅按钮 / 完成备课）→ 试题栏切回日常仓，留在当前页 */
  function exit() {
    clearState()
    persist()
    useQuestionBasket().switchNamespace('default')
  }
  // 完成备课与退出的语境清理一致（区别在调用方后续导航到课程计划页定位课次）
  const complete = exit

  /** store 创建时从 sessionStorage 复水；跨天则失效清理 */
  function hydrate() {
    try {
      const raw = sessionStorage.getItem(SS_KEY)
      if (!raw) return
      const o = JSON.parse(raw) as Record<string, unknown>
      if (!o || !o.lessonId || !o.slotSeq) return
      // 跨天过期：开启日期≠今天 → 自动失效
      if (String(o.openedDate ?? '') !== todayStr()) {
        sessionStorage.removeItem(SS_KEY)
        return
      }
      planId.value = String(o.planId ?? '')
      targetId.value = String(o.targetId ?? '')
      lessonId.value = String(o.lessonId ?? '')
      lessonTitle.value = String(o.lessonTitle ?? '')
      studentName.value = String(o.studentName ?? '')
      lessonDate.value = String(o.lessonDate ?? '')
      slotSeq.value = Number(o.slotSeq) || 0
      slotName.value = String(o.slotName ?? '')
      slotStyle.value = String(o.slotStyle ?? '')
      slotRules.value = String(o.slotRules ?? '')
      slotNote.value = String(o.slotNote ?? '')
      slots.value = Array.isArray(o.slots) ? (o.slots as PaperSlot[]) : []
      openedDate.value = String(o.openedDate ?? '')
      if (active.value) useQuestionBasket().switchNamespace(namespace.value)
    } catch (e) {
      console.warn('[prep-context] hydrate failed', e)
    }
  }

  hydrate()

  return {
    // state
    planId,
    targetId,
    lessonId,
    lessonTitle,
    studentName,
    lessonDate,
    slotSeq,
    slotName,
    slotStyle,
    slotRules,
    slotNote,
    slots,
    openedDate,
    // getters
    active,
    namespace,
    paperNamePrefill,
    configSummary,
    nextEmptySlot,
    hasNextEmptySlot,
    // actions
    open,
    switchToNextEmptySlot,
    exit,
    complete,
  }
})
