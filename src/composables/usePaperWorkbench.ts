import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { type PaperDetailVo, type PaperSourceQuestion } from '@/api/question'
import {
  createExamPaper,
  updateExamPaper,
  getExamPaperDetail,
  PaperCreateRejectedError,
  type CreateExamPaperParams,
} from '@/api/paper'
import {
  BASKET_MAX_SIZE,
  selectionKey,
  selectionReference,
  type BasketQuestion,
  type BasketEntryReference,
} from '@/api/questionBasket'
import { useQuestionBasket } from '@/composables/useQuestionBasket'
import { useUserStore } from '@/store/user'
import { getCurrentUser } from '@/api/user'

export interface WorkbenchEditRow extends PaperSourceQuestion {
  basketNamespace?: string
  basketEntryId?: string
  _sectionId: string
  _score: number
  _showExplain: boolean
  _replacing: boolean
}

interface WorkbenchDraft {
  version: 2
  requestId: string
  savedPaperId: string
  paperName: string
  suggestTime: number
  rows: WorkbenchEditRow[]
  sections: [string, string][]
  seenBasketKeys: string[]
  submittedEntries: BasketEntryReference[]
  pendingCreate?: CreateExamPaperParams
}

export function rowKey(row: PaperSourceQuestion): string {
  return row.paperQuestionId ? `paper:${row.paperQuestionId}` : selectionKey(row)
}

export function usePaperWorkbench() {
  const route = useRoute()
  const router = useRouter()
  const user = useUserStore()
  const basket = useQuestionBasket()
  const paperId = computed(() => (route.params.id ? String(route.params.id) : undefined))
  const isEditMode = computed(() => !!paperId.value)
  const paperDetail = ref<PaperDetailVo | null>(null)
  const detailLoading = ref(false)
  const saving = ref(false)
  const editRows = ref<WorkbenchEditRow[]>([])
  const paperName = ref('未命名草稿')
  const suggestTime = ref(120)
  const defaultSectionId = ref('')
  const sectionNameMap = ref(new Map<string, string>())
  const savedPaperId = ref('')
  const draftError = ref('')
  const loadError = ref('')
  const initialized = ref(false)
  const requestId = ref('')
  const pendingCreate = ref<CreateExamPaperParams>()
  const canManage = computed(() => !isEditMode.value || paperDetail.value?.canManage === true)
  const editsLocked = computed(() => !canManage.value || saving.value || !!savedPaperId.value || !!pendingCreate.value)
  let seenBasketKeys = new Set<string>()
  let submittedEntries: BasketEntryReference[] = []
  let generation = 0
  let hydrationSequence = 0
  let activeStorageKey = ''
  let halted = false

  function draftSnapshot(): WorkbenchDraft {
    return {
      version: 2,
      requestId: requestId.value,
      savedPaperId: savedPaperId.value,
      paperName: paperName.value,
      suggestTime: suggestTime.value,
      rows: editRows.value.map((row) => ({ ...row, _replacing: false })),
      sections: [...sectionNameMap.value],
      seenBasketKeys: [...seenBasketKeys],
      submittedEntries,
      pendingCreate: pendingCreate.value,
    }
  }

  function persistDraft(): boolean {
    if (!initialized.value || !activeStorageKey || halted) return false
    try {
      // sessionStorage 天然标签隔离；账号和编辑目标进一步隔离，不读取旧缓存。
      sessionStorage.setItem(activeStorageKey, JSON.stringify(draftSnapshot()))
      draftError.value = ''
      return true
    } catch {
      draftError.value = '草稿暂存失败，请释放浏览器存储空间后重试；当前内容仍在页面中。'
      return false
    }
  }

  function restoreDraft(): boolean {
    const raw = sessionStorage.getItem(activeStorageKey)
    if (!raw) return false
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') throw new Error('草稿格式不正确')
    const draft = value as WorkbenchDraft
    if (
      draft.version !== 2 ||
      !Array.isArray(draft.rows) ||
      draft.rows.length > BASKET_MAX_SIZE ||
      typeof draft.requestId !== 'string' ||
      !draft.requestId ||
      typeof draft.paperName !== 'string' ||
      !Number.isFinite(draft.suggestTime) ||
      !Array.isArray(draft.sections) ||
      !Array.isArray(draft.seenBasketKeys) ||
      !Array.isArray(draft.submittedEntries) ||
      draft.rows.some((row) => typeof row.id !== 'string' || !Number.isFinite(row._score))
    ) {
      throw new Error('草稿格式不正确，未覆盖现有内容')
    }
    requestId.value = draft.requestId
    savedPaperId.value = draft.savedPaperId || ''
    paperName.value = draft.paperName
    suggestTime.value = draft.suggestTime
    editRows.value = draft.rows
    sectionNameMap.value = new Map(draft.sections)
    seenBasketKeys = new Set(draft.seenBasketKeys)
    submittedEntries = draft.submittedEntries
    pendingCreate.value = draft.pendingCreate
    return true
  }

  function mergeBasket(questions: BasketQuestion[]) {
    if (!initialized.value || isEditMode.value || editsLocked.value) return
    const incoming = new Map(questions.map((q) => [q.entryKey, q]))
    // 补全只覆盖渲染数据；顺序、分值、分区和用户移除操作属于独立草稿。
    editRows.value = editRows.value.map((row) => {
      const full = incoming.get(selectionKey(row))
      return full ? { ...row, ...full, _score: row._score, _sectionId: row._sectionId } : row
    })
    for (const question of questions) {
      if (!seenBasketKeys.has(question.entryKey)) {
        editRows.value.push({
          ...question,
          _sectionId: '',
          _score: question.score ?? 0,
          _showExplain: false,
          _replacing: false,
        })
      }
      seenBasketKeys.add(question.entryKey)
    }
  }

  async function refreshBasketDraft() {
    if (!initialized.value || isEditMode.value || editsLocked.value) return
    const current = generation
    const sequence = ++hydrationSequence
    try {
      const entries = await basket.loadForComposition()
      if (current !== generation || sequence !== hydrationSequence) return
      mergeBasket(entries)
      loadError.value = ''
      persistDraft()
    } catch (e) {
      if (current !== generation || sequence !== hydrationSequence) return
      loadError.value = e instanceof Error ? e.message : '试题栏加载失败'
    }
  }

  async function addBasketToPaper() {
    if (!initialized.value || editsLocked.value) return
    const current = generation
    try {
      const questions = await basket.loadForComposition()
      if (current !== generation) return
      const existing = new Set(editRows.value.map(selectionKey))
      const additions = questions.filter((q) => !existing.has(q.entryKey))
      if (editRows.value.length + additions.length > BASKET_MAX_SIZE)
        throw new Error(`试卷最多 ${BASKET_MAX_SIZE} 题`)
      editRows.value.push(
        ...additions.map((q) => ({
          ...q,
          _sectionId: defaultSectionId.value,
          _score: q.score ?? 0,
          _showExplain: false,
          _replacing: false,
        })),
      )
      additions.forEach((q) => seenBasketKeys.add(q.entryKey))
      persistDraft()
      ElMessage.success(`已添加 ${additions.length} 题到草稿`)
    } catch (e) {
      if (current === generation) ElMessage.error(e instanceof Error ? e.message : '试题栏加载失败')
    }
  }

  async function initialize() {
    const current = ++generation
    hydrationSequence++
    initialized.value = false
    saving.value = false
    halted = false
    detailLoading.value = true
    paperDetail.value = null
    editRows.value = []
    paperName.value = '未命名草稿'
    suggestTime.value = 120
    defaultSectionId.value = ''
    sectionNameMap.value = new Map()
    savedPaperId.value = ''
    pendingCreate.value = undefined
    seenBasketKeys = new Set()
    submittedEntries = []
    loadError.value = ''
    draftError.value = ''
    activeStorageKey = ''
    try {
      if (!user.isLoggedIn) throw new Error('请先登录后组卷')
      if (!user.userInfo) {
        const info = await getCurrentUser()
        if (current !== generation) return
        user.setUserInfo(info)
      }
      if (current !== generation || !user.userInfo) return
      const id = paperId.value
      activeStorageKey = `book-ui:paper-draft:v2:${user.userInfo.id}:${basket.currentNamespace.value}:${id ?? 'new'}`
      requestId.value = crypto.randomUUID()
      const restored = restoreDraft()
      if (id) {
        const detail = await getExamPaperDetail(id)
        if (current !== generation) return
        paperDetail.value = detail
        defaultSectionId.value = detail.sections[0]?.sectionId ?? ''
        if (!restored) {
          paperName.value = detail.paperName
          suggestTime.value = detail.suggestTime || 120
          sectionNameMap.value = new Map(
            detail.sections.map((section) => [section.sectionId, section.title]),
          )
          editRows.value = detail.sections
            .flatMap((section) =>
              section.questions.map((q) => ({
                ...q,
                _sectionId: section.sectionId,
                _score: q.pqScore ?? q.score ?? 0,
                _showExplain: false,
                _replacing: false,
              })),
            )
            .sort((a, b) => (a.sortNum ?? a.sort ?? 0) - (b.sortNum ?? b.sort ?? 0))
        }
      }
      initialized.value = true
      if (!id && !savedPaperId.value) await refreshBasketDraft()
      if (current !== generation) return
      persistDraft()
    } catch (e) {
      if (current !== generation) return
      loadError.value = e instanceof Error ? e.message : '工作台加载失败'
    } finally {
      if (current === generation) detailLoading.value = false
    }
  }

  async function handleSave() {
    if (saving.value || !initialized.value || !canManage.value) return
    if (!savedPaperId.value) {
      if (!paperName.value.trim()) {
        ElMessage.warning('请输入试卷名称')
        return
      }
      if (editRows.value.length === 0 || editRows.value.length > BASKET_MAX_SIZE) {
        ElMessage.warning(`试卷需要 1 至 ${BASKET_MAX_SIZE} 道题`)
        return
      }
      if (
        !Number.isInteger(suggestTime.value) ||
        suggestTime.value < 1 ||
        suggestTime.value > 1440
      ) {
        ElMessage.warning('答题时间应为 1 至 1440 分钟')
        return
      }
      if (
        editRows.value.some(
          (r) =>
            !Number.isFinite(r._score) ||
            r._score < 0 ||
            r._score > 999.99 ||
            Math.abs(r._score * 100 - Math.round(r._score * 100)) > 0.000001,
        )
      ) {
        ElMessage.warning('分值应为 0 至 999.99，最多两位小数')
        return
      }
      if (new Set(editRows.value.map(selectionKey)).size !== editRows.value.length) {
        ElMessage.warning('同一题目实例不能重复入卷')
        return
      }
    }
    if (!persistDraft()) {
      ElMessage.error(draftError.value || '草稿尚未准备好')
      return
    }
    const current = generation
    const draftKey = activeStorageKey
    const targetId = paperId.value
    saving.value = true
    try {
      const questions = editRows.value.map((row, index) => ({
        ...selectionReference(row),
        sort: index + 1,
        score: row._score,
        ...(!row.paperQuestionId && (row.basketNamespace || seenBasketKeys.has(selectionKey(row)))
          ? {
              basketNamespace: row.basketNamespace ?? basket.currentNamespace.value,
              basketEntryId: row.basketEntryId,
            }
          : {}),
        sectionId: row._sectionId || defaultSectionId.value,
        ...(row.paperQuestionId ? { paperQuestionId: row.paperQuestionId } : {}),
      }))
      if (!savedPaperId.value) {
        if (targetId) {
          await updateExamPaper({
            paperId: targetId,
            name: paperName.value.trim(),
            suggestTime: suggestTime.value,
            questions,
            sections: [...sectionNameMap.value].map(([sectionId, name], index) => ({
              sectionId,
              name,
              sort: index + 1,
            })),
          })
          if (current !== generation) return
          savedPaperId.value = targetId
        } else {
          if (!pendingCreate.value) {
            const selected = editRows.value.filter((row) => seenBasketKeys.has(selectionKey(row)))
            if (selected.some((row) => !row.basketEntryId))
              throw new Error('试题栏记录版本缺失，请重新载入后保存')
            submittedEntries = selected.map((row) => ({
              entryKey: selectionKey(row),
              basketEntryId: row.basketEntryId!,
            }))
            pendingCreate.value = {
              name: paperName.value.trim(),
              requestId: requestId.value,
              suggestTime: suggestTime.value,
              questions,
            }
          }
          if (!persistDraft()) throw new Error(draftError.value)
          const result = await createExamPaper(pendingCreate.value)
          if (current !== generation) return
          if (!result?.paperId) throw new Error('服务器未返回试卷 ID')
          savedPaperId.value = String(result.paperId)
        }
        // 先保留成功结果；后续失败只读回和收尾，不再次创建。
        if (!persistDraft())
          throw new Error(`试卷已保存（${savedPaperId.value}），${draftError.value}`)
      }
      const confirmed = await getExamPaperDetail(savedPaperId.value)
      if (current !== generation) return
      if (
        String(confirmed.paperId) !== savedPaperId.value ||
        confirmed.sections.reduce((sum, section) => sum + section.questions.length, 0) !==
          confirmed.questionCount
      ) {
        throw new Error('试卷已保存，但详情校验未完成，请重试确认')
      }
      if (!targetId && submittedEntries.length) {
        await basket.removeSubmittedEntries(submittedEntries)
        if (current !== generation) return
        submittedEntries = []
        persistDraft()
      }
      const destination = savedPaperId.value
      const failure = await router.push(`/papers/source/${destination}`)
      if (failure) throw new Error(`试卷已保存（${destination}），页面跳转失败，请再次打开`)
      sessionStorage.removeItem(draftKey)
      halted = true
      ElMessage.success('试卷已保存')
    } catch (e) {
      if (current !== generation) return
      if (!savedPaperId.value && e instanceof PaperCreateRejectedError) {
        pendingCreate.value = undefined
        requestId.value = crypto.randomUUID()
        persistDraft()
      }
      const message = e instanceof Error ? e.message : '操作失败，请稍后重试'
      ElMessage.error(savedPaperId.value ? `试卷已保存，收尾未完成：${message}` : message)
    } finally {
      if (current === generation) saving.value = false
    }
  }

  async function clearDraft() {
    if (editsLocked.value) return
    if (!isEditMode.value) await basket.clear()
    hydrationSequence++
    seenBasketKeys = new Set()
    editRows.value = []
    submittedEntries = []
    persistDraft()
  }

  watch([paperId, () => user.accessToken, basket.currentNamespace], initialize, {
    immediate: true,
    flush: 'sync',
  })
  watch(basket.revision, () => {
    void refreshBasketDraft()
  })
  watch([editRows, paperName, suggestTime, sectionNameMap], () => persistDraft(), {
    deep: true,
    flush: 'sync',
  })
  onBeforeUnmount(() => {
    persistDraft()
    generation++
    hydrationSequence++
  })

  return {
    paperId,
    isEditMode,
    paperDetail,
    detailLoading,
    editRows,
    paperName,
    suggestTime,
    defaultSectionId,
    sectionNameMap,
    canManage,
    saving,
    savedPaperId,
    draftError,
    loadError,
    initialized,
    handleSave,
    initialize,
    persistDraft,
    addBasketToPaper,
    pendingCreate,
    editsLocked,
    clearDraft,
  }
}
