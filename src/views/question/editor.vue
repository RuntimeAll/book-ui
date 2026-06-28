<script setup lang="ts">
/**
 * PRD-A-015 批3 — 单题网格编辑器（新建态 + 编辑态同页，仿 papers/workbench.vue 双态范式）
 *
 * 入口：
 *   新建态 /question/editor        → doc 从 emptyDoc() 起，动作"创建题目"
 *   编辑态 /question/editor/:id    → 加载 getQuestionDetail，parseBlockDoc 还原 doc，动作"保存修改"
 *
 * 数据模型 = ref<QuestionBlockDoc>（§10.1 锁定结构：{ v, rows:[ { cells:[ <block> ] } ] }）。
 *   - 整题一份版本化 JSON；block 三型 text / image / option。
 *   - 选项 N 列 = 一行(row)放 N 个 option 块；图片/文字位置 = 其在 rows/cells 次序。
 *
 * 实时预览 = <QuestionBlockRender :doc="doc"/>（三端一致：编辑器预览=卷库/详情/PDF 同一渲染组件）。
 * 拖拽 = sortablejs（行间重排 + 行内 cell 重排），换行/换列即满足 AC1。
 * 保存前 validateBlockDoc(doc) 校验；createQuestion / updateQuestion 入库（blockJson 为权威源）。
 */
import { ref, computed, onMounted, nextTick, watch, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowLeft, Plus, Delete, Picture, List, Document } from '@element-plus/icons-vue'
import Sortable from 'sortablejs'
import {
  createQuestion,
  updateBlock,
  getQuestionDetail,
  type QuestionDetail,
} from '@/api/question/index'
import { uploadMotherImage } from '@/api/variant/index'
import QuestionBlockRender from '@/components/business/QuestionBlockRender/index.vue'
import RichTextBlock from '@/components/business/RichTextBlock/index.vue'
import ChapterPicker from '@/components/business/ChapterPicker/index.vue'
import type { FreeTagVo } from '@/api/question/index'
import {
  emptyDoc,
  parseBlockDoc,
  validateBlockDoc,
  type QuestionBlockDoc,
  type Block,
  type TextBlock,
  type ImageBlock,
  type OptionBlock,
  type ImageAlign,
} from '@/utils/blockSchema'
import { useUserStore } from '@/store/user'
import { getCurrentUser } from '@/api/user'

// ── 路由 / 双态 ──────────────────────────────────────────────────────────────
const route = useRoute()
const router = useRouter()
const questionId = computed(() => route.params.id as string | undefined)
const isEditMode = computed(() => !!questionId.value)

// ── 用户 / owner 判定 ────────────────────────────────────────────────────────
const userStore = useUserStore()
// 编辑态加载到的题 createUser ≠ 当前登录 id → 公共题/他人题，FE 锁保存（硬保护在 BE update）。
const detailOwnerId = ref<string | null>(null)
// 可保存 = 新建态 / 本人题 / superadmin（角色，对齐 BE LoginHelper.isSuperAdmin）。
// teacher 仅本人题；BE update 硬校验兜底，FE 这里只是体验闸（拿不到判定信息时不锁死）。
const isOwner = computed(() => {
  if (!isEditMode.value) return true // 新建态 = 自己创建
  if (userStore.isSuperAdmin) return true // 超管可编辑任意题
  const uid = userStore.userInfo?.id
  if (uid == null || detailOwnerId.value == null) return true // 拿不到判定信息时不锁死（BE 兜底）
  return String(detailOwnerId.value) === String(uid)
})

// ── 排版精简模式（PRD-A-022 批3 R-B，D6+D7）─────────────────────────────────────
// 对「举一反三 AI 生成的题」编辑态走「排版精简模式」：题面内容只读、隐藏新增块/富文本/选项内容编辑，
// 只留排版调整（行列布局 / 图片宽度对齐 / 文字字号 / 预览 / 保存）。
// 🔴 判据（D7 作用域）= 题数据自带 import_source === '举一反三'（最可靠，任何入口进来都对，不依赖路由传参）。
//   route query ?layout=1 / ?from=variant 作为兜底叠加（任一命中即精简），但当前跳转入口（variant 手动排版）
//   不传参，故主判据是 importSource。母题(原题图)与变式(数值变式)在库里 import_source 同为「举一反三」，皆命中。
const AI_VARIANT_IMPORT_SOURCE = '举一反三'
const detailImportSource = ref<string | null>(null)
const layoutOnlyMode = computed(() => {
  if (!isEditMode.value) return false // 新建态永远全功能
  if (detailImportSource.value === AI_VARIANT_IMPORT_SOURCE) return true
  // 兜底：route query 显式声明（?layout=1 或 ?from=variant），当前入口未用，留作扩展
  const q = route.query
  if (q.layout === '1' || q.from === 'variant') return true
  return false
})

// ── 题目元信息 ────────────────────────────────────────────────────────────────
// 题型全集（对齐 QuestionCard/workbench 权威映射，含库里在用的 2 判断 / 3 应用，
// 否则旧题 type=3 在 el-select 里裸显数字码 "3"）。
const QUESTION_TYPES = [
  { label: '选择题', value: 1 },
  { label: '判断题', value: 2 },
  { label: '应用题', value: 3 },
  { label: '填空题', value: 4 },
  { label: '简答题', value: 5 },
]
const questionType = ref<number>(1)
// subjectId（学科/章节）必填。用可复用 ChapterPicker（biz_subject 整树选择，显示节点名）。
// 🔴 历史题 78% 的 subject_id 是 misikt 旧路径码（不在新章节树里），ChapterPicker 会降级
//    展示「原始码·未匹配」；编辑时选一个真实章节节点保存即修正该题归类。
const subjectId = ref<string>('')
const difficult = ref<number>(0) // 0 = 未设；1-4 星
// 自由标签（只读展示，编辑态从 detail.freeTags 回填；标签增删走专门的标签管理，本页只呈现）
const freeTags = ref<FreeTagVo[]>([])

// ── 来源（只读展示，编辑态从 detail 回填；不进 save 提交）──────────────────────
// BE QuestionDetailVo 已回填 examYear / examPaperName / regionCode / sourceType
// （QuestionServiceImpl.selectById L215-223）。约 63% 题填充，空字段不显示。
const examYear = ref<string>('')
const examPaperName = ref<string>('')
const regionCode = ref<string>('')
const sourceType = ref<number>(0) // 0 = 未设；1中考真题/2模拟/3期末/4月考/5单元/6自编/9其他
const SOURCE_TYPE_LABELS: Record<number, string> = {
  1: '中考真题',
  2: '模拟',
  3: '期末',
  4: '月考',
  5: '单元',
  6: '自编',
  9: '其他',
}
const sourceTypeLabel = computed(() => SOURCE_TYPE_LABELS[sourceType.value] ?? '')
// 整块是否有任意来源字段（全空则整行隐藏）
const hasSource = computed(
  () => !!sourceTypeLabel.value || !!examYear.value || !!regionCode.value || !!examPaperName.value,
)

// ── 核心数据模型：整题 block 文档 ────────────────────────────────────────────
const doc = ref<QuestionBlockDoc>(emptyDoc())
const loading = ref(false)
const saving = ref(false)

// ── 编辑态加载 ────────────────────────────────────────────────────────────────
async function loadDetail() {
  if (!questionId.value) return
  loading.value = true
  try {
    const detail: QuestionDetail = await getQuestionDetail(questionId.value)
    // owner 判定（createUser 是创建人雪花 id；公共题多为导入孤儿 id）
    detailOwnerId.value = detail?.createUser != null ? String(detail.createUser) : null
    // 排版精简模式判据来源（举一反三 AI 题 → 精简编辑）
    detailImportSource.value = detail?.importSource != null ? String(detail.importSource) : null
    // 元信息回填
    if (detail?.questionType != null) questionType.value = Number(detail.questionType)
    if (detail?.difficult != null) difficult.value = Number(detail.difficult)
    if (detail?.subjectId != null) subjectId.value = String(detail.subjectId)
    freeTags.value = Array.isArray(detail?.freeTags) ? detail.freeTags : []
    // 来源只读回填（空字段保持空 ref，模板 v-if 控制不显示）
    examYear.value = detail?.examYear != null ? String(detail.examYear) : ''
    examPaperName.value = detail?.examPaperName != null ? String(detail.examPaperName) : ''
    regionCode.value = detail?.regionCode != null ? String(detail.regionCode) : ''
    sourceType.value = detail?.sourceType != null ? Number(detail.sourceType) : 0
    // block 文档无损还原（G2 FE 侧）：parseBlockDoc 接受 JSON 字符串
    const parsed = parseBlockDoc(detail?.blockJson)
    if (parsed && parsed.rows.length > 0) {
      doc.value = parsed
    } else {
      // 该题未结构化（旧题/无 blockJson）→ 给个空文档 + 提示
      doc.value = emptyDoc()
      ElMessage.info('该题暂无结构化内容，可在此重新排版后保存')
    }
  } catch (e) {
    console.warn('[question-editor] loadDetail failed', e)
    ElMessage.warning('题目加载失败（接口需登录态）')
  } finally {
    loading.value = false
  }
}

// ── 块增删（工具栏）──────────────────────────────────────────────────────────
function addTextBlock() {
  const block: TextBlock = { type: 'text', md: '' }
  doc.value.rows.push({ cells: [block] })
}

function addImageBlock() {
  // PRD-A-018：新增图片块默认宽度 40%（与入库默认 variant_support.DEFAULT_IMAGE_WIDTH_PCT 对齐），
  // 默认即「可看不过大」，老师按需再微调。
  const block: ImageBlock = { type: 'image', url: '', width: 40, align: 'center' }
  doc.value.rows.push({ cells: [block] })
}

// 选项组：选 1/2/4 列，生成一行含 N 个 option 块（无 3 列）。
const optionColCount = ref<1 | 2 | 4>(2)
function addOptionGroup() {
  const n = optionColCount.value
  const cells: Block[] = []
  for (let i = 0; i < n; i++) {
    const label = String.fromCharCode(65 + i) // A B C D...
    const opt: OptionBlock = {
      type: 'option',
      label,
      content: [{ type: 'text', md: '' } as TextBlock],
    }
    cells.push(opt)
  }
  doc.value.rows.push({ cells })
}

function removeRow(ri: number) {
  doc.value.rows.splice(ri, 1)
}

function removeCell(ri: number, ci: number) {
  const row = doc.value.rows[ri]
  if (!row) return
  row.cells.splice(ci, 1)
  // 行内无 cell 了，整行删
  if (row.cells.length === 0) doc.value.rows.splice(ri, 1)
}

// ── 选项组列数/换行快改（用户要的「快速格式化」）──────────────────────────────
// 模型：一「选项组」= 连续若干「全是 option 块」的行。切列数 = 把组内所有选项重新按 N/行 排版；
//      增/删选项 = 追加/去尾后按当前列数重排；任何变动都重排标号 A/B/C/D…（按顺序）。
function isOptionRow(row: { cells: Block[] } | undefined): boolean {
  return !!row && row.cells.length > 0 && row.cells.every((c) => c.type === 'option')
}
/** 该行是否为某选项组的首行（上一行不是 option 行）→ 只在首行挂组控件，避免重复 */
function isGroupStart(ri: number): boolean {
  if (!isOptionRow(doc.value.rows[ri])) return false
  return ri === 0 || !isOptionRow(doc.value.rows[ri - 1])
}
/** 返回包含 ri 的连续 option 行组 [start, end] */
function optionGroupRange(ri: number): [number, number] {
  const rows = doc.value.rows
  let s = ri
  while (s > 0 && isOptionRow(rows[s - 1])) s--
  let e = ri
  while (e + 1 < rows.length && isOptionRow(rows[e + 1])) e++
  return [s, e]
}
function collectGroupOptions(s: number, e: number): OptionBlock[] {
  const out: OptionBlock[] = []
  for (let i = s; i <= e; i++) {
    for (const c of doc.value.rows[i].cells) out.push(c as OptionBlock)
  }
  return out
}
/** 顺序重排标号 A/B/C/D… */
function relabelOptions(opts: OptionBlock[]) {
  opts.forEach((o, i) => { o.label = String.fromCharCode(65 + i) })
}
function chunkRows(opts: OptionBlock[], cols: number): { cells: Block[] }[] {
  const c = Math.max(1, cols)
  const rows: { cells: Block[] }[] = []
  for (let i = 0; i < opts.length; i += c) rows.push({ cells: opts.slice(i, i + c) as Block[] })
  return rows
}
/** 当前组的列数（= 首行 cell 数） */
function groupCols(ri: number): number {
  const [s] = optionGroupRange(ri)
  return doc.value.rows[s]?.cells.length ?? 1
}
function groupSize(ri: number): number {
  const [s, e] = optionGroupRange(ri)
  return collectGroupOptions(s, e).length
}
function applyGroup(s: number, e: number, opts: OptionBlock[], cols: number) {
  relabelOptions(opts)
  doc.value.rows.splice(s, e - s + 1, ...chunkRows(opts, cols))
  nextTick(() => initSortable())
}
/** 切列数：把整组选项重排成 cols/行 */
function reflowGroup(ri: number, cols: number) {
  const [s, e] = optionGroupRange(ri)
  applyGroup(s, e, collectGroupOptions(s, e), cols)
}
function addGroupOption(ri: number) {
  const [s, e] = optionGroupRange(ri)
  const opts = collectGroupOptions(s, e)
  opts.push({ type: 'option', label: '', content: [{ type: 'text', md: '' } as TextBlock] })
  applyGroup(s, e, opts, doc.value.rows[s].cells.length)
}
function removeGroupOption(ri: number) {
  const [s, e] = optionGroupRange(ri)
  const opts = collectGroupOptions(s, e)
  if (opts.length <= 1) return // 至少留一个选项
  opts.pop()
  applyGroup(s, e, opts, doc.value.rows[s].cells.length)
}

// ── 排版精简模式：整块字号（D6 保留「字号」= 排版）────────────────────────────
// RichTextBlock 的字号是「选区级」（包裹选中文字 ⟦s:px⟧…⟦/s⟧），但精简态没有可编辑 textarea/选区，
// 故这里改成「整块级」字号 = 把整块 md 外层包一层 ⟦s:px⟧…⟦/s⟧（与渲染端 richtext.ts 同一标记，渲染一致）。
// 读：剥掉最外层 ⟦s:px⟧…⟦/s⟧ 还原 px（无包裹 = 默认空）；写：先剥旧外层再包新值（同 applyTyped 替换语义）。
const BLOCK_SIZE_OPTIONS = [
  { label: '默认', value: 0 },
  { label: '小', value: 14 },
  { label: '中', value: 18 },
  { label: '大', value: 24 },
]
// 整块外层字号标记正则：^⟦s:NN⟧ … ⟦/s⟧$（仅当整块被单层 size 包裹时视为块级字号）
const BLOCK_SIZE_RE = /^⟦s:(\d{1,3})⟧([\s\S]*)⟦\/s⟧$/
function getBlockSize(block: TextBlock): number {
  const m = (block.md ?? '').match(BLOCK_SIZE_RE)
  return m ? Number(m[1]) : 0
}
function setBlockSize(block: TextBlock, px: number) {
  const cur = block.md ?? ''
  const m = cur.match(BLOCK_SIZE_RE)
  const inner = m ? m[2] : cur // 已有块级包裹 → 取内层；否则整块为内层
  block.md = px > 0 ? `⟦s:${px}⟧${inner}⟦/s⟧` : inner
}

// ── option 块内子内容增删 ─────────────────────────────────────────────────────
function addOptionText(opt: OptionBlock) {
  opt.content.push({ type: 'text', md: '' } as TextBlock)
}
function addOptionImage(opt: OptionBlock) {
  // PRD-A-018：选项内图片默认宽度同样 40%（与上 addImageBlock / 入库默认对齐）。
  opt.content.push({ type: 'image', url: '', width: 40, align: 'center' } as ImageBlock)
}
function removeOptionContent(opt: OptionBlock, idx: number) {
  opt.content.splice(idx, 1)
  if (opt.content.length === 0) {
    // option 至少留一个文字块（schema 不强制但避免空 option）
    opt.content.push({ type: 'text', md: '' } as TextBlock)
  }
}

// ── 图片上传（复用 /teacher/variant/upload-image 通用 OSS 上传，返回公网 URL）──
async function handleUpload(file: File, target: ImageBlock) {
  try {
    const res = await uploadMotherImage(file)
    if (res?.url) {
      target.url = res.url
      ElMessage.success('图片上传成功')
    } else {
      ElMessage.warning('上传未返回 URL')
    }
  } catch (e) {
    console.warn('[question-editor] upload failed', e)
    ElMessage.error('图片上传失败，可手动粘贴 OSS 链接')
  }
}
// el-upload http-request 钩子包装（拿到原始 File）
function makeUploadRequest(target: ImageBlock) {
  return (options: { file: File }) => handleUpload(options.file, target)
}

// 类型守卫（模板内窄化）
function asImage(b: Block): ImageBlock {
  return b as ImageBlock
}
function asOption(b: Block): OptionBlock {
  return b as OptionBlock
}

const ALIGN_OPTIONS: { label: string; value: ImageAlign }[] = [
  { label: '左', value: 'left' },
  { label: '中', value: 'center' },
  { label: '右', value: 'right' },
]

// ── 拖拽：行间重排（rows）+ 行内 cell 重排 ────────────────────────────────────
// 务实实现：rows 列表挂一个 Sortable；每个 row 内 cells 挂各自 Sortable（同 group 允许行间换列）。
// 拖拽后从 DOM data-index 重建 doc.rows（与 workbench freesort 同思路），再 remount 重绑。
const rowsContainerRef = ref<HTMLElement | null>(null)
const renderKey = ref(0)
let sortableInstances: Sortable[] = []

// 稳定 key：行/块对象 → 自增 key（WeakMap）。避免 splice 后 Vue 按 index 错误复用
// RichTextBlock/el-input 组件致状态错乱（PRD-A-015 选项增删「加挂」根因之一）。
let keySeq = 0
const keyMap = new WeakMap<object, number>()
function keyOf(o: object): number {
  let k = keyMap.get(o)
  if (k == null) {
    k = ++keySeq
    keyMap.set(o, k)
  }
  return k
}

function destroySortable() {
  sortableInstances.forEach((s) => s.destroy())
  sortableInstances = []
}

// 重入合并：initSortable 会被多处（onEnd / rows.length watch / applyGroup）在同一 tick 内
// 连环触发。原实现「同步 destroy + nextTick push」在一 tick 多次调用时会先 destroy 两遍、
// 再 push 两套 Sortable 到同一 DOM → 重复绑定（拖一次触发两遍 onEnd）+ 旧实例泄漏。
// 用 pending 标志把同 tick 的多次调用合并成「destroy 一次 + 仅最后一次真正重建」。
let sortablePending = false

function rebuildFromDom() {
  const rowEls = Array.from(
    rowsContainerRef.value?.querySelectorAll<HTMLElement>(':scope > .editor-row') ?? [],
  )
  const oldRows = doc.value.rows
  const newRows = rowEls.map((rowEl) => {
    const cellEls = Array.from(
      rowEl.querySelectorAll<HTMLElement>('.editor-cell[data-cell-key]'),
    )
    const cells: Block[] = cellEls
      .map((cellEl) => {
        const [rStr, cStr] = (cellEl.getAttribute('data-cell-key') || '').split(':')
        return oldRows[Number(rStr)]?.cells[Number(cStr)]
      })
      .filter(Boolean) as Block[]
    return { cells }
  })
  // 丢掉空行
  doc.value.rows = newRows.filter((r) => r.cells.length > 0)
}

function initSortable() {
  // 同 tick 内多次调用只重建一次（防重复绑定 + 旧实例泄漏，见 sortablePending 注释）。
  if (sortablePending) return
  sortablePending = true
  destroySortable()
  nextTick(() => {
    sortablePending = false
    // 组件已卸载（nextTick 期间 unmount）则不再绑定
    if (!rowsContainerRef.value) return
    // nextTick 真正重建前再清一次：合并窗口内若已有同步 destroy 漏网，确保零残留
    destroySortable()
    // 行间拖拽
    if (rowsContainerRef.value) {
      sortableInstances.push(
        Sortable.create(rowsContainerRef.value, {
          group: 'editor-rows',
          handle: '.row-drag-handle',
          animation: 150,
          ghostClass: 'editor-ghost',
          onEnd() {
            rebuildFromDom()
            renderKey.value++
            nextTick(() => initSortable())
          },
        }),
      )
    }
    // 行内 cell 拖拽：实时查 DOM 拿各行 .cells-container（不依赖会残留废节点的 ref 数组）
    const cellEls = Array.from(
      rowsContainerRef.value?.querySelectorAll<HTMLElement>(':scope > .editor-row > .cells-container') ?? [],
    )
    cellEls.forEach((el) => {
      sortableInstances.push(
        Sortable.create(el, {
          group: 'editor-cells',
          handle: '.cell-drag-handle',
          animation: 150,
          ghostClass: 'editor-ghost',
          onEnd() {
            rebuildFromDom()
            renderKey.value++
            nextTick(() => initSortable())
          },
        }),
      )
    })
  })
}

// rows 数量变化（增删块）后重绑 sortable
watch(
  () => doc.value.rows.length,
  () => nextTick(() => initSortable()),
)

onBeforeUnmount(() => destroySortable())

// ── 拼 stem 纯文本（供 BE create 必填 + 列表/搜索回落）─────────────────────────
// 各 text 块 md（含 option 内 text）简单 join；保留原文（含 $...$），不做激进去 LaTeX。
function buildStem(): string {
  const parts: string[] = []
  doc.value.rows.forEach((row) => {
    row.cells.forEach((cell) => {
      if (cell.type === 'text' && cell.md.trim()) {
        parts.push(cell.md.trim())
      } else if (cell.type === 'option') {
        const inner = cell.content
          .filter((c): c is TextBlock => c.type === 'text' && !!c.md.trim())
          .map((c) => c.md.trim())
          .join(' ')
        parts.push(`${cell.label}. ${inner}`.trim())
      }
    })
  })
  return parts.join('\n').slice(0, 2000) // 防超长
}

// ── 保存 ──────────────────────────────────────────────────────────────────────
async function handleSave() {
  // owner 保护（FE 侧，编辑态非本人不放行）
  if (isEditMode.value && !isOwner.value) {
    ElMessage.warning('公共题/他人题不可编辑')
    return
  }
  // 元信息校验
  if (!subjectId.value.trim()) {
    ElMessage.warning('请填写学科/章节（subjectId）')
    return
  }
  // 结构校验
  const errs = validateBlockDoc(doc.value)
  if (errs.length > 0) {
    ElMessage.error(`内容校验未通过：${errs[0]}`)
    return
  }
  if (doc.value.rows.length === 0) {
    ElMessage.warning('请至少添加一个内容块')
    return
  }

  const stem = buildStem()
  if (!stem.trim()) {
    ElMessage.warning('题目内容为空，请至少输入一段文字')
    return
  }
  const blockJson = JSON.stringify(doc.value)

  saving.value = true
  try {
    if (isEditMode.value) {
      const res = await updateBlock({
        questionId: questionId.value!,
        blockJson,
        questionType: questionType.value,
        difficult: difficult.value || undefined,
        subjectId: subjectId.value.trim(),
        stem,
      })
      ElMessage.success('保存成功')
      // 回详情页
      const rid = (res && (res as QuestionDetail).id) ? String((res as QuestionDetail).id) : questionId.value
      router.push(`/question/detail/${rid}`)
    } else {
      const res = await createQuestion({
        questionType: questionType.value,
        stem,
        subjectId: subjectId.value.trim(),
        difficult: difficult.value || undefined,
        blockJson,
      })
      ElMessage.success('创建成功')
      const newId = res && (res as QuestionDetail).id ? String((res as QuestionDetail).id) : ''
      if (newId) {
        router.push(`/question/detail/${newId}`)
      } else {
        router.push('/my-question')
      }
    }
  } catch (e: unknown) {
    const msg = (e as { message?: string })?.message || '操作失败，请稍后重试'
    ElMessage.error(`保存失败：${msg}`)
    console.warn('[question-editor] save failed', e)
  } finally {
    saving.value = false
  }
}

function goBack() {
  router.back()
}

// ── 初始化 ───────────────────────────────────────────────────────────────────
onMounted(async () => {
  if (!userStore.userInfo) {
    try {
      const info = await getCurrentUser()
      if (info) userStore.setUserInfo(info)
    } catch (e) {
      console.warn('[question-editor] getCurrentUser 兜底失败', e)
    }
  }
  if (isEditMode.value) {
    await loadDetail()
  }
  nextTick(() => initSortable())
})

// SPA 内路由 id 变化时重新加载
watch(questionId, async (newId) => {
  if (newId) {
    await loadDetail()
  } else {
    doc.value = emptyDoc()
    detailOwnerId.value = null
    detailImportSource.value = null
  }
  nextTick(() => initSortable())
})
</script>

<template>
  <div class="editor-page">
    <!-- 顶部栏 -->
    <div class="editor-topbar">
      <el-button link class="back-btn" @click="goBack">
        <el-icon><ArrowLeft /></el-icon>
        <span>返回</span>
      </el-button>
      <span class="topbar-title">{{ isEditMode ? '编辑题目' : '新建题目' }}</span>
      <div class="topbar-spacer" />
      <el-button
        type="primary"
        class="save-btn"
        :loading="saving"
        :disabled="isEditMode && !isOwner"
        @click="handleSave"
      >
        {{ isEditMode ? '保存修改' : '创建题目' }}
      </el-button>
    </div>

    <!-- 非本人题提示条 -->
    <el-alert
      v-if="isEditMode && !isOwner"
      type="warning"
      :closable="false"
      title="该题为公共题/他人题，不可编辑（保存已禁用）"
      class="owner-alert"
    />

    <div v-loading="loading" class="editor-body">
      <!-- ══ 左：编辑区 ══ -->
      <div class="editor-pane">
        <!-- 元信息 -->
        <div class="meta-bar">
          <div class="meta-item">
            <span class="meta-label">题型</span>
            <el-select v-model="questionType" style="width: 120px">
              <el-option
                v-for="t in QUESTION_TYPES"
                :key="t.value"
                :label="t.label"
                :value="t.value"
              />
            </el-select>
          </div>
          <div class="meta-item">
            <span class="meta-label">难度</span>
            <el-rate v-model="difficult" :max="4" />
          </div>
          <div class="meta-item meta-item-chapter">
            <span class="meta-label">章节</span>
            <ChapterPicker v-model="subjectId" />
          </div>
          <!-- 来源（只读展示，空字段不显示；整块全空则整行隐藏）-->
          <div v-if="hasSource" class="meta-item meta-item-source">
            <span class="meta-label">来源</span>
            <span class="meta-source-text">
              <span v-if="sourceTypeLabel" class="meta-source-seg">{{ sourceTypeLabel }}</span>
              <span v-if="examYear" class="meta-source-seg">{{ examYear }}年</span>
              <span v-if="regionCode" class="meta-source-seg">{{ regionCode }}</span>
              <span v-if="examPaperName" class="meta-source-seg">{{ examPaperName }}</span>
            </span>
          </div>
          <div class="meta-item meta-item-tags">
            <span class="meta-label">自由标签</span>
            <template v-if="freeTags.length > 0">
              <el-tag
                v-for="ft in freeTags"
                :key="ft.id"
                size="small"
                class="meta-free-tag"
              >
                {{ ft.name }}
              </el-tag>
            </template>
            <span v-else class="meta-empty">暂无</span>
          </div>
        </div>

        <!-- 工具栏（新增块）—— 排版精简模式（举一反三 AI 题）隐藏，只保留排版调整 -->
        <div v-if="!layoutOnlyMode" class="toolbar">
          <el-button size="small" :icon="Document" @click="addTextBlock">+ 文字块</el-button>
          <el-button size="small" :icon="Picture" @click="addImageBlock">+ 图片块</el-button>
          <span class="toolbar-divider" />
          <el-select v-model="optionColCount" size="small" style="width: 92px">
            <el-option :label="'1 列'" :value="1" />
            <el-option :label="'2 列'" :value="2" />
            <el-option :label="'4 列'" :value="4" />
          </el-select>
          <el-button size="small" :icon="List" @click="addOptionGroup">+ 选项组</el-button>
        </div>
        <!-- 精简模式提示条：说明此态只调排版、不改内容 -->
        <el-alert
          v-else
          type="info"
          :closable="false"
          title="排版精简模式：举一反三 AI 题仅可调整排版（行列布局 / 图片宽度对齐 / 文字字号），题面内容不可编辑"
          class="layout-only-tip"
        />

        <!-- 块列表（可拖拽换行；行内 cell 可拖拽换列）-->
        <div ref="rowsContainerRef" :key="renderKey" class="rows-container">
          <div
            v-for="(row, ri) in doc.rows"
            :key="keyOf(row)"
            class="editor-row"
            :data-row-index="ri"
          >
            <div class="row-head">
              <el-icon class="row-drag-handle" title="拖拽换行"><List /></el-icon>
              <span class="row-tag">第 {{ ri + 1 }} 行 · {{ row.cells.length }} 列</span>

              <!-- 选项组快改：仅挂在组首行，控整组列数/换行 + 增删选项 -->
              <span v-if="isGroupStart(ri)" class="opt-group-ctrl">
                <span class="opt-group-label">选项组 · {{ groupSize(ri) }} 项</span>
                <el-radio-group
                  :model-value="groupCols(ri)"
                  size="small"
                  @change="(v: string | number | boolean) => reflowGroup(ri, Number(v))"
                >
                  <el-radio-button :value="1">1列</el-radio-button>
                  <el-radio-button :value="2">2列</el-radio-button>
                  <el-radio-button :value="4">4列</el-radio-button>
                </el-radio-group>
                <!-- 增/删选项 = 改内容（新增空选项），精简态隐藏；列数切换（上方 radio）= 排版，保留 -->
                <template v-if="!layoutOnlyMode">
                  <el-button link size="small" :icon="Plus" @click="addGroupOption(ri)">选项</el-button>
                  <el-button
                    link
                    size="small"
                    type="danger"
                    :icon="Delete"
                    :disabled="groupSize(ri) <= 1"
                    @click="removeGroupOption(ri)"
                  >
                    选项
                  </el-button>
                </template>
              </span>

              <el-button
                link
                type="danger"
                size="small"
                :icon="Delete"
                @click="removeRow(ri)"
              >
                删行
              </el-button>
            </div>

            <div
              class="cells-container"
              :style="{ gridTemplateColumns: `repeat(${Math.max(1, row.cells.length)}, minmax(0, 1fr))` }"
            >
              <div
                v-for="(cell, ci) in row.cells"
                :key="keyOf(cell)"
                class="editor-cell"
                :data-cell-key="`${ri}:${ci}`"
              >
                <div class="cell-head">
                  <el-icon class="cell-drag-handle" title="拖拽换列/换行"><Plus /></el-icon>
                  <span class="cell-type-tag">
                    {{ cell.type === 'text' ? '文字' : cell.type === 'image' ? '图片' : '选项 ' + asOption(cell).label }}
                  </span>
                  <el-button
                    link
                    type="danger"
                    size="small"
                    :icon="Delete"
                    @click="removeCell(ri, ci)"
                  />
                </div>

                <!-- 文字块 -->
                <template v-if="cell.type === 'text'">
                  <!-- 排版精简模式（举一反三 AI 题）：内容只读（渲染展示，不可改）+ 仅保留字号（排版） -->
                  <template v-if="layoutOnlyMode">
                    <div class="ro-text-render">
                      <QuestionBlockRender :doc="{ v: 1, rows: [{ cells: [cell] }] }" />
                    </div>
                    <div class="img-ctrl">
                      <span class="ctrl-label">字号</span>
                      <el-select
                        :model-value="getBlockSize(cell as TextBlock)"
                        size="small"
                        style="width: 92px"
                        @change="(v: number) => setBlockSize(cell as TextBlock, Number(v))"
                      >
                        <el-option
                          v-for="s in BLOCK_SIZE_OPTIONS"
                          :key="s.value"
                          :label="s.label"
                          :value="s.value"
                        />
                      </el-select>
                    </div>
                  </template>
                  <!-- 全功能模式（手工录入题）：完整富文本编辑 + 行内预览，行为不变 -->
                  <template v-else>
                    <RichTextBlock
                      v-model="(cell as TextBlock).md"
                      :rows="3"
                      placeholder="支持 Markdown + $...$ 行内公式，例：求 $\sqrt{2}$ 的值"
                    />
                    <div class="inline-preview">
                      <QuestionBlockRender :doc="{ v: 1, rows: [{ cells: [cell] }] }" />
                    </div>
                  </template>
                </template>

                <!-- 图片块 -->
                <template v-else-if="cell.type === 'image'">
                  <el-input v-model="asImage(cell).url" placeholder="粘贴 OSS 图片链接，或点下方上传" />
                  <el-upload
                    class="img-upload"
                    :show-file-list="false"
                    :http-request="makeUploadRequest(asImage(cell))"
                    accept="image/*"
                  >
                    <el-button size="small" :icon="Picture">上传图片</el-button>
                  </el-upload>
                  <div class="img-ctrl">
                    <span class="ctrl-label">宽度</span>
                    <el-slider
                      v-model="asImage(cell).width"
                      :min="1"
                      :max="100"
                      style="width: 120px"
                    />
                    <span class="ctrl-val">{{ asImage(cell).width }}%</span>
                  </div>
                  <div class="img-ctrl">
                    <span class="ctrl-label">对齐</span>
                    <el-radio-group v-model="asImage(cell).align" size="small">
                      <el-radio-button
                        v-for="a in ALIGN_OPTIONS"
                        :key="a.value"
                        :value="a.value"
                      >
                        {{ a.label }}
                      </el-radio-button>
                    </el-radio-group>
                  </div>
                </template>

                <!-- 选项块 -->
                <template v-else>
                  <!-- 排版精简模式：选项内容只读（标签 + 内文渲染展示，不可改） -->
                  <div v-if="layoutOnlyMode" class="ro-option-render">
                    <QuestionBlockRender :doc="{ v: 1, rows: [{ cells: [cell] }] }" />
                  </div>
                  <!-- 全功能模式：选项标签 + 内文/图片完整编辑，行为不变 -->
                  <div v-else class="option-edit">
                    <div class="option-label-row">
                      <span class="opt-label-text">选项</span>
                      <el-input
                        v-model="asOption(cell).label"
                        size="small"
                        style="width: 56px"
                        maxlength="4"
                      />
                    </div>
                    <div
                      v-for="(sub, si) in asOption(cell).content"
                      :key="keyOf(sub)"
                      class="opt-sub"
                    >
                      <!-- option 内文字 -->
                      <template v-if="sub.type === 'text'">
                        <RichTextBlock
                          v-model="(sub as TextBlock).md"
                          :rows="2"
                          placeholder="选项文字（支持 $...$）"
                        />
                      </template>
                      <!-- option 内图片 -->
                      <template v-else>
                        <el-input
                          v-model="(sub as ImageBlock).url"
                          size="small"
                          placeholder="选项图片 OSS 链接"
                        />
                        <el-upload
                          class="img-upload"
                          :show-file-list="false"
                          :http-request="makeUploadRequest(sub as ImageBlock)"
                          accept="image/*"
                        >
                          <el-button size="small" :icon="Picture">上传</el-button>
                        </el-upload>
                      </template>
                      <el-button
                        link
                        type="danger"
                        size="small"
                        :icon="Delete"
                        @click="removeOptionContent(asOption(cell), si)"
                      />
                    </div>
                    <div class="opt-add-row">
                      <el-button link size="small" @click="addOptionText(asOption(cell))">+ 文字</el-button>
                      <el-button link size="small" @click="addOptionImage(asOption(cell))">+ 图片</el-button>
                    </div>
                  </div>
                </template>
              </div>
            </div>
          </div>

          <!-- 空态 -->
          <el-empty
            v-if="doc.rows.length === 0"
            description="点击上方工具栏添加文字 / 图片 / 选项组"
          />
        </div>
      </div>

      <!-- ══ 右：实时预览（QuestionBlockRender，所见即所得 = 三端一致）══ -->
      <div class="preview-pane">
        <div class="preview-head">实时预览（按最终展示宽度等比缩放）</div>
        <div class="preview-body">
          <!-- 在「代表真实展示宽度」的画布上渲染 + zoom 等比缩到栏宽 = 所见即最终（列表/详情/导出同一布局比例），
               不再因预览栏窄导致 2 列选项挤压、间距与最终对不上。渲染器与四端完全同一组件。 -->
          <div
            v-if="doc.rows.length > 0"
            class="preview-canvas"
          >
            <QuestionBlockRender :doc="doc" />
          </div>
          <div
            v-else
            class="preview-empty"
          >
            预览区（添加块后显示）
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.editor-page {
  min-height: 100vh;
  background: #f0f2f5;
  display: flex;
  flex-direction: column;
}

/* 顶栏 */
.editor-topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 24px;
  background: #fff;
  border-bottom: 1px solid #f2f3f5;
  position: sticky;
  top: 0;
  z-index: 100;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
}

.back-btn {
  color: #4e5969;
  gap: 4px;
}
.back-btn:hover {
  color: #1e8a8a;
}

.topbar-title {
  font-size: 16px;
  font-weight: 600;
  color: #1d2129;
}

.topbar-spacer {
  flex: 1;
}

.save-btn {
  background: #1e8a8a;
  border-color: #1e8a8a;
}

.owner-alert {
  margin: 8px 24px 0;
}

/* 两栏主体 */
.editor-body {
  display: flex;
  gap: 16px;
  flex: 1;
  padding: 16px 24px;
  align-items: flex-start;
}

.editor-pane {
  flex: 1;
  min-width: 0;
}

/* 元信息 */
.meta-bar {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  background: #fff;
  border: 1px solid #f2f3f5;
  border-radius: 10px;
  padding: 14px 18px;
  margin-bottom: 12px;
}

.meta-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.meta-label {
  font-size: 13px;
  color: #4e5969;
  font-weight: 500;
  white-space: nowrap;
}

/* 章节选择器占一段固定宽（ChapterPicker 内部 width:100%） */
.meta-item-chapter {
  flex: 0 0 320px;
}
.meta-item-chapter :deep(.chapter-picker) {
  width: 240px;
}

/* 来源只读展示（meta 行风格，跟 meta-label 同色系，纯文本不可编辑） */
.meta-source-text {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 13px;
  color: #1d2129;
}
/* 段间「·」分隔：靠相邻兄弟选择器加，避免空段留悬空分隔符 */
.meta-source-seg + .meta-source-seg::before {
  content: '·';
  margin-right: 6px;
  color: #c9cdd4;
}

/* 自由标签可换行 */
.meta-item-tags {
  flex-wrap: wrap;
}
.meta-free-tag {
  margin-right: 4px;
}
.meta-empty {
  font-size: 13px;
  color: #c9cdd4;
}

/* 工具栏 */
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  background: #fff;
  border: 1px solid #f2f3f5;
  border-radius: 10px;
  padding: 10px 14px;
  margin-bottom: 12px;
}

.toolbar-divider {
  width: 1px;
  height: 18px;
  background: #e4e7ed;
  margin: 0 4px;
}

/* 行容器 */
.rows-container {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 120px;
}

.editor-row {
  background: #fff;
  border: 1px solid #f2f3f5;
  border-radius: 10px;
  padding: 10px 14px 14px;
}

.row-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px dashed #eef0f3;
}

.row-drag-handle,
.cell-drag-handle {
  cursor: grab;
  color: #86909c;
  font-size: 15px;
}
.row-drag-handle:active,
.cell-drag-handle:active {
  cursor: grabbing;
}

.row-tag {
  font-size: 12px;
  color: #86909c;
  flex: 1;
}

/* 选项组快改控件（组首行） */
.opt-group-ctrl {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 2px 8px;
  background: #f0f7f7;
  border: 1px solid #d4eaea;
  border-radius: 6px;
}
.opt-group-label {
  font-size: 12px;
  color: #1e8a8a;
  font-weight: 600;
  white-space: nowrap;
}

/* cell 网格 */
.cells-container {
  display: grid;
  gap: 12px;
  align-items: start;
}

.editor-cell {
  border: 1px solid #eef0f3;
  border-radius: 8px;
  padding: 8px 10px;
  background: #fafbfc;
  min-width: 0;
}

.cell-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.cell-type-tag {
  font-size: 12px;
  color: #1e8a8a;
  font-weight: 600;
  flex: 1;
}

/* 文字块行内预览 */
.inline-preview {
  margin-top: 6px;
  padding: 6px 8px;
  background: #fff;
  border: 1px dashed #d8eded;
  border-radius: 6px;
  min-height: 24px;
}

/* 排版精简模式：内容只读渲染（文字 / 选项），不显可编辑控件 */
.ro-text-render,
.ro-option-render {
  padding: 6px 8px;
  background: #fff;
  border: 1px solid #eef0f3;
  border-radius: 6px;
  min-height: 24px;
}
.ro-text-render {
  margin-bottom: 6px;
}

/* 精简模式提示条 */
.layout-only-tip {
  margin-bottom: 12px;
}

/* 图片块控件 */
.img-upload {
  margin: 6px 0;
}

.img-ctrl {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.ctrl-label {
  font-size: 12px;
  color: #86909c;
}

.ctrl-val {
  font-size: 12px;
  color: #1d2129;
  min-width: 36px;
}

/* 选项块 */
.option-edit {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.option-label-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.opt-label-text {
  font-size: 12px;
  color: #86909c;
}

.opt-sub {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.opt-sub :deep(.el-textarea),
.opt-sub :deep(.el-input) {
  flex: 1;
}

.opt-add-row {
  display: flex;
  gap: 10px;
}

/* 右预览栏 */
.preview-pane {
  width: 440px;
  flex-shrink: 0;
  background: #fff;
  border: 1px solid #f2f3f5;
  border-radius: 10px;
  position: sticky;
  top: 73px;
  max-height: calc(100vh - 100px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.preview-head {
  padding: 12px 16px;
  font-size: 14px;
  font-weight: 600;
  color: #1d2129;
  border-bottom: 1px solid #f2f3f5;
  border-left: 4px solid #7b6cf0;
}

.preview-body {
  padding: 16px;
  overflow: auto;
  flex: 1;
}

/* 代表真实展示宽度的画布，zoom 等比缩到栏宽 → 预览=最终布局比例（列表/详情/导出一致）。
   700px ≈ 详情/卡片正文宽；440 栏 - 32 padding = 408 可视，700*0.58≈406 贴合不溢出。
   zoom 在 Chromium(本应用运行环境) 影响布局盒，高度随缩放、无需 transform 补偿。 */
.preview-canvas {
  width: 700px;
  zoom: 0.58;
}

.preview-empty {
  color: #c9cdd4;
  font-size: 13px;
  text-align: center;
  padding: 30px 0;
}

/* sortablejs 拖拽中 */
.editor-ghost {
  opacity: 0.4;
  background: #e8f6f6 !important;
  border: 1px dashed #1e8a8a !important;
}
</style>
