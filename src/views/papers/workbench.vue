<script setup lang="ts">
/**
 * PRD-A-007 Wave1 — misikt 式两栏组卷工作台
 * PRD-A-007 Wave2a — 自由排序拖拽 + 大题标题重命名
 *
 * 入口：
 *   新建态 /papers/workbench        → 数据源 useQuestionBasket，动作"创建试卷"
 *   编辑态 /papers/workbench/:id    → 加载 paper detail，动作"保存修改"
 *
 * 左主栏（~70%）：试卷标题(行内可改) + 大题分组头 + 题卡列（复用 .source-question-card 骨架）
 *   每题底部工具栏：分值[- N +] | 解析 toggle | 上移 | 下移 | 删除 | 换一题 | 详情
 *
 * 右固定栏（~30%, sticky）：tabs(按题型/按知识点/自由排序) + 题号块网格 +
 *   继续挑题/清空 + 答题时间[- N +] + 导出选项 + 下载PDF + 保存/创建
 *
 * Wave2a 新增：
 *   - 自由排序 tab：sortablejs 拖拽题号块 → 同步 editRows 顺序 → 左栏实时刷新
 *   - 大题标题 ✏️ 重命名：inline 编辑，保存时带 sections[] 持久化
 *   - 「+ 添加分类」置灰（BE v1 未实现新建 section）
 */
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
// PRD-A-010 T3：题卡内的 Top/Bottom/Delete/InfoFilled/Refresh 图标随 WorkbenchCard
// 子组件迁出，父组件仅保留顶栏 ArrowLeft + 大题重命名 Edit。
import { ArrowLeft, Edit } from '@element-plus/icons-vue'
import Sortable from 'sortablejs'
import {
  getPaperDetail,
  type PaperDetailVo,
  type PaperSourceQuestion,
  type QuestionItem,
} from '@/api/question/index'
import {
  createExamPaper,
  updateExamPaper,
  type UpdatePaperQuestion,
  type UpdatePaperSection,
} from '@/api/paper/index'
import PaperPreview from '@/components/business/PaperPreview/index.vue'
import ReplaceQuestionDialog from './components/ReplaceQuestionDialog.vue'
import WorkbenchCard from './components/WorkbenchCard.vue'
import { useQuestionBasket } from '@/composables/useQuestionBasket'
import { usePrepContextStore } from '@/store/prepContext'
import { useUserStore } from '@/store/user'
import { useDictStore, DICT_QUESTION_TYPE } from '@/store/dict'
import { getCurrentUser } from '@/api/user'

// ── 路由 ────────────────────────────────────────────────────────────────────
const route = useRoute()
const router = useRouter()
const paperId = computed(() => route.params.id as string | undefined)
const isEditMode = computed(() => !!paperId.value)

// ── 试题栏（新建态数据源）────────────────────────────────────────────────────
const basket = useQuestionBasket()

// ── 备课语境（PRD-B-101 B2b）───────────────────────────────────────────────
// 语境激活时：创建带 lessonId+slotSeq（卷型=备课卷+绑卷位）、卷名预填「课次·卷位」、
// 成功走三按钮弹层（下载 PDF / 组下一张 / 完成备课）。无语境=日常组卷，行为不变。
const prepCtx = usePrepContextStore()
const createSuccessVisible = ref(false)
const createdPaperId = ref('')
const createdBoundLabel = ref('') // 冻结创建时的「课次·卷位」（组下一张会改语境）

// ── 用户 / owner 判定 ────────────────────────────────────────────────────────
const userStore = useUserStore()
const isOwner = computed(() => {
  if (!isEditMode.value) return true // 新建态 = 自己创建，不需 owner 校验
  const uid = userStore.userInfo?.id
  const createBy = paperDetail.value?.createBy
  if (uid == null || createBy == null) return false
  return String(createBy) === String(uid)
})

// ── 试卷详情（编辑态）────────────────────────────────────────────────────────
const paperDetail = ref<PaperDetailVo | null>(null)
const detailLoading = ref(false)

async function loadPaperDetail() {
  if (!paperId.value) return
  detailLoading.value = true
  paperDetail.value = null
  try {
    const res = await getPaperDetail(paperId.value)
    if (res && (res as { paperId?: unknown }).paperId) {
      paperDetail.value = res as PaperDetailVo
      buildEditRows()
    } else {
      ElMessage.warning('试卷数据加载失败')
    }
  } catch (e) {
    console.warn('[workbench] loadPaperDetail failed', e)
    ElMessage.warning('试卷数据加载失败（接口需登录态）')
  } finally {
    detailLoading.value = false
  }
}

// ── EditRow（统一编辑行，同时承载新建/编辑两态）────────────────────────────
// PRD-A-013 T2 — _sectionId 雪花 string；空态用 '' 不用 0。
interface EditRow extends PaperSourceQuestion {
  _sectionId: string
  _score: number
  _showExplain: boolean // 解析 toggle（本地视图态）
  _replacing: boolean   // 换一题 loading
}

const editRows = ref<EditRow[]>([])
const paperName = ref('未命名草稿')
const defaultSectionId = ref<string>('')
const saving = ref(false)

// ── 大题分组的 section 信息（重命名用）──────────────────────────────────────
// key = sectionId，value = 当前显示名称（初始从 paperDetail sections 读入）
// PRD-A-013 T2 — sectionId 雪花 string
const sectionNameMap = ref<Map<string, string>>(new Map())
// 当前处于内联编辑的 sectionId（null = 不在编辑）
const editingSectionId = ref<string | null>(null)
// 内联编辑中的临时值
const editingSectionName = ref('')

function startRenameSection(sectionId: string) {
  editingSectionId.value = sectionId
  editingSectionName.value = sectionNameMap.value.get(sectionId) ?? ''
  nextTick(() => {
    const inp = document.querySelector<HTMLInputElement>('.rename-input input')
    inp?.focus()
    inp?.select()
  })
}

function commitRenameSection(sectionId: string) {
  const trimmed = editingSectionName.value.trim()
  if (trimmed) {
    sectionNameMap.value.set(sectionId, trimmed)
  }
  editingSectionId.value = null
}

function cancelRenameSection() {
  editingSectionId.value = null
}

// 全卷已有题 ids（换一题 excludeIds 用）
// PRD-A-013 T2 — 雪花 string[]
const paperQuestionIds = computed<string[]>(() => editRows.value.map((r) => r.id))

const totalScore = computed<number>(() =>
  editRows.value.reduce((sum, r) => sum + (Number(r._score) || 0), 0),
)

// 新建态：从 basket 构建 editRows
function buildEditRowsFromBasket() {
  editRows.value = basket.items.value.map((q) => ({
    ...(q as PaperSourceQuestion),
    // PRD-A-013 T2 — 雪花空态 ''
    _sectionId: '',
    _score: Number(q.score ?? 0),
    _showExplain: false,
    _replacing: false,
  }))
}

// 编辑态：从 detail 构建 editRows + 初始化 sectionNameMap
function buildEditRows() {
  const sections = paperDetail.value?.sections ?? []
  if (sections.length > 0) defaultSectionId.value = sections[0].sectionId

  // 初始化大题名称 map（PaperSectionVo 字段名 = title）
  // PRD-A-013 T2 — sectionId 雪花 string
  const nameMap = new Map<string, string>()
  sections.forEach((sec) => {
    nameMap.set(sec.sectionId, sec.title || `大题${sec.sectionId}`)
  })
  sectionNameMap.value = nameMap

  const rows: EditRow[] = []
  sections.forEach((sec) => {
    ;(sec.questions || []).forEach((q) => {
      rows.push({
        ...q,
        _sectionId: sec.sectionId,
        _score: Number(q.pqScore ?? q.score ?? 0),
        _showExplain: false,
        _replacing: false,
      })
    })
  })
  rows.sort((a, b) => Number(a.sortNum ?? a.sort ?? 0) - Number(b.sortNum ?? b.sort ?? 0))
  editRows.value = rows
  paperName.value = paperDetail.value?.paperName || ''
}

// ── 大题分组（按题型分组，全卷连续序号）──────────────────────────────────────
interface SectionGroup {
  title: string
  rows: { row: EditRow; globalIndex: number; editRowIndex: number }[]
}

const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
function cnLabel(i: number) {
  return CN_NUM[i] ?? String(i + 1)
}

// 题型 label 走字典 SSOT（biz_question_type，超管可维护，含全 8 类）。
const dict = useDictStore()
dict.load(DICT_QUESTION_TYPE)
function getQuestionTypeLabel(type: number): string {
  return dict.label(DICT_QUESTION_TYPE, type) || `题型${type}`
}

// 题型彩标死代码（getQuestionTypeTag）已删除：彩标统一走 WorkbenchCard 子组件的 dict.tagType（字典 SSOT）。

// 按题型分组，全局序号按 editRows 原始顺序（第i题 = 序号i+1，跨分组连续）
const sectionGroups = computed<SectionGroup[]>(() => {
  // 先建 type → 题目列表 的有序 map（保持 editRows 内遇到题型的顺序）
  const typeOrder: number[] = []
  const typeMap = new Map<number, { row: EditRow; globalIndex: number; editRowIndex: number }[]>()

  editRows.value.forEach((r, i) => {
    const t = r.questionType
    if (!typeMap.has(t)) {
      typeOrder.push(t)
      typeMap.set(t, [])
    }
    typeMap.get(t)!.push({ row: r, globalIndex: i + 1, editRowIndex: i })
  })

  return typeOrder.map((type) => ({
    title: getQuestionTypeLabel(type),
    rows: typeMap.get(type)!,
  }))
})

// 右栏题号网格（按题型分组）
// PRD-A-013 T2 — sectionId 雪花 string
interface NumberGroup {
  title: string
  sectionId?: string // 编辑态下关联 sectionId，重命名用
  nums: number[]
}

const numberGroups = computed<NumberGroup[]>(() => {
  return sectionGroups.value.map((g, gIdx) => ({
    title: `${cnLabel(gIdx)}、${g.title}（共${g.rows.length}题）`,
    nums: g.rows.map((r) => r.globalIndex),
  }))
})

// ── 按知识点分组（knowledge tab）────────────────────────────────────────────
// 分组 key = 首考点 knowledgeName；无考点归"未分类"排末尾；全卷连续序号
interface KnowledgeSectionGroup {
  title: string
  rows: { row: EditRow; globalIndex: number; editRowIndex: number }[]
}

const knowledgeSectionGroups = computed<KnowledgeSectionGroup[]>(() => {
  const knowledgeOrder: string[] = []
  const knowledgeMap = new Map<string, { row: EditRow; globalIndex: number; editRowIndex: number }[]>()
  const unknownKey = '未分类'

  editRows.value.forEach((r, i) => {
    const kName =
      r.questionKnowledges && r.questionKnowledges.length > 0
        ? (r.questionKnowledges[0].knowledgeName || '未分类')
        : '未分类'
    if (!knowledgeMap.has(kName)) {
      knowledgeOrder.push(kName)
      knowledgeMap.set(kName, [])
    }
    knowledgeMap.get(kName)!.push({ row: r, globalIndex: i + 1, editRowIndex: i })
  })

  // 把"未分类"排到末尾
  const orderedKeys = [
    ...knowledgeOrder.filter((k) => k !== unknownKey),
    ...(knowledgeOrder.includes(unknownKey) ? [unknownKey] : []),
  ]

  return orderedKeys.map((kName) => ({
    title: kName,
    rows: knowledgeMap.get(kName)!,
  }))
})

const knowledgeNumberGroups = computed<NumberGroup[]>(() => {
  return knowledgeSectionGroups.value.map((g, gIdx) => ({
    title: `${cnLabel(gIdx)}、${g.title}（共${g.rows.length}题）`,
    nums: g.rows.map((r) => r.globalIndex),
  }))
})

// ── 自由排序 tab — 平铺所有题（无分组，可跨题型拖）──────────────────────────
// 自由排序使用平铺结构（misikt 视觉：全部题号块在同一网格内）
// 每个 freesort item 持 editRowIndex，拖拽后重排 editRows

// PRD-A-013 T2 — id / sectionId 雪花 string
interface FreesortItem {
  id: string            // 题目稳定身份键（用于 v-for :key，避免拖拽后 key 乱序）
  globalIndex: number   // 拖前序号（仅展示，拖后由位置决定）
  editRowIndex: number  // 在 editRows 中的位置
  sectionId: string     // 所属 sectionId（对应 sectionNameMap）
}

// 编辑态按 section 分组平铺；新建态全在 sectionId='' 的默认组
const freesortGroups = computed(() => {
  if (!isEditMode.value || sectionNameMap.value.size === 0) {
    // 新建态 or 无 section map：全部归一组
    const defaultName = '试题'
    return [
      {
        sectionId: '',
        sectionName: defaultName,
        items: editRows.value.map((r, i) => ({
          id: r.id,
          globalIndex: i + 1,
          editRowIndex: i,
          sectionId: '',
        })) as FreesortItem[],
      },
    ]
  }

  // 编辑态：按 sectionId 分组（保持 editRows 出现顺序）
  // PRD-A-013 T2 — 雪花 string
  const groupOrder: string[] = []
  const groupMap = new Map<string, FreesortItem[]>()

  editRows.value.forEach((r, i) => {
    const sid = r._sectionId || defaultSectionId.value
    if (!groupMap.has(sid)) {
      groupOrder.push(sid)
      groupMap.set(sid, [])
    }
    groupMap.get(sid)!.push({ id: r.id, globalIndex: i + 1, editRowIndex: i, sectionId: sid })
  })

  return groupOrder.map((sid) => ({
    sectionId: sid,
    sectionName: sectionNameMap.value.get(sid) ?? `大题${sid}`,
    items: groupMap.get(sid)!,
  }))
})

// ── Sortablejs 拖拽（自由排序 tab）─────────────────────────────────────────
// renderKey 递增 → 强制自由排序网格完整 remount，确保拖后题号块按新 editRows 顺序连续渲染
const freesortRenderKey = ref(0)
const freesortContainerRefs = ref<(HTMLElement | null)[]>([])
let sortableInstances: Sortable[] = []

function setFreesortContainerRef(el: HTMLElement | null, idx: number) {
  freesortContainerRefs.value[idx] = el
}

function initSortable() {
  destroySortable()
  nextTick(() => {
    freesortContainerRefs.value.forEach((el, gIdx) => {
      if (!el) return
      const group = freesortGroups.value[gIdx]
      if (!group) return

      const instance = Sortable.create(el, {
        group: 'freesort',         // 允许跨分组拖拽
        animation: 150,
        ghostClass: 'freesort-ghost',
        chosenClass: 'freesort-chosen',
        dragClass: 'freesort-drag',
        onEnd(evt) {
          // 从哪个 group 拖出
          const fromGroupIdx = Number(evt.from.getAttribute('data-group-idx'))
          // 拖到哪个 group
          const toGroupIdx = Number(evt.to.getAttribute('data-group-idx'))
          const oldIdx = evt.oldIndex ?? 0
          const newIdx = evt.newIndex ?? 0

          if (fromGroupIdx === toGroupIdx && oldIdx === newIdx) return

          // 从 freesortGroups 计算当前各 item 的 editRowIndex 映射（拖前快照）
          // 注意：sortablejs 已在 DOM 层移动，但我们的数据还未变
          // 策略：根据 DOM 当前各格的 data-edit-row-index 重建 editRows 顺序

          // 收集 DOM 当前顺序的 editRowIndex 列表（跨所有 group 拼接）
          const allContainers = Array.from(
            document.querySelectorAll<HTMLElement>('.freesort-grid[data-group-idx]'),
          ).sort(
            (a, b) =>
              Number(a.getAttribute('data-group-idx')) -
              Number(b.getAttribute('data-group-idx')),
          )

          const newOrder: number[] = []
          allContainers.forEach((container) => {
            container
              .querySelectorAll<HTMLElement>('[data-edit-row-index]')
              .forEach((cell) => {
                const idx = Number(cell.getAttribute('data-edit-row-index'))
                newOrder.push(idx)
              })
          })

          if (newOrder.length !== editRows.value.length) return

          // 按 newOrder 重排 editRows
          const oldRows = [...editRows.value]
          editRows.value = newOrder.map((i) => oldRows[i])

          // 强制干净重渲染：递增 renderKey → freesort group :key 变化 → remount → sortable 重绑
          freesortRenderKey.value++
          nextTick(() => initSortable())
        },
      })
      sortableInstances.push(instance)
    })
  })
}

function destroySortable() {
  sortableInstances.forEach((s) => s.destroy())
  sortableInstances = []
}

// activeTab 切换到 freesort 时初始化 sortable
const activeTab = ref<'type' | 'knowledge' | 'freesort'>('type')

watch(activeTab, (tab) => {
  if (tab === 'freesort') {
    nextTick(() => initSortable())
  } else {
    destroySortable()
  }
})

// editRows 变化时，若在 freesort tab 则重建 sortable（保持绑定最新 DOM）
watch(
  () => editRows.value.length,
  () => {
    if (activeTab.value === 'freesort') {
      nextTick(() => initSortable())
    }
  },
)

onBeforeUnmount(() => {
  destroySortable()
})

// ── 题卡操作 ────────────────────────────────────────────────────────────────
function moveUp(idx: number) {
  if (idx <= 0) return
  const arr = [...editRows.value]
  ;[arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]]
  editRows.value = arr
}

function moveDown(idx: number) {
  if (idx >= editRows.value.length - 1) return
  const arr = [...editRows.value]
  ;[arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]]
  editRows.value = arr
}

function deleteRow(idx: number) {
  const arr = [...editRows.value]
  arr.splice(idx, 1)
  editRows.value = arr
  ElMessage.success('已移除该题')
}

function toggleExplain(row: EditRow) {
  row._showExplain = !row._showExplain
}

// 换一题 — 打开检索弹窗让老师自己挑（PRD-A-007 Wave4 改动②）
const replaceDialogVisible = ref(false)
const replaceTargetRow = ref<EditRow | null>(null)
const replaceTargetIdx = ref(-1)

function handleReplace(row: EditRow, idx: number) {
  replaceTargetRow.value = row
  replaceTargetIdx.value = idx
  replaceDialogVisible.value = true
}

function onReplaceSelect(picked: QuestionItem) {
  const idx = replaceTargetIdx.value
  const origRow = replaceTargetRow.value
  if (idx < 0 || !origRow) return

  const newRow: EditRow = {
    ...(picked as PaperSourceQuestion),
    _sectionId: origRow._sectionId,
    _score: origRow._score,        // 保留原分值
    _showExplain: false,
    _replacing: false,
  }
  const arr = [...editRows.value]
  arr.splice(idx, 1, newRow)
  editRows.value = arr
  ElMessage.success('已替换该题')
}

// 题号块点击 → 左栏滚动定位（PRD-A-007 Wave4 改动③）
function scrollToQuestion(n: number) {
  const el = document.getElementById('wb-q-' + n)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('wb-card-flash')
    setTimeout(() => el.classList.remove('wb-card-flash'), 1200)
  }
}

function handleDetail(row: EditRow) {
  // 存 cache 供详情页兜底
  try {
    const cacheKey = 'book-ui:question-cache-by-id'
    const existing = JSON.parse(localStorage.getItem(cacheKey) || '{}')
    existing[String(row.id)] = row
    localStorage.setItem(cacheKey, JSON.stringify(existing))
  } catch (e) {
    console.warn('[workbench] detail cache write failed', e)
  }
  router.push(`/question/detail/${row.id}`)
}

// ── 右栏状态 ────────────────────────────────────────────────────────────────
const suggestTime = ref<number>(120)
const showAnswer = ref(false)
const showExplain = ref(false)
const previewVisible = ref(false)

// 编辑态加载后同步 suggestTime
watch(paperDetail, (d) => {
  if (d?.suggestTime) suggestTime.value = d.suggestTime
})

function handleTimeDecrease() {
  if (suggestTime.value > 0) suggestTime.value -= 5
}

function handleTimeIncrease() {
  suggestTime.value += 5
}

// 继续挑题 → 跳题库
function handleContinuePick() {
  router.push('/question/index')
}

// 清空试题栏（仅新建态有意义）
async function handleClearBasket() {
  if (editRows.value.length === 0) return
  try {
    await ElMessageBox.confirm('确认清空当前所有题目？', '清空确认', {
      confirmButtonText: '确定清空',
      cancelButtonText: '取消',
      type: 'warning',
    })
    editRows.value = []
    if (!isEditMode.value) {
      await basket.clear()
    }
  } catch {
    // 取消
  }
}

// 导出 PDF
function handleExportPdf() {
  if (editRows.value.length === 0) {
    ElMessage.warning('试卷暂无题目，无法导出')
    return
  }
  previewVisible.value = true
}

// PRD-A-013 T2 — 雪花 string[]
const exportQuestionIds = computed<string[]>(() => editRows.value.map((r) => r.id))
const exportPaperName = computed(() => paperName.value.trim() || '未命名试卷')

// ── 保存 / 创建 ──────────────────────────────────────────────────────────────
async function handleSave() {
  if (editRows.value.length === 0) {
    ElMessage.warning('试卷至少需要 1 道题')
    return
  }
  if (!paperName.value.trim()) {
    ElMessage.warning('请输入试卷名称')
    return
  }
  saving.value = true
  try {
    // sort = 拖拽后 editRows 位置 i+1（1-based 连续，拖拽单一数据源保证）
    const questions: UpdatePaperQuestion[] = editRows.value.map((r, i) => ({
      questionId: r.id,
      sectionId: r._sectionId || defaultSectionId.value,
      sort: i + 1,
      score: Number(r._score) || 0,
    }))

    if (isEditMode.value) {
      // 编辑态：updateExamPaper
      // sections：仅发已有 sectionId 非空的重命名条目（BE v1 不支持新建 section）
      const sections: UpdatePaperSection[] = []
      let sortIdx = 0
      sectionNameMap.value.forEach((name, sectionId) => {
        sections.push({ sectionId, name, sort: ++sortIdx })
      })

      await updateExamPaper({
        // PRD-A-013 T2 — paperId 雪花 string，禁 Number() 截尾；
        // 编辑态由 isEditMode 守护 paperId 必存在，`!` 安全。
        paperId: paperId.value!,
        name: paperName.value.trim(),
        questions,
        suggestTime: suggestTime.value,
        ...(sections.length > 0 ? { sections } : {}),
      })
      ElMessage.success('保存成功')
      // 回查看态
      router.push(`/papers/source/${paperId.value}`)
    } else {
      // 新建态：createExamPaper（不支持 sections，由 BE 自动建默认 section）
      // PRD-B-101 — 备课语境激活时带 lessonId+slotSeq（BE 置 paper_kind='2' 并绑卷位，事务一致）
      const inPrep = prepCtx.active
      const result = await createExamPaper({
        name: paperName.value.trim(),
        questionIds: editRows.value.map((r) => r.id),
        ...(inPrep ? { lessonId: prepCtx.lessonId, slotSeq: prepCtx.slotSeq } : {}),
      })
      if (!result || !result.paperId) {
        ElMessage.error('创建失败：服务器未返回试卷 ID')
        return
      }
      // 清当前仓（日常仓 or 语境仓）——语境仓这些题已进卷
      await basket.clear()
      if (inPrep) {
        // 备课语境：成功弹层三按钮接管，不直接跳走
        createdPaperId.value = result.paperId
        createdBoundLabel.value = prepCtx.paperNamePrefill
        createSuccessVisible.value = true
      } else {
        ElMessage.success(`已创建试卷《${paperName.value.trim()}》— ${result.questionCount} 题`)
        router.push(`/papers/source/${result.paperId}`)
      }
    }
  } catch (e: unknown) {
    const msg = (e as { message?: string })?.message || '操作失败，请稍后重试'
    ElMessage.error(`操作失败：${msg}`)
    console.warn('[workbench] save/create failed', e)
  } finally {
    saving.value = false
  }
}

function goBack() {
  router.back()
}

// ── 备课语境·创建成功弹层三按钮（PRD-B-101 V3）──────────────────────────────
// ［下载 PDF］→ 跳卷预览页（B0 的 jsPDF 导出在那）
function onPrepDownloadPdf() {
  const id = createdPaperId.value
  createSuccessVisible.value = false
  if (id) router.push(`/papers/source/${id}`)
}

// ［组下一张］→ 语境切下一个空卷位、试题栏切到新仓（空）、工作台重置为新卷
function onPrepComposeNext() {
  const ok = prepCtx.switchToNextEmptySlot()
  if (!ok) {
    ElMessage.info('没有更多空卷位了')
    createSuccessVisible.value = false
    return
  }
  createSuccessVisible.value = false
  // basket 已切到下一卷位的新仓（空）；重建题行 + 预填新卷名
  buildEditRowsFromBasket()
  paperName.value = prepCtx.paperNamePrefill
  suggestTime.value = 120
  ElMessage.success(`已切到下一卷位：${prepCtx.slotName}，去题库挑题`)
}

// ［完成备课］→ 退出语境 → 回课程计划页定位该课次
function onPrepComplete() {
  const planId = prepCtx.planId
  const lessonId = prepCtx.lessonId
  const targetId = prepCtx.targetId
  prepCtx.complete()
  createSuccessVisible.value = false
  const query: Record<string, string> = { from: 'prep-complete' }
  if (planId) query.planId = planId
  if (lessonId) query.lessonId = lessonId
  if (targetId) query.targetId = targetId
  router.push({ path: '/desk/plans', query })
}

// ── 初始化 ───────────────────────────────────────────────────────────────────
onMounted(async () => {
  if (!userStore.userInfo) {
    try {
      const info = await getCurrentUser()
      if (info) userStore.setUserInfo(info)
    } catch (e) {
      console.warn('[workbench] getCurrentUser 兜底失败', e)
    }
  }

  if (isEditMode.value) {
    await loadPaperDetail()
  } else {
    // 新建态：从 basket 同步
    buildEditRowsFromBasket()
    // PRD-B-101 — 备课语境激活且卷名仍是默认草稿名 → 预填「课次·卷位」（可改）
    if (prepCtx.active && prepCtx.paperNamePrefill && (!paperName.value || paperName.value === '未命名草稿')) {
      paperName.value = prepCtx.paperNamePrefill
    }
    // basket 变化时同步（SPA 内 basket 可能在题库页更新）
    watch(
      () => basket.items.value,
      () => {
        if (!isEditMode.value) buildEditRowsFromBasket()
      },
      { deep: true },
    )
  }
})

// SPA 内路由 id 变化时重新加载
watch(paperId, async (newId) => {
  if (newId) {
    await loadPaperDetail()
  } else {
    buildEditRowsFromBasket()
  }
})
</script>

<template>
  <div class="workbench-page">
    <!-- 顶部导航栏 -->
    <div class="workbench-topbar">
      <el-button link class="back-btn" @click="goBack">
        <el-icon><ArrowLeft /></el-icon>
        <span>返回</span>
      </el-button>

      <!-- 试卷标题行内编辑 -->
      <el-input
        v-model="paperName"
        placeholder="请输入试卷名称"
        class="title-input"
        size="default"
        :maxlength="200"
      />

      <!-- 右侧统计 pill -->
      <div class="topbar-stat">
        <span class="stat-num">{{ editRows.length }}</span><span class="stat-unit">题</span>
        <span class="stat-sep">·</span>
        <span class="stat-num total">{{ totalScore }}</span><span class="stat-unit">分</span>
      </div>
    </div>

    <!-- 两栏主体 -->
    <div class="workbench-body">
      <!-- ══ 左主栏 ══ -->
      <div class="workbench-left">
        <!-- loading -->
        <div v-if="detailLoading" class="wb-loading">
          <el-skeleton :rows="10" animated style="max-width: 100%;" />
        </div>

        <!-- 空态 -->
        <div v-else-if="editRows.length === 0" class="wb-empty">
          <el-empty description="试卷暂无题目，请从题库挑题或使用试题栏添加">
            <el-button type="primary" @click="handleContinuePick">去题库选题</el-button>
          </el-empty>
        </div>

        <!-- 大题分组 + 题卡列 -->
        <template v-else>
          <!-- 按题型 / 自由排序 tab 时，左栏按题型分组 -->
          <template v-if="activeTab !== 'knowledge'">
          <section
            v-for="(group, gIdx) in sectionGroups"
            :key="gIdx"
            class="wb-section"
          >
            <!-- 大题分组头（左侧蓝条 misikt 风格）-->
            <div class="wb-section-title">
              <span class="section-label">{{ cnLabel(gIdx) }}、{{ group.title }}</span>
              <span class="section-count">（共 {{ group.rows.length }} 题）</span>
            </div>

            <!-- 题卡（PRD-A-010 T3：抽 WorkbenchCard 子组件，行为不变；
                 根节点保留 wb-q-N id 供 scrollToQuestion 定位）-->
            <WorkbenchCard
              v-for="{ row, globalIndex, editRowIndex } in group.rows"
              :key="row.id"
              :row="row"
              :global-index="globalIndex"
              :edit-row-index="editRowIndex"
              :total="editRows.length"
              @toggle-explain="toggleExplain"
              @move-up="moveUp"
              @move-down="moveDown"
              @delete="deleteRow"
              @replace="handleReplace"
              @detail="handleDetail"
            />
          </section>
          </template>

          <!-- 按知识点 tab 时，左栏按首考点分组 -->
          <template v-else>
          <section
            v-for="(group, gIdx) in knowledgeSectionGroups"
            :key="`k-${gIdx}`"
            class="wb-section"
          >
            <div class="wb-section-title">
              <span class="section-label">{{ cnLabel(gIdx) }}、{{ group.title }}</span>
              <span class="section-count">（共 {{ group.rows.length }} 题）</span>
            </div>

            <!-- 题卡（同上抽 WorkbenchCard，按知识点分组复用同一子组件）-->
            <WorkbenchCard
              v-for="{ row, globalIndex, editRowIndex } in group.rows"
              :key="row.id"
              :row="row"
              :global-index="globalIndex"
              :edit-row-index="editRowIndex"
              :total="editRows.length"
              @toggle-explain="toggleExplain"
              @move-up="moveUp"
              @move-down="moveDown"
              @delete="deleteRow"
              @replace="handleReplace"
              @detail="handleDetail"
            />
          </section>
          </template>
        </template>
      </div>

      <!-- ══ 右固定栏（sticky）══ -->
      <div class="workbench-right">
        <div class="right-panel">
          <!-- 上部可滚区：tabs + 题号块网格 + 继续挑题/清空 -->
          <div class="right-scroll-area">
          <!-- 分组 tabs（按题型 / 按知识点 / 自由排序）-->
          <el-tabs v-model="activeTab" class="right-tabs">
            <el-tab-pane label="按题型" name="type" />
            <el-tab-pane label="按知识点" name="knowledge" />
            <el-tab-pane label="自由排序" name="freesort" />
          </el-tabs>

          <!-- 题号块网格 -->
          <div class="number-grid-wrap">
            <!-- 按题型 tab（点击题号块 → 左栏滚动定位 改动③）-->
            <template v-if="activeTab === 'type'">
              <div
                v-for="ng in numberGroups"
                :key="ng.title"
                class="number-group"
              >
                <div class="number-group-title">{{ ng.title }}</div>
                <div class="number-grid">
                  <div
                    v-for="n in ng.nums"
                    :key="n"
                    class="number-cell"
                    @click="scrollToQuestion(n)"
                  >
                    {{ n }}
                  </div>
                </div>
              </div>
            </template>

            <!-- 按知识点 tab（点击题号块 → 左栏滚动定位 改动③）-->
            <template v-else-if="activeTab === 'knowledge'">
              <div
                v-for="ng in knowledgeNumberGroups"
                :key="ng.title"
                class="number-group"
              >
                <div class="number-group-title">{{ ng.title }}</div>
                <div class="number-grid">
                  <div
                    v-for="n in ng.nums"
                    :key="n"
                    class="number-cell"
                    @click="scrollToQuestion(n)"
                  >
                    {{ n }}
                  </div>
                </div>
              </div>
            </template>

            <!-- 自由排序 tab：sortablejs 拖拽网格 -->
            <!-- :key 含 freesortRenderKey → 拖后强制 remount，确保题号块按新 editRows 顺序渲染（改动④a）-->
            <template v-else>
              <div
                v-for="(group, gIdx) in freesortGroups"
                :key="group.sectionId + '-' + freesortRenderKey"
                class="number-group freesort-number-group"
              >
                <!-- 大题分组头 + ✏️ 重命名（仅编辑态且有 sectionId 时可改）-->
                <div class="number-group-title freesort-group-title">
                  <!-- 内联编辑态 -->
                  <!-- PRD-A-013 T2 — sectionId 雪花 string，新建态用 '' 空串判 -->
                  <template v-if="editingSectionId === group.sectionId && group.sectionId !== ''">
                    <el-input
                      v-model="editingSectionName"
                      class="rename-input"
                      size="small"
                      :maxlength="50"
                      @keyup.enter="commitRenameSection(group.sectionId)"
                      @keyup.esc="cancelRenameSection"
                      @blur="commitRenameSection(group.sectionId)"
                    />
                  </template>
                  <!-- 展示态 -->
                  <template v-else>
                    <span class="freesort-group-name">
                      {{ group.sectionName }}（共{{ group.items.length }}题）
                    </span>
                    <!-- ✏️ 仅编辑态可改，新建态无 sectionId -->
                    <el-tooltip
                      v-if="isEditMode && group.sectionId !== ''"
                      content="重命名大题标题"
                      placement="top"
                    >
                      <el-icon
                        class="rename-trigger"
                        @click="startRenameSection(group.sectionId)"
                      >
                        <Edit />
                      </el-icon>
                    </el-tooltip>
                  </template>
                </div>

                <!-- 可拖拽题号块容器（sortablejs 挂载点）-->
                <div
                  :ref="(el) => setFreesortContainerRef(el as HTMLElement | null, gIdx)"
                  class="number-grid freesort-grid"
                  :data-group-idx="gIdx"
                >
                  <div
                    v-for="item in group.items"
                    :key="item.id"
                    class="number-cell freesort-cell"
                    :data-edit-row-index="item.editRowIndex"
                    :title="`第 ${item.globalIndex} 题，拖拽可重新排序`"
                  >
                    {{ item.globalIndex }}
                  </div>
                </div>
              </div>

              <!-- + 添加分类（BE v1 未实现新建 section，置灰 + TODO 注释）-->
              <!-- TODO[Wave2b]: BE 支持 sectionId=null 新建 section 后取消 disabled -->
              <el-button class="add-section-btn" size="small" plain disabled>
                + 添加分类
              </el-button>
            </template>
          </div>

          <el-divider style="margin: 12px 0;" />

          <!-- 继续挑题 / 清空试题 -->
          <div class="right-action-row">
            <el-button class="continue-btn" size="small" @click="handleContinuePick">
              &lt; 继续挑题
            </el-button>
            <el-button class="clear-btn" size="small" type="danger" plain @click="handleClearBasket">
              清空试题
            </el-button>
          </div>
          </div><!-- /right-scroll-area -->

          <!-- 底部固定控制台（改动④b）-->
          <div class="right-console">
            <!-- 答题时间 -->
            <div class="right-section">
              <div class="right-section-label">答题时间</div>
              <div class="time-ctrl">
                <el-button size="small" circle @click="handleTimeDecrease">−</el-button>
                <span class="time-value">{{ suggestTime }}</span>
                <el-button size="small" circle @click="handleTimeIncrease">+</el-button>
                <span class="time-unit">分钟</span>
              </div>
            </div>

            <!-- 导出选项 -->
            <div class="right-section">
              <div class="right-section-label">导出选项</div>
              <div class="export-options">
                <el-checkbox v-model="showAnswer">包含答案</el-checkbox>
                <el-checkbox v-model="showExplain">包含解析</el-checkbox>
              </div>
            </div>

            <!-- 下载 PDF -->
            <el-button
              class="action-btn"
              @click="handleExportPdf"
              :disabled="editRows.length === 0"
            >
              下载 PDF
            </el-button>

            <!-- 保存修改 / 创建试卷 -->
            <el-button
              v-if="isEditMode"
              class="action-btn primary-btn"
              type="primary"
              :loading="saving"
              :disabled="!isOwner"
              @click="handleSave"
            >
              <el-tooltip
                v-if="!isOwner"
                content="公共试卷不可编辑"
                placement="left"
              >
                <span>保存修改</span>
              </el-tooltip>
              <span v-else>保存修改</span>
            </el-button>
            <el-button
              v-else
              class="action-btn create-btn"
              type="success"
              :loading="saving"
              :disabled="editRows.length === 0"
              @click="handleSave"
            >
              创建试卷
            </el-button>
          </div><!-- /right-console -->
        </div>
      </div>
    </div>

    <!-- PaperPreview 弹窗（下载 PDF）
         右栏 showAnswer/showExplain 作为初始勾选态传入，弹窗内仍可二次调整 -->
    <PaperPreview
      :visible="previewVisible"
      :paper-name="exportPaperName"
      :ids="exportQuestionIds"
      :initial-show-answer="showAnswer"
      :initial-show-explain="showExplain"
      @update:visible="previewVisible = $event"
    />

    <!-- PRD-B-101 备课语境·创建成功弹层（三按钮：下载 PDF / 组下一张 / 完成备课）-->
    <el-dialog
      v-model="createSuccessVisible"
      title="试卷已创建"
      width="420px"
      align-center
      :close-on-click-modal="false"
      class="prep-success-dialog"
    >
      <div class="ps-body">
        <div class="ps-icon">✓</div>
        <p class="ps-title">备课卷创建成功</p>
        <p class="ps-bound">已绑定到 <b>{{ createdBoundLabel }}</b></p>
      </div>
      <template #footer>
        <div class="ps-actions">
          <el-button @click="onPrepDownloadPdf">下载 PDF</el-button>
          <el-button v-if="prepCtx.hasNextEmptySlot" type="primary" plain @click="onPrepComposeNext">
            组下一张
          </el-button>
          <el-button type="success" @click="onPrepComplete">完成备课</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 换一题检索弹窗（PRD-A-007 Wave4 改动②）-->
    <ReplaceQuestionDialog
      v-if="replaceTargetRow"
      v-model:visible="replaceDialogVisible"
      :question="replaceTargetRow"
      :exclude-ids="paperQuestionIds"
      @select="onReplaceSelect"
    />
  </div>
</template>

<style scoped>
/* ── 整页布局 ── */
.workbench-page {
  min-height: 100vh;
  background: #f0f2f5;
  display: flex;
  flex-direction: column;
}

/* ── 顶部导航栏 ── */
.workbench-topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 24px;
  background: #fff;
  border-bottom: 1px solid #f2f3f5;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
  position: sticky;
  top: 0;
  z-index: 100;
}

.back-btn {
  color: #4e5969;
  font-size: 14px;
  gap: 4px;
  flex-shrink: 0;
}

.back-btn:hover {
  color: #1E8A8A;
}

.title-input {
  flex: 1;
  max-width: 500px;
}

.title-input :deep(.el-input__inner) {
  font-size: 16px;
  font-weight: 600;
}

.topbar-stat {
  display: flex;
  align-items: baseline;
  gap: 3px;
  background: #f8f9ff;
  border: 1px solid #e8f0ff;
  border-radius: 8px;
  padding: 6px 14px;
  flex-shrink: 0;
  margin-left: auto;
}

.stat-num {
  font-size: 18px;
  font-weight: 700;
  color: #1d2129;
}

.stat-num.total {
  color: #1E8A8A;
}

.stat-unit {
  font-size: 12px;
  color: #86909c;
}

.stat-sep {
  margin: 0 6px;
  color: #c9cdd4;
}

/* ── 两栏主体 ── */
.workbench-body {
  display: flex;
  gap: 0;
  flex: 1;
  align-items: flex-start;
}

/* ── 左主栏 ── */
.workbench-left {
  flex: 1;
  min-width: 0;
  padding: 16px 20px;
}

.wb-loading,
.wb-empty {
  display: flex;
  justify-content: center;
  padding: 40px 0;
}

/* ── 大题分组 ── */
.wb-section {
  margin-bottom: 18px;
}

.wb-section-title {
  font-size: 15px;
  font-weight: 700;
  color: #1d2129;
  margin: 0 0 10px;
  padding: 10px 14px;
  background: #fff;
  border-left: 4px solid #1E8A8A;
  border-radius: 4px;
  border: 1px solid #f2f3f5;
  border-left-width: 4px;
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.section-label {
  font-weight: 700;
}

.section-count {
  font-size: 12px;
  font-weight: 400;
  color: #86909c;
}

/* ── 题目卡片（复用 source.vue .source-question-card 骨架）── */
.source-question-card {
  background: #fff;
  border-radius: 10px;
  border: 1px solid #f2f3f5;
  padding: 16px 20px;
  margin-bottom: 10px;
  transition: all 0.2s;
}

.source-question-card:hover {
  box-shadow: 0 4px 16px rgba(30, 138, 138, 0.1);
  border-color: #d0e2ff;
}

/* workbench-card 特有：底部工具栏需要更多 padding 空间 */
.workbench-card {
  padding-bottom: 0;
}

/* ── 顶部 meta 行 ── */
.q-meta-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  gap: 8px;
  flex-wrap: wrap;
  padding-bottom: 10px;
  border-bottom: 1px solid #f7f8fa;
}

.q-meta-top-left {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  flex: 1;
  min-width: 0;
}

.meta-label {
  font-size: 12px;
  color: #86909c;
  font-weight: 500;
}

.meta-rate {
  height: 18px;
}

:deep(.meta-rate .el-rate__item) {
  font-size: 15px;
}

.primary-knowledge-tag {
  font-size: 12px;
}

.source-text {
  font-size: 12px;
  color: #86909c;
}

/* 全卷连续序号圆圈 */
.q-global-num {
  width: 28px;
  height: 28px;
  background: linear-gradient(135deg, #1E8A8A, #176E6E);
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

/* 题型标签 */
.q-type-tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
}

.q-type--primary {
  background: #e8f0ff;
  color: #3564d0;
}

.q-type--success {
  background: #e8fff0;
  color: #0d7a4a;
}

.q-type--warning {
  background: #fff7e6;
  color: #b45309;
}

.q-type--info {
  background: #f0f0f0;
  color: #6b7280;
}

.q-type--danger {
  background: #fff0f0;
  color: #d32f2f;
}

/* ── 题干区 ── */
.q-stem-area {
  min-height: 60px;
  margin-bottom: 10px;
}

.q-stem-img {
  max-width: 100%;
  height: auto;
  display: block;
}

.q-stem-text {
  font-size: 14px;
  line-height: 1.7;
  color: #1d2129;
  margin: 0;
  white-space: pre-wrap;
}

.q-stem-placeholder {
  font-size: 13px;
  color: #c9cdd4;
  margin: 0;
}

/* ── 解析区 ── */
.q-explain-area {
  background: #f8fffe;
  border-left: 3px solid #34c38f;
  border-radius: 0 6px 6px 0;
  padding: 10px 14px;
  margin-bottom: 10px;
}

.explain-label {
  font-size: 12px;
  font-weight: 600;
  color: #0d7a4a;
  margin-bottom: 6px;
}

.q-explain-img {
  max-width: 100%;
  height: auto;
  display: block;
}

/* ── 底部工具栏（misikt 风格）── */
/* 改动①：默认隐藏，悬停题卡才显示，保留占位不跳高 */
.q-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 10px 0 12px;
  border-top: 1px solid #f7f8fa;
  flex-wrap: wrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s;
}

.workbench-card:hover .q-toolbar {
  opacity: 1;
  pointer-events: auto;
}

/* 改动③：题卡闪烁高亮（点击题号块定位时）*/
.wb-card-flash {
  animation: wbFlash 1.2s;
}

@keyframes wbFlash {
  0%, 100% { box-shadow: none; }
  30% { box-shadow: 0 0 0 3px #1E8A8A55; }
}

.toolbar-score {
  display: flex;
  align-items: center;
  gap: 6px;
}

.toolbar-label {
  font-size: 12px;
  color: #86909c;
}

.toolbar-divider {
  width: 1px;
  height: 16px;
  background: #e4e7ed;
  margin: 0 4px;
  flex-shrink: 0;
}

.toolbar-btn {
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 0 6px;
  height: 28px;
  color: #4e5969;
}

.toolbar-btn:hover {
  color: #1E8A8A;
}

/* ── 右固定栏（改动④b）── */
.workbench-right {
  width: 300px;
  flex-shrink: 0;
  position: sticky;
  top: 57px; /* 工作台 topbar 高度 */
  /* 滚动容器是 .el-main.app-main（顶部在视口 y=60，上面有 60px 全局 header），
     不是 window。可用高度 = 100vh - 60(全局header) - 57(工作台topbar sticky 偏移)。
     用 57px 会导致 rail 底超出滚动视口 60px → 控制台底部「保存」被切。改 117px 后控制台始终全可见且吸顶固定。*/
  height: calc(100vh - 117px);
  max-height: calc(100vh - 117px);
  /* 不再自身 overflow-y:auto，交给内部两区管理 */
  padding: 12px 12px 12px 0;
  display: flex;
  flex-direction: column;
}

/* right-panel 占满 sticky 高度，内部 flex 拆两区 */
.right-panel {
  background: #fff;
  border-radius: 10px;
  border: 1px solid #f2f3f5;
  padding: 0;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* 上部可滚区（tabs + 题号网格 + 继续挑题/清空）*/
.right-scroll-area {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px 8px;
}

/* 底部固定控制台（答题时间 + 导出 + PDF + 保存）*/
.right-console {
  flex-shrink: 0;
  border-top: 1px solid #f0f2f5;
  padding: 12px 16px 14px;
  box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.04);
}

/* tabs */
.right-tabs {
  margin-bottom: 0;
}

:deep(.right-tabs .el-tabs__header) {
  margin-bottom: 10px;
}

:deep(.right-tabs .el-tabs__item) {
  font-size: 13px;
  padding: 0 10px;
}

/* 题号分组 */
.number-grid-wrap {
  min-height: 80px;
}

.number-group {
  margin-bottom: 12px;
}

.number-group-title {
  font-size: 12px;
  font-weight: 600;
  color: #4e5969;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 4px;
}

/* ── 自由排序 tab 特有样式 ── */
.freesort-number-group {
  /* 保持 number-group 间距一致 */
}

.freesort-group-title {
  min-height: 24px;
}

.freesort-group-name {
  flex: 1;
  font-size: 12px;
  font-weight: 600;
  color: #4e5969;
}

/* ✏️ 重命名触发图标 */
.rename-trigger {
  font-size: 13px;
  color: #86909c;
  cursor: pointer;
  padding: 2px;
  border-radius: 3px;
  transition: color 0.15s, background 0.15s;
  flex-shrink: 0;
}

.rename-trigger:hover {
  color: #1E8A8A;
  background: #f0f5ff;
}

/* 内联重命名输入框 */
.rename-input {
  flex: 1;
}

:deep(.rename-input .el-input__wrapper) {
  padding: 2px 6px;
  font-size: 12px;
  font-weight: 600;
}

/* 拖拽网格容器 */
.freesort-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 38px; /* 空组可拖入 */
  padding: 4px;
  border-radius: 6px;
  transition: background 0.15s;
}

.freesort-grid:empty::after {
  content: '拖拽题目到此处';
  font-size: 11px;
  color: #c9cdd4;
  padding: 6px;
}

.number-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.number-cell {
  width: 32px;
  height: 32px;
  border-radius: 6px;
  border: 1px solid #1E8A8A;
  color: #1E8A8A;
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s;
  background: #f0f5ff;
  user-select: none;
}

.number-cell:hover {
  background: #1E8A8A;
  color: #fff;
}

/* 自由排序格：可拖，hover 提示 */
.freesort-cell {
  cursor: grab;
}

.freesort-cell:active {
  cursor: grabbing;
}

/* sortablejs 拖拽中状态 */
.freesort-ghost {
  opacity: 0.4;
  background: #e8f0ff !important;
  border-color: #1E8A8A !important;
  border-style: dashed !important;
}

.freesort-chosen {
  background: #1E8A8A !important;
  color: #fff !important;
  box-shadow: 0 2px 8px rgba(30, 138, 138, 0.4);
}

.freesort-drag {
  opacity: 0.9;
  box-shadow: 0 4px 12px rgba(30, 138, 138, 0.3);
}

.add-section-btn {
  width: 100%;
  margin-top: 8px;
  font-size: 12px;
}

/* 操作行 */
.right-action-row {
  display: flex;
  gap: 8px;
}

.continue-btn,
.clear-btn {
  flex: 1;
  font-size: 12px;
}

/* 右栏 section */
.right-section {
  margin-bottom: 14px;
}

.right-section-label {
  font-size: 12px;
  color: #86909c;
  margin-bottom: 8px;
  font-weight: 500;
}

/* 答题时间控制 */
.time-ctrl {
  display: flex;
  align-items: center;
  gap: 10px;
}

.time-value {
  font-size: 20px;
  font-weight: 700;
  color: #1d2129;
  min-width: 48px;
  text-align: center;
}

.time-unit {
  font-size: 13px;
  color: #86909c;
}

/* 导出选项 */
.export-options {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 动作按钮 */
.action-btn {
  width: 100%;
  margin-bottom: 8px;
  font-size: 14px;
}

/* 竖向堆叠的全宽按钮：清掉 EP 对相邻 el-button 注入的 margin-left:12px，
   否则下面的按钮被右推 12px，与上面的左边对不齐（scoped 选择器带 [data-v] 提权，盖过 EP）。 */
.action-btn + .action-btn {
  margin-left: 0;
}

.primary-btn {
  background: #1E8A8A;
  border-color: #1E8A8A;
}

.create-btn {
  background: #34c38f;
  border-color: #34c38f;
}

/* ── 备课语境·创建成功弹层（PRD-B-101 V3）── */
.ps-body {
  text-align: center;
  padding: 6px 0 2px;
}
.ps-icon {
  width: 52px;
  height: 52px;
  margin: 0 auto 12px;
  border-radius: 50%;
  background: #e8fff0;
  color: #0d7a4a;
  font-size: 28px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ps-title {
  font-size: 16px;
  font-weight: 700;
  color: #1d2129;
  margin: 0 0 6px;
}
.ps-bound {
  font-size: 13px;
  color: #4e5969;
  margin: 0;
}
.ps-bound b {
  color: #0f766e;
}
.ps-actions {
  display: flex;
  gap: 10px;
  justify-content: center;
}
.ps-actions .el-button {
  flex: 1;
  margin-left: 0;
}
</style>
