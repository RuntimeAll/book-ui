/**
 * useSpecialStore — 备课栏状态（PRD-003 scope①，取代旧 prepContext 语境横幅）。
 *
 * 备课栏 = 本次备课的专项清单 + 当前挑题去向（单选高亮）+ 备课上下文（正在备哪个学生/哪次课）。
 * 数据源：BE `/teacher/special/list`（我的专项）。当前专项 = 全站「＋入专项」pick 的去向。
 *
 * 与旧 prepContext 的区别：不再切试题栏命名空间、不再绑卷位（paper_slots 整套退役，D7）；
 *   备课上下文仅承载「正在备的课次」以便 P6 材料位 bind + 备课栏文案展示。
 *
 * 持久化：currentSpecialId → localStorage（跨会话记忆挑题去向）；
 *   prepContext（课次）→ sessionStorage（当前工作会话性质，跨天失效）。
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  listMySpecials,
  createSpecial,
  deleteSpecial,
  bindSpecialToLesson,
  type SpecialSummary,
} from '@/api/special'

const LS_CURRENT = 'book-ui:special-current'
const SS_PREP = 'book-ui:special-prep-ctx'

function todayStr(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 备课上下文（专项挂在哪次课）。 */
export interface SpecialPrepContext {
  lessonId: string
  lessonTitle: string
  studentName: string
  planId?: string
  targetId?: string
  openedDate?: string
}

export const useSpecialStore = defineStore('special', () => {
  const specials = ref<SpecialSummary[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const currentSpecialId = ref<string>(localStorage.getItem(LS_CURRENT) || '')
  const prep = ref<SpecialPrepContext | null>(hydratePrep())

  const count = computed(() => specials.value.length)
  const currentSpecial = computed(() => specials.value.find((s) => s.id === currentSpecialId.value) || null)
  const prepLabel = computed(() =>
    prep.value ? [prep.value.studentName, prep.value.lessonTitle].filter((x) => x && String(x).trim()).join(' · ') : '',
  )

  function hydratePrep(): SpecialPrepContext | null {
    try {
      const raw = sessionStorage.getItem(SS_PREP)
      if (!raw) return null
      const o = JSON.parse(raw) as SpecialPrepContext
      if (!o || !o.lessonId) return null
      // 跨天失效
      if (String(o.openedDate ?? '') !== todayStr()) {
        sessionStorage.removeItem(SS_PREP)
        return null
      }
      return o
    } catch {
      return null
    }
  }

  function persistCurrent() {
    try {
      if (currentSpecialId.value) localStorage.setItem(LS_CURRENT, currentSpecialId.value)
      else localStorage.removeItem(LS_CURRENT)
    } catch {
      /* ignore */
    }
  }

  function persistPrep() {
    try {
      if (prep.value) sessionStorage.setItem(SS_PREP, JSON.stringify(prep.value))
      else sessionStorage.removeItem(SS_PREP)
    } catch {
      /* ignore */
    }
  }

  /** 拉取我的专项列表（备课栏打开 / 挑题前调用）。 */
  async function refresh(): Promise<void> {
    loading.value = true
    try {
      const list = await listMySpecials()
      specials.value = Array.isArray(list) ? list : []
      // 当前去向若已不在列表则重置为第一个
      if (currentSpecialId.value && !specials.value.some((s) => s.id === currentSpecialId.value)) {
        currentSpecialId.value = specials.value[0]?.id ?? ''
        persistCurrent()
      }
      loaded.value = true
    } catch (e) {
      console.warn('[special-store] refresh failed', e)
    } finally {
      loading.value = false
    }
  }

  /** 首次懒加载（避免重复拉）。 */
  async function ensureLoaded(): Promise<void> {
    if (!loaded.value && !loading.value) await refresh()
  }

  function select(id: string): void {
    currentSpecialId.value = id
    persistCurrent()
  }

  /** 新建空白专项 → 刷新 → 设为当前去向 → 返回新 id。 */
  async function createNew(title: string): Promise<string> {
    const res = await createSpecial({ title: title.trim() })
    const id = String(res.id)
    await refresh()
    select(id)
    return id
  }

  /** 删除专项（从备课栏移除，级联删节点+题）。 */
  async function remove(id: string): Promise<void> {
    await deleteSpecial(id)
    specials.value = specials.value.filter((s) => s.id !== id)
    if (currentSpecialId.value === id) {
      currentSpecialId.value = specials.value[0]?.id ?? ''
      persistCurrent()
    }
  }

  /** 设备课上下文（P6「去备课」/ 从课次进入调用）。 */
  function setPrepContext(ctx: Omit<SpecialPrepContext, 'openedDate'>): void {
    prep.value = { ...ctx, openedDate: todayStr() }
    persistPrep()
  }

  function clearPrepContext(): void {
    prep.value = null
    persistPrep()
  }

  /** 把某专项绑到当前备课上下文的课次（材料位）。无上下文则报错交调用方处理。 */
  async function bindToCurrentLesson(specialId: string): Promise<void> {
    if (!prep.value?.lessonId) throw new Error('无备课上下文课次')
    await bindSpecialToLesson(prep.value.lessonId, specialId)
  }

  return {
    // state
    specials,
    loading,
    loaded,
    currentSpecialId,
    prep,
    // getters
    count,
    currentSpecial,
    prepLabel,
    // actions
    refresh,
    ensureLoaded,
    select,
    createNew,
    remove,
    setPrepContext,
    clearPrepContext,
    bindToCurrentLesson,
  }
})
