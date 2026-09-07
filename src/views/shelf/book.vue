<script setup lang="ts">
/**
 * PRD-002 P2 — 书浏览页（连续文档视图）。
 *
 * 🔴 方向（2026-07-13 用户拍板）：主体 = 像原书 Word/打印版的**连续排版文档**，
 *   一屏往下滚就是整讲：讲标题 → 知识点标题 → 讲解正文（含【注意】） → 例题/习题按编号
 *   连续排布 → 强化训练分区，全部顺先序遍历铺在一条文档流里。左侧目录树 = 导航（点击
 *   锚点滚动定位 + 滚动高亮当前节点），不是"切换右侧只显示该节点"。操作（改题/入专项）
 *   悬浮嵌入，阅读优先。视觉向原书 PDF 靠齐（暑假课本·第一讲）。
 *
 * 缺陷1（父节点看不到后代内容）：collectBlocks 先序递归收集「讲及其全部后代」的 items，
 *   按 seq 有序、分组带层级标题、题号按讲连续（1..N，跨知识点/题型不重置，同原书）。
 *
 * 性能：轻量目录与节点正文分离，正文按可见节点分页读取；整书导出仍走后端导出服务。
 *
 * 数据源：
 *  - GET /teacher/shelf/book/{id}/outline → 目录（不含题目 ID 或正文）
 *  - GET /teacher/shelf/book/{id}/node/{nodeId}/items → 节点正文分页
 *  - override 编辑 → PUT /teacher/shelf/item/{id}（只改本书，题库原题不动，D3）
 *  - 入专项 → POST /teacher/special/{specialId}/pick（C 线契约§3；未上线容错不崩页）
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import QuestionContent from '@/components/business/QuestionContent/index.vue'
import QuestionBlockRender from '@/components/business/QuestionBlockRender/index.vue'
import { parseBlockDoc, type QuestionBlockDoc } from '@/utils/blockSchema'
import {
  updateItem,
  incrItemUsed,
  pickToSpecial,
  exportBook,
  BOOK_TYPE_LABEL,
  type BookType,
  type ShelfOutlineNode,
  type ShelfReadingItem,
  type ShelfReadingQuestion,
  type BookExportResult,
} from '@/api/shelf'
import { type QuestionDetail } from '@/api/question'
import { useUserStore } from '@/store/user'
import { useQuestionBasket } from '@/composables/useQuestionBasket'
import { useShelfReader } from '@/composables/useShelfReader'

const route = useRoute()
const router = useRouter()
const bookId = computed(() => String(route.params.id))
const userStore = useUserStore()
const reader = useShelfReader()
const { book, loading, error: loadError, pages, flatNodes, nodeById } = reader

/** 公开书全员可读，但改题仅 owner / 超管（与 BE requireOwnedBook 对齐）。 */
const canEdit = computed(() => {
  if (userStore.isSuperAdmin) return true
  const uid = userStore.userInfo?.id
  const owner = book.value?.ownerId
  return !!uid && !!owner && String(uid) === String(owner)
})

/** 当前高亮节点（滚动联动 / 点击定位）。 */
const activeNodeId = ref<string>('')

const bookTypeLabel = computed(() =>
  book.value ? BOOK_TYPE_LABEL[book.value.bookType as BookType] ?? book.value.bookType : '',
)
const bookTagClass = computed(() => {
  const t = book.value?.bookType
  if (t === 'lecture') return 'tag lec'
  if (t === 'special') return 'tag sp'
  return 'tag wb'
})

/** 题型（原题 questionType）人读标签。 */
const QTYPE_LABEL: Record<number, string> = { 1: '选择', 2: '判断', 3: '多选', 4: '填空', 5: '简答' }

function bySeq(a: { seq?: number }, b: { seq?: number }) {
  return (a.seq ?? 0) - (b.seq ?? 0)
}

// ───────────────────────────────────────────────────────────────────────────
// 缺陷1：先序遍历收集「节点 + 全部后代」的内容块。
//   t='group'   → 分组小标题（node + 相对层级 level）
//   t='explain' → 讲解块（item.explain_json）
//   t='question'→ 题目（item）。题号不再由本页自造连续大号——改为从题干行首剥
//                 原书小题号（N．/N.）提到题号位显示，无自带号的留空（见 buildQRender）。
// 单接口而非联合类型，避免 vue-tsc 模板窄化失效。
// ───────────────────────────────────────────────────────────────────────────
interface RenderBlock {
  t: 'group' | 'explain' | 'question' | 'page'
  key: string
  node?: ShelfOutlineNode
  level?: number
  qCount?: number
  item?: ShelfReadingItem
}

/** 先序：node 分组头 → 自身 items（seq）→ 递归 children（seq）。 */
function collectBlocks(node: ShelfOutlineNode, level: number, out: RenderBlock[]) {
  const state = pages.value[node.id]
  const items = state?.rows ?? []
  const children = [...(node.children ?? [])].sort(bySeq)
  out.push({ t: 'group', key: `g_${node.id}`, node, level, qCount: node.questionCount })
  for (const it of items) {
    if (it.kind === 'explain') {
      out.push({ t: 'explain', key: it.id, item: it })
    } else if (it.kind === 'question') {
      out.push({ t: 'question', key: it.id, item: it })
    }
  }
  if (node.itemCount && (!state || state.loading || state.error || state.hasMore)) {
    out.push({ t: 'page', key: `p_${node.id}`, node })
  }
  for (const ch of children) collectBlocks(ch, level + 1, out)
}

/** 每讲保留连续排版，未读取的节点用分页占位，不依赖全书正文。 */
interface DocSection {
  node: ShelfOutlineNode
  body: RenderBlock[]
}
const sections = computed<DocSection[]>(() => {
  const roots = [...(book.value?.tree ?? [])].sort(bySeq)
  return roots.map((root) => {
    const out: RenderBlock[] = []
    collectBlocks(root, 0, out)
    const body = out.slice(1) // 去掉讲根分组（讲标题单独常驻渲染）
    return { node: root, body }
  })
})

/** 面包屑：从根到高亮节点的名称链。 */
const crumb = computed<string[]>(() => {
  const chain: string[] = []
  let cur = activeNodeId.value ? nodeById.value[activeNodeId.value] ?? null : null
  const guard = new Set<string>()
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id)
    chain.unshift(cur.name)
    cur = cur.parentId ? nodeById.value[cur.parentId] ?? null : null
  }
  return chain
})
const activeNode = computed<ShelfOutlineNode | null>(() =>
  activeNodeId.value ? nodeById.value[activeNodeId.value] ?? null : null,
)

let bookViewVersion = 0
async function load() {
  const version = ++bookViewVersion
  const id = bookId.value
  clearViewEffects()
  activeNodeId.value = ''
  editVisible.value = false
  editItem.value = null
  editStem.value = ''
  originalStem.value = null
  editing.value = false
  exportVisible.value = false
  exportResult.value = null
  exporting.value = false
  if (contentEl.value) contentEl.value.scrollTop = 0
  const loaded = await reader.load(id)
  if (!loaded || bookViewVersion !== version) return
  activeNodeId.value = flatNodes.value[0]?.node.id ?? ''
  await nextTick()
  if (bookViewVersion !== version) return
  const target = String(route.query.nodeId ?? '')
  if (target && nodeById.value[target]) await goToNode(target)
  setupObserver()
  refreshHeadings()
}

// ─── 懒挂载 IntersectionObserver（root = 内容滚动容器） ───────────────────────
const contentEl = ref<HTMLElement | null>(null)
const treeEl = ref<HTMLElement | null>(null)
let io: IntersectionObserver | null = null

function setupObserver() {
  io?.disconnect()
  if (!contentEl.value) return
  io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          const id = (en.target as HTMLElement).dataset.loadNode
          if (id && !pages.value[id]) {
            io?.unobserve(en.target)
            void reader.loadNode(id)
          }
        }
      }
    },
    { root: contentEl.value, rootMargin: '300px 0px', threshold: 0 },
  )
  for (const el of contentEl.value.querySelectorAll<HTMLElement>('[data-load-node]')) {
    if (!pages.value[el.dataset.loadNode!]) io.observe(el)
  }
}

// ─── 滚动联动：高亮当前节点 + 目录树跟随 ──────────────────────────────────────
let headingEls: HTMLElement[] = []
function refreshHeadings() {
  if (!contentEl.value) return
  headingEls = Array.from(contentEl.value.querySelectorAll<HTMLElement>('.doc-h[data-node-id]'))
}
let spyScheduled = false
let spyFrame = 0
let anchorTimer = 0
let navigationVersion = 0
function clearViewEffects() {
  navigationVersion++
  io?.disconnect()
  cancelAnimationFrame(spyFrame)
  window.clearTimeout(anchorTimer)
  headingEls = []
  spyScheduled = false
}
function onScroll() {
  if (spyScheduled) return
  spyScheduled = true
  spyFrame = requestAnimationFrame(() => {
    spyScheduled = false
    const sc = contentEl.value
    if (!sc || !headingEls.length) return
    const base = sc.getBoundingClientRect().top + 96
    let cur = ''
    for (const el of headingEls) {
      if (el.getBoundingClientRect().top <= base) cur = el.dataset.nodeId ?? cur
      else break
    }
    if (cur && cur !== activeNodeId.value) {
      activeNodeId.value = cur
      ensureTreeVisible(cur)
    }
  })
}
function ensureTreeVisible(id: string) {
  const el = treeEl.value?.querySelector<HTMLElement>(`[data-tid="${id}"]`)
  el?.scrollIntoView({ block: 'nearest' })
}

/** 目录点击只加载目标节点首页；后代继续按可见范围读取。 */
async function goToNode(id: string) {
  const version = ++navigationVersion
  window.clearTimeout(anchorTimer)
  activeNodeId.value = id
  scrollToAnchor(id)
  await reader.loadNode(id)
  if (version !== navigationVersion) return
  await nextTick()
  if (version !== navigationVersion) return
  refreshHeadings()
  scrollToAnchor(id)
  anchorTimer = window.setTimeout(() => {
    if (version === navigationVersion) scrollToAnchor(id)
  }, 260)
}
function scrollToAnchor(id: string) {
  const sc = contentEl.value
  const el = sc?.querySelector<HTMLElement>(`#n-${cssId(id)}`)
  if (!sc || !el) return
  const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 76
  sc.scrollTo({ top: Math.max(0, top), behavior: 'auto' })
}
/** 雪花 id 纯数字，作 DOM id 前缀避免以数字开头。 */
function cssId(id: string) {
  return id
}

// —— 题面解析（override 优先，否则原题） ——
function itemQuestion(it: ShelfReadingItem): ShelfReadingQuestion | undefined {
  return it.question ?? undefined
}
function itemStemText(it: ShelfReadingItem): string | null {
  const q = itemQuestion(it)
  return q?.stemTextContent ?? q?.stemText ?? null
}
function itemStemImg(it: ShelfReadingItem): string | null {
  return itemQuestion(it)?.stemImg ?? null
}
/** The server resolves all override fields with the basket/paper snapshot codec. */
function itemBlockJson(it: ShelfReadingItem): string | null {
  return itemQuestion(it)?.blockJson ?? null
}
function itemTypeLabel(it: ShelfReadingItem): string | null {
  const t = itemQuestion(it)?.questionType
  return t != null ? QTYPE_LABEL[t] ?? null : null
}
function isEdited(it: ShelfReadingItem): boolean {
  // 「本书已修改」只认真实改题（stem / options）；role/roleLabel/roleSeq 是迁移写入的角色元数据，
  // 不构成改题，否则教材配套书每道题都会误挂「本书已修改」旗标。
  const ov = it.override
  if (!ov) return false
  return ['stem', 'options', 'answer', 'analysis', 'explain', 'analyze', 'figure', 'blockJson', 'answerBlockJson', 'analyzeBlockJson']
    .some((key) => Object.prototype.hasOwnProperty.call(ov, key))
}

// ───────────────────────────────────────────────────────────────────────────
// 题号改造（2026-07-14 用户拍板）：删掉本页自造的跨节连续大题号；题干若以原书小题号
//   `N．`/`N.`（行首、全角/半角顿点）开头，把这个号提到题号位显示；无自带号的（如
//   【典型例题1】开头）题号位留空、绝不编造。
// ───────────────────────────────────────────────────────────────────────────

/**
 * 纯函数：从一段文本的**行首**剥一次原书小题号。
 *   - `12．` / `1．下列` → 全角顿点，恒当题号剥（题号后常紧跟数字，如「1．1000以内」，故不加数字前瞻）。
 *   - `3.` / `3. 计算`  → 半角句点，仅当其后不紧跟数字才剥（挡住小数 `3.14` 被误拆成题号 3）。
 *   - `（3）` / `（三）` 等括号号不是题号，不剥（正则以 `\d` 起，天然不匹配）。
 * 只认字符串最开头（`^`），只剥一次；中段出现的 `N．` 不受影响。
 */
function liftLeadingNo(text: string | null | undefined): { liftedNo: string | null; rest: string } {
  const s = text ?? ''
  const m = s.match(/^[ \t\u00a0]*(\d{1,3})(?:\uff0e|\.(?!\d))[ \t\u00a0]*/)
  if (!m) return { liftedNo: null, rest: s }
  return { liftedNo: m[1], rest: s.slice(m[0].length) }
}

/**
 * 在 blockJson 里剥号：只动**文档序第一个 text 块**（= 题干开头），中段/其它 text 块一律不碰，
 * 避免误剥题干中段的 `N．`。命中则返回剥号后的新 doc，不修改服务端读回的正文。
 */
function liftFromBlockDoc(doc: QuestionBlockDoc): { liftedNo: string | null; doc: QuestionBlockDoc } {
  for (const row of doc.rows) {
    for (const cell of row.cells) {
      if (cell.type === 'text') {
        const { liftedNo, rest } = liftLeadingNo(cell.md)
        if (liftedNo == null) return { liftedNo: null, doc }
        return {
          liftedNo,
          doc: {
            v: doc.v,
            rows: doc.rows.map((r) => ({
              cells: r.cells.map((c) => (c === cell ? { type: 'text' as const, md: rest } : c)),
            })),
          },
        }
      }
    }
  }
  return { liftedNo: null, doc }
}

/** 角色徽标（教材配套书迁移后 override_json 携 role/roleLabel/roleSeq；其余书返 null 不显示）。 */
interface RoleTag {
  /** 醒目/浅色区分依据：example=典型例题（醒目）/ practice=对应练习（浅色） */
  role: string
  /** 展示文案 = roleLabel + roleSeq（如「典型例题1」「对应练习2」） */
  label: string
}
function itemRole(it: ShelfReadingItem): RoleTag | null {
  const ov = it.override
  if (!ov) return null
  const role = ov.role
  const roleLabel = ov.roleLabel
  if (typeof role !== 'string' || !role || typeof roleLabel !== 'string' || !roleLabel) return null
  const seq = ov.roleSeq
  const seqStr = seq == null || seq === '' ? '' : String(seq)
  return { role, label: `${roleLabel}${seqStr}` }
}

/** 单题渲染模型：题号（noLabel 已含点，空串=不显示）+ 剥号后的结构化块 / 富文本题干 + 角色徽标。 */
interface QRender {
  noLabel: string
  blockDoc: QuestionBlockDoc | null
  stemText: string | null
  stemImg: string | null
  roleTag: RoleTag | null
}
function buildQRender(it: ShelfReadingItem): QRender {
  const roleTag = itemRole(it)
  // 结构化块优先（override 改题时 itemBlockJson 返 null，走富文本分支）
  const raw = itemBlockJson(it)
  if (raw) {
    const doc = parseBlockDoc(raw)
    if (doc) {
      const { liftedNo, doc: lifted } = liftFromBlockDoc(doc)
      return { noLabel: liftedNo ? `${liftedNo}.` : '', blockDoc: lifted, stemText: null, stemImg: null, roleTag }
    }
  }
  // 富文本分支（override 题面 / 无块原题）
  const stem = itemStemText(it)
  const { liftedNo, rest } = liftLeadingNo(stem)
  return {
    noLabel: liftedNo ? `${liftedNo}.` : '',
    blockDoc: null,
    stemText: liftedNo ? rest : stem,
    stemImg: itemStemImg(it),
    roleTag,
  }
}
/** item.id → 渲染模型；仅解析已加载的正文。 */
const qRenderMap = computed<Record<string, QRender>>(() => {
  const map: Record<string, QRender> = {}
  for (const sec of sections.value) {
    for (const b of sec.body) {
      if (b.t === 'question' && b.item) map[b.item.id] = buildQRender(b.item)
    }
  }
  return map
})
/** 模板取渲染模型（O(1) 查表）。 */
function qr(it?: ShelfReadingItem): QRender | undefined {
  return it ? qRenderMap.value[it.id] : undefined
}

// —— 当前专项（备课栏数据源；C 线 PRD-003 未上线时用 localStorage 占位对接） ——
const CUR_SPECIAL_KEY = 'bk_current_special'
const currentSpecial = ref<{ id: string; name: string } | null>(null)
function loadCurrentSpecial() {
  try {
    const raw = localStorage.getItem(CUR_SPECIAL_KEY)
    currentSpecial.value = raw ? JSON.parse(raw) : null
  } catch {
    currentSpecial.value = null
  }
}

/** 单题 / 整节入专项：调 C 线 pick 端点（契约§3），未上线容错。 */
async function pick(payload: { questionId?: string; nodeId?: string }, itemId?: string) {
  if (!currentSpecial.value?.id) {
    ElMessage.info('请先在备课栏选择当前专项（备课链 PRD-003）')
    return
  }
  try {
    await pickToSpecial(currentSpecial.value.id, payload)
    ElMessage.success('已放入当前专项')
    if (itemId) incrItemUsed(itemId).catch(() => {})
  } catch (e: unknown) {
    const status = (e as { response?: { status?: number }; code?: number })?.response?.status
    if (status === 404) {
      ElMessage.warning('专项功能尚未上线（备课链 PRD-003），请稍后再试')
    } else {
      ElMessage.warning('放入专项失败，请稍后再试')
    }
  }
}
function pickNode() {
  if (activeNode.value) pick({ nodeId: activeNode.value.id })
}

// —— 试题栏（全局单例仓，与题库/卷库同一个栏；成果在右下多功能球「试题栏」tab 里看） ——
const basket = useQuestionBasket()

/**
 * 书架 item → 试题栏 QuestionItem。
 * 题面口径与页面渲染一致：override.stem 优先于原题（书内改过的题，进栏的也是改后的面）。
 * 无 questionId（纯讲解块 / 脏数据）返 null，由调用方过滤。
 */
type BookBasketQuestion = QuestionDetail & {
  entryKey: string
  sourceBookId: string
  sourceItemId: string
}

function itemToBasketQ(it: ShelfReadingItem): BookBasketQuestion | null {
  if (it.kind !== 'question' || !it.questionId) return null
  const q = itemQuestion(it)
  if (!q || q.questionType == null) return null
  return {
    ...q,
    id: it.questionId,
    entryKey: `shelf:${it.id}`,
    sourceBookId: it.bookId,
    sourceItemId: it.id,
    questionType: q.questionType,
    subjectId: q.subjectId ?? undefined,
    stemImg: itemStemImg(it),
    stemText: itemStemText(it),
    stemTextContent: itemStemText(it),
    blockJson: itemBlockJson(it),
  }
}

/** 该题是否已在试题栏（模板按钮态；读 ref.value 以保持响应式追踪）。 */
function inBasket(it: ShelfReadingItem): boolean {
  return basket.basketIds.value.has(`shelf:${it.id}`)
}

const adding = ref(false)

/** 单题加入试题栏（成功后给源书 item 的 used_count +1，与入专项同口径）。 */
async function addToBasket(it: ShelfReadingItem) {
  if (adding.value || inBasket(it)) return
  const q = itemToBasketQ(it)
  if (!q) {
    ElMessage.warning('题目不存在或题型不完整，无法加入试题栏')
    return
  }
  adding.value = true
  try {
    await basket.add(q)
  } catch {
    ElMessage.error('加入试题栏失败，请重试')
  } finally {
    adding.value = false
  }
}

/** Complete subtree, bounded sequential pages; an unloaded chapter is still fully selectable. */
async function addNodeToBasket(node: ShelfOutlineNode) {
  if (adding.value) return
  adding.value = true
  let added = 0
  let questionCount = 0
  try {
    for await (const items of reader.readSubtree(node.id)) {
      const questions: BookBasketQuestion[] = []
      for (const item of items) {
        if (item.kind !== 'question') continue
        questionCount++
        const question = itemToBasketQ(item)
        if (!question) throw new Error('题目缺失或题型不完整')
        if (!inBasket(item)) questions.push(question)
      }
      if (questions.length) added += await basket.addMany(questions)
    }
    if (!questionCount) ElMessage.info('该节点下没有题目')
    else if (!added) ElMessage.info('所选题目均已在试题栏中')
  } catch {
    ElMessage.error(`章节加入未完成，已加入 ${added} 题；请重试剩余内容`)
  } finally {
    adding.value = false
  }
}

/** 顶栏「当前节点入试题栏」（跟随左树高亮节点）。 */
function addActiveNodeToBasket() {
  if (activeNode.value) addNodeToBasket(activeNode.value)
}

// —— override 编辑对话框 ——
const editVisible = ref(false)
const editing = ref(false)
const editItem = ref<ShelfReadingItem | null>(null)
const editStem = ref('')
const originalStem = ref<string | null>(null)

function openEdit(it: ShelfReadingItem) {
  editItem.value = it
  editStem.value = it.override?.stem ?? itemStemText(it) ?? ''
  originalStem.value = it.originalStemText ?? null
  editVisible.value = true
}

async function submitEdit() {
  const it = editItem.value
  if (!it) return
  const stem = editStem.value.trim()
  if (!stem) {
    ElMessage.warning('题面不能为空')
    return
  }
  editing.value = true
  try {
    const override = { ...(it.override ?? {}), stem }
    await updateItem(it.id, { override })
    if (editItem.value !== it || bookId.value !== it.bookId) return
    await reader.refreshItem(it)
    if (editItem.value !== it || bookId.value !== it.bookId) return
    ElMessage.success('已修改（仅本书生效，题库原题不变）')
    editVisible.value = false
  } catch (e) {
    if (editItem.value !== it || bookId.value !== it.bookId) return
    console.warn('[book] override 保存失败:', e)
    ElMessage.error('保存失败')
  } finally {
    if (editItem.value === it && bookId.value === it.bookId) editing.value = false
  }
}

async function restoreOriginal() {
  const it = editItem.value
  if (!it) return
  try {
    await ElMessageBox.confirm('还原为题库原题？本书内的修改将丢弃。', '还原原题', {
      type: 'warning',
      confirmButtonText: '还原',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  if (editItem.value !== it || bookId.value !== it.bookId) return
  editing.value = true
  try {
    await updateItem(it.id, { override: {} })
    if (editItem.value !== it || bookId.value !== it.bookId) return
    await reader.refreshItem(it)
    if (editItem.value !== it || bookId.value !== it.bookId) return
    ElMessage.success('已还原')
    editVisible.value = false
  } catch (e) {
    if (editItem.value !== it || bookId.value !== it.bookId) return
    console.warn('[book] 还原失败:', e)
    ElMessage.error('还原失败')
  } finally {
    if (editItem.value === it && bookId.value === it.bookId) editing.value = false
  }
}

function goShelf() {
  router.push('/bookshelf')
}
function viewInBank(it: ShelfReadingItem) {
  if (it.questionId) router.push(`/question/detail/${it.questionId}`)
}

// ── 导出本书 PDF ──────────────────────────────────────────────
// 讲义/练习册可勾「含答案」（默认不勾）；电子课本（整页图书）无答案概念，隐藏该项。
// 调 BE POST /teacher/shelf/book/{id}/export（同步长任务，大书 1–3 分钟，超时已放宽 5 分钟）。
const exportVisible = ref(false)
const exportWithAnswers = ref(false)
const exporting = ref(false)
const exportResult = ref<BookExportResult | null>(null)
const isTextbook = computed(() => book.value?.bookType === 'textbook')

function openExportDialog() {
  exportWithAnswers.value = false
  exportResult.value = null
  exporting.value = false
  exportVisible.value = true
}

async function doExportBook() {
  if (exporting.value) return
  const id = bookId.value
  const version = bookViewVersion
  exporting.value = true
  exportResult.value = null
  try {
    const res = await exportBook(id, isTextbook.value ? {} : { withAnswers: exportWithAnswers.value })
    if (bookViewVersion !== version) return
    exportResult.value = res
    ElMessage.success(`已生成 PDF${res.pages ? `（${res.pages} 页）` : ''}`)
    if (res.url) window.open(res.url, '_blank')
  } catch (e) {
    console.warn('[book] 导出失败:', e)
    /* http 拦截器已弹错，此处静默 */
  } finally {
    if (bookViewVersion === version) exporting.value = false
  }
}

function openExportUrl() {
  if (exportResult.value?.url) window.open(exportResult.value.url, '_blank')
}

watch(bookId, load, { immediate: true })
watch(() => Object.values(pages.value).map((state) => [state.pageNum, state.loading, state.error]), async () => {
  await nextTick()
  setupObserver()
  refreshHeadings()
})
watch(() => route.query.nodeId, (value) => {
  const id = String(value ?? '')
  if (nodeById.value[id]) void goToNode(id)
})
onMounted(loadCurrentSpecial)
onBeforeUnmount(() => {
  bookViewVersion++
  clearViewEffects()
})
</script>

<template>
  <div v-loading="loading" class="book-page">
    <!-- 顶栏 -->
    <div class="book-head">
      <span class="back" @click="goShelf">← 书架</span>
      <b class="bname">{{ book?.title ?? '…' }}</b>
      <span v-if="book" :class="bookTagClass">{{ bookTypeLabel }}</span>
      <span class="sp"></span>
      <span class="cur-special" :class="{ empty: !currentSpecial }">
        <template v-if="currentSpecial">正在备课：<b>{{ currentSpecial.name }}</b></template>
        <template v-else>未选择专项</template>
      </span>
      <el-button size="small" type="primary" plain :disabled="!book" @click="openExportDialog">导出本书</el-button>
    </div>

    <!-- 导出本书 PDF 对话框 -->
    <el-dialog
      v-model="exportVisible"
      title="导出本书 PDF"
      width="440px"
      style="max-width: 94vw"
      :close-on-click-modal="false"
      append-to-body
    >
      <div class="bexp-body">
        <div class="bexp-book">
          《{{ book?.title ?? '本书' }}》
          <span v-if="book" :class="bookTagClass">{{ bookTypeLabel }}</span>
        </div>

        <label v-if="!isTextbook" class="bexp-chk">
          <el-checkbox v-model="exportWithAnswers" />
          <span class="bexp-chk-t">
            含答案
            <span class="bexp-chk-d">题后附【答案】区（无答案的题自动跳过）</span>
          </span>
        </label>
        <div v-else class="bexp-note">电子课本按整页图逐页拼版，无答案选项。</div>

        <div class="bexp-tip">大书渲染较慢，可能需要 1–3 分钟，生成期间请勿关闭页面。</div>

        <!-- 导出结果 -->
        <div v-if="exportResult" class="bexp-result">
          <div class="bexp-result-t">
            导出完成{{ exportResult.pages ? `（${exportResult.pages} 页）` : '' }}，点击下载：
          </div>
          <el-button type="primary" plain size="small" @click="openExportUrl">下载 PDF</el-button>
        </div>
      </div>

      <template #footer>
        <el-button @click="exportVisible = false">{{ exportResult ? '关闭' : '取消' }}</el-button>
        <el-button type="primary" :loading="exporting" @click="doExportBook">
          {{ exporting ? '生成中…（1–3 分钟）' : '导出 PDF' }}
        </el-button>
      </template>
    </el-dialog>

    <div class="split">
      <!-- 左目录树（导航） -->
      <div ref="treeEl" class="tree">
        <div class="tree-hd">目录</div>
        <div
          v-for="f in flatNodes"
          :key="f.node.id"
          :data-tid="f.node.id"
          class="tnode"
          :class="[`l${Math.min(f.depth + 1, 3)}`, { on: f.node.id === activeNodeId }]"
          @click="goToNode(f.node.id)"
        >
          <span class="dot" :class="`d${Math.min(f.depth + 1, 3)}`"></span>
          <span class="tname">{{ f.node.name }}</span>
          <span v-if="f.questionCount" class="cnt">{{ f.questionCount }}</span>
        </div>
        <div v-if="!flatNodes.length && !loading && !loadError" class="tree-empty">这本书还没有目录</div>
      </div>

      <!-- 右内容（连续文档流） -->
      <div ref="contentEl" class="content" @scroll="onScroll">
        <!-- 面包屑 + 全书级操作（常驻顶部） -->
        <div v-if="flatNodes.length" class="crumb">
          <span class="crumb-path">
            <template v-for="(c, i) in crumb" :key="i">
              <span v-if="i > 0" class="chev">›</span>
              <span :class="{ cur: i === crumb.length - 1 }">{{ c }}</span>
            </template>
          </span>
          <span class="crumb-ops">
            <el-button size="small" type="success" plain class="crumb-pick" :loading="adding" @click="addActiveNodeToBasket">＋ 当前节点入试题栏</el-button>
            <el-button size="small" type="primary" plain class="crumb-pick" @click="pickNode">＋ 当前节点入专项</el-button>
          </span>
        </div>

        <div class="doc">
          <section
            v-for="sec in sections"
            :key="sec.node.id"
            class="doc-section"
            :data-sec="sec.node.id"
          >
            <!-- 讲标题（常驻，锚点） -->
            <h1 :id="`n-${sec.node.id}`" class="doc-h lv0" :data-node-id="sec.node.id">
              <span class="h-name">{{ sec.node.name }}</span>
              <span class="h-ops">
                <span class="h-basket" @click="addNodeToBasket(sec.node)">＋ 整讲入试题栏</span>
                <span class="h-pick" @click="pick({ nodeId: sec.node.id })">＋ 整讲入专项</span>
              </span>
            </h1>

            <!-- 节点标题常驻，正文按可见节点分页读取。 -->
              <template v-for="b in sec.body" :key="b.key">
                <!-- 分组小标题：知识点(lv1)/题型(lv2)/更深(lv3) -->
                <component
                  :is="(b.level ?? 1) <= 1 ? 'h2' : (b.level ?? 1) === 2 ? 'h3' : 'h4'"
                  v-if="b.t === 'group'"
                  :id="`n-${b.node!.id}`"
                  class="doc-h"
                  :class="`lv${Math.min(b.level ?? 1, 3)}`"
                  :data-node-id="b.node!.id"
                >
                  <span class="h-name">{{ b.node?.name }}</span>
                  <span v-if="b.qCount" class="h-cnt">{{ b.qCount }} 题</span>
                  <span class="h-ops">
                    <span class="h-basket" @click="addNodeToBasket(b.node!)">＋ 入试题栏</span>
                    <span class="h-pick" @click="pick({ nodeId: b.node!.id })">＋ 入专项</span>
                  </span>
                </component>

                <div
                  v-else-if="b.t === 'page'"
                  class="node-page"
                  :data-load-node="b.node!.id"
                  :style="{ minHeight: pages[b.node!.id]?.pageNum ? '56px' : `${Math.min(b.node!.itemCount, 20) * 130}px` }"
                >
                  <el-button
                    :loading="pages[b.node!.id]?.loading"
                    @click="reader.loadNode(b.node!.id, true)"
                  >{{ pages[b.node!.id]?.error ? '加载失败，重试' : pages[b.node!.id]?.pageNum ? '加载更多' : '加载正文' }}</el-button>
                  <span v-if="pages[b.node!.id]?.pageNum" class="node-progress">
                    {{ pages[b.node!.id].rows.length }} / {{ pages[b.node!.id].total }} 项
                  </span>
                </div>

                <!-- 讲解正文（书体散文，含【注意】等） -->
                <div v-else-if="b.t === 'explain'" class="explain">
                  <div v-if="b.item?.explain?.title" class="explain-hd">{{ b.item.explain.title }}</div>
                  <div class="explain-body prose">
                    <QuestionContent :text="b.item?.explain?.text ?? null" />
                  </div>
                </div>

                <!-- 题目（题号=题干剥出的原书小号，无则留空；正文；操作悬浮嵌入） -->
                <div v-else-if="b.t === 'question'" class="q" :class="{ edited: isEdited(b.item!) }">
                  <span class="q-no">{{ qr(b.item)?.noLabel }}</span>
                  <div class="q-body">
                    <div class="q-main prose">
                      <span v-if="b.item!.questionMissing" class="missing-question">原题已失效，无法加入试题栏</span>
                      <QuestionBlockRender v-else-if="qr(b.item)?.blockDoc" :doc="qr(b.item)!.blockDoc!" />
                      <QuestionContent v-else :text="qr(b.item)?.stemText ?? null" :img-url="qr(b.item)?.stemImg ?? null" />
                    </div>
                  </div>
                  <span v-if="isEdited(b.item!)" class="q-flag">本书已修改</span>
                  <div v-if="qr(b.item)?.roleTag || itemTypeLabel(b.item!)" class="q-tags">
                    <span
                      v-if="qr(b.item)?.roleTag"
                      class="q-role"
                      :class="qr(b.item)!.roleTag!.role === 'example' ? 'role-example' : 'role-practice'"
                    >{{ qr(b.item)!.roleTag!.label }}</span>
                    <span v-if="itemTypeLabel(b.item!)" class="q-type">{{ itemTypeLabel(b.item!) }}</span>
                  </div>
                  <div class="q-ops">
                    <el-button
                      v-if="b.item!.questionId"
                      size="small"
                      type="success"
                      :disabled="adding || b.item!.questionMissing || inBasket(b.item!)"
                      @click="addToBasket(b.item!)"
                    >{{ inBasket(b.item!) ? '✓ 已在试题栏' : '＋ 试题栏' }}</el-button>
                    <el-button size="small" type="primary" @click="pick({ questionId: b.item!.questionId ?? undefined }, b.item!.id)">＋ 入专项</el-button>
                    <el-button v-if="canEdit" size="small" @click="openEdit(b.item!)">✎ 改题</el-button>
                    <el-button v-if="b.item!.questionId" size="small" text @click="viewInBank(b.item!)">原题</el-button>
                  </div>
                </div>
              </template>
          </section>

          <el-empty v-if="loadError" description="讲义加载失败">
            <el-button type="primary" @click="load">重试</el-button>
          </el-empty>
          <el-empty v-else-if="!sections.length && !loading" description="这本书还没有内容" />
        </div>
      </div>
    </div>

    <!-- override 编辑对话框 -->
    <el-dialog v-model="editVisible" title="书内改题（override）" width="560px">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="只影响本书，题库原题不变"
        style="margin-bottom: 12px"
      />
      <el-form label-position="top">
        <el-form-item label="题面（富文本 Markdown + $LaTeX$）">
          <el-input v-model="editStem" type="textarea" :rows="5" placeholder="改后题面" />
        </el-form-item>
      </el-form>
      <div v-if="originalStem" class="orig-box">
        <div class="orig-title">原题面（可回看）</div>
        <div class="orig-body">{{ originalStem }}</div>
      </div>
      <template #footer>
        <el-button v-if="editItem && isEdited(editItem)" type="warning" plain :loading="editing" @click="restoreOriginal">还原原题</el-button>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="editing" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.node-page {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  gap: 12px;
  padding-top: 16px;
}
.node-progress {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.missing-question {
  color: var(--el-color-danger);
}
.book-page {
  max-width: 1180px;
  margin: 0 auto;
  padding: 14px 24px 40px;
}

/* ── 顶栏 ── */
.book-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  background: #fff;
  border: 1px solid var(--bk-line);
  border-radius: 12px 12px 0 0;
}
.back {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  transition: color 0.15s;
}
.back:hover {
  color: var(--bk-teal);
}
.bname {
  font-size: 16px;
  font-weight: 800;
  color: var(--bk-ink);
}
.sp {
  flex: 1;
}
.cur-special {
  font-size: 12px;
  color: var(--bk-teal-deep);
  background: var(--bk-teal-soft);
  border: 1px solid var(--el-color-primary-light-7);
  border-radius: 8px;
  padding: 4px 12px;
}
.cur-special.empty {
  color: var(--el-text-color-secondary);
  background: #f5f7f6;
  border-color: var(--bk-line);
}
.tag {
  display: inline-block;
  font-size: 11px;
  font-weight: 700;
  padding: 1px 8px;
  border-radius: 6px;
}
.tag.lec {
  background: #e8f1fb;
  color: #1268b3;
}
.tag.wb {
  background: var(--bk-teal-soft);
  color: var(--bk-teal-deep);
}
.tag.sp {
  background: #f3ecfb;
  color: #7a4fc0;
}

/* ── 左右分栏 ── */
.split {
  display: grid;
  grid-template-columns: 268px 1fr;
  min-height: 480px;
  border: 1px solid var(--bk-line);
  border-top: none;
  border-radius: 0 0 12px 12px;
  overflow: hidden;
  background: #fff;
}

/* ── 左目录树（导航） ── */
.tree {
  border-right: 1px solid var(--bk-line);
  padding: 0 0 12px;
  background: linear-gradient(180deg, #f7fbfa 0%, #f4f9f8 100%);
  font-size: 13px;
  overflow-y: auto;
  max-height: 80vh;
}
.tree-hd {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 11px 16px 9px;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.12em;
  color: var(--bk-teal-deep);
  background: #f2f8f7;
  border-bottom: 1px solid var(--bk-line);
}
.tnode {
  padding: 6px 14px 6px 16px;
  color: var(--el-text-color-regular);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 7px;
  border-left: 2px solid transparent;
  transition: background 0.12s, color 0.12s;
}
.tnode:hover {
  background: var(--bk-teal-soft);
}
.tnode.l1 {
  font-weight: 700;
  color: var(--bk-ink);
}
.tnode.l2 {
  padding-left: 30px;
  font-weight: 500;
}
.tnode.l3 {
  padding-left: 46px;
  font-size: 12.5px;
  color: var(--el-text-color-secondary);
}
.tnode.on {
  background: var(--bk-teal-soft);
  color: var(--bk-teal-deep);
  font-weight: 800;
  border-left-color: var(--bk-teal);
}
.tnode.l3.on {
  color: var(--bk-teal-deep);
}
.dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.dot.d1 {
  background: var(--bk-teal);
}
.dot.d2 {
  width: 6px;
  height: 6px;
  background: #6bb7ad;
}
.dot.d3 {
  width: 5px;
  height: 5px;
  background: transparent;
  border: 1px solid #a9cbc5;
}
.tname {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cnt {
  flex: none;
  min-width: 22px;
  text-align: center;
  font-size: 10.5px;
  font-weight: 700;
  color: var(--bk-teal-deep);
  background: #fff;
  border: 1px solid var(--el-color-primary-light-7);
  border-radius: 999px;
  padding: 0 6px;
  line-height: 16px;
}
.tnode.on .cnt {
  background: var(--bk-teal);
  border-color: var(--bk-teal);
  color: #fff;
}
.tree-empty {
  padding: 16px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

/* ── 右内容：滚动容器 ── */
.content {
  overflow-y: auto;
  max-height: 80vh;
  background: #f4f6f5;
  position: relative;
}
.crumb {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 22px;
  border-bottom: 1px solid var(--bk-line);
  position: sticky;
  top: 0;
  background: rgba(248, 250, 249, 0.94);
  backdrop-filter: blur(4px);
  z-index: 5;
}
.crumb-path {
  flex: 1;
  font-size: 12.5px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chev {
  margin: 0 6px;
  color: #c0cfcb;
}
.crumb-path .cur {
  color: var(--bk-ink);
  font-weight: 700;
}
.crumb-pick {
  flex: none;
}
.crumb-ops {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ── 文档纸张：窄栏居中，向原书排版靠齐 ── */
.doc {
  max-width: 780px;
  margin: 0 auto;
  padding: 26px 40px 80px;
  background: var(--bk-paper, #fffdf9);
  min-height: 60vh;
  /* 正文用衬线体，贴近打印教辅观感 */
  font-family: 'Songti SC', 'STSong', 'SimSun', 'Noto Serif SC', serif;
  color: #1f2937;
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.02);
}
.doc-section {
  scroll-margin-top: 72px;
}

/* 标题层级（黑体加粗，向原书标题靠齐） */
.doc-h {
  font-family: 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
  display: flex;
  align-items: baseline;
  gap: 10px;
  scroll-margin-top: 72px;
  position: relative;
}
.doc-h .h-name {
  color: #1a1a1a;
}
.doc-h .h-cnt {
  font-size: 11px;
  font-weight: 700;
  color: var(--bk-teal-deep);
  background: var(--bk-teal-soft);
  border-radius: 999px;
  padding: 1px 9px;
  align-self: center;
}
/* 讲标题（lv0）：最大号，顶部分隔 */
.doc-h.lv0 {
  margin: 40px 0 22px;
  padding-bottom: 12px;
  border-bottom: 2px solid #d8e5e2;
  font-size: 25px;
  font-weight: 800;
  letter-spacing: 0.02em;
}
.doc-section:first-child .doc-h.lv0 {
  margin-top: 8px;
}
/* 知识点（lv1） */
.doc-h.lv1 {
  margin: 30px 0 12px;
  font-size: 18px;
  font-weight: 800;
}
.doc-h.lv1 .h-name::before {
  content: '';
  display: inline-block;
  width: 5px;
  height: 17px;
  background: var(--bk-teal);
  border-radius: 2px;
  margin-right: 9px;
  vertical-align: -2px;
}
/* 题型（lv2） */
.doc-h.lv2 {
  margin: 22px 0 10px;
  font-size: 15px;
  font-weight: 700;
}
.doc-h.lv2 .h-name {
  color: #22403a;
}
.doc-h.lv2 .h-name::before {
  content: '';
  display: inline-block;
  width: 3px;
  height: 13px;
  background: #7bb3ab;
  border-radius: 2px;
  margin-right: 8px;
  vertical-align: -1px;
}
/* 更深（lv3+） */
.doc-h.lv3 {
  margin: 16px 0 8px;
  font-size: 13.5px;
  font-weight: 700;
  color: var(--el-text-color-secondary);
}

/* 标题行内悬浮操作（阅读优先，hover 才现） */
.h-ops {
  margin-left: auto;
  opacity: 0;
  transition: opacity 0.14s;
}
.doc-h:hover .h-ops {
  opacity: 1;
}
.h-pick {
  font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: 12px;
  font-weight: 600;
  color: var(--bk-teal-deep);
  background: var(--bk-teal-soft);
  border: 1px solid var(--el-color-primary-light-7);
  border-radius: 7px;
  padding: 2px 10px;
  cursor: pointer;
  white-space: nowrap;
}
.h-pick:hover {
  background: var(--bk-teal);
  color: #fff;
  border-color: var(--bk-teal);
}
/* 入试题栏：与入专项同形，绿色区分去向（栏=暂存挑题 / 专项=成册） */
.h-basket {
  font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: 12px;
  font-weight: 600;
  color: var(--el-color-success);
  background: var(--el-color-success-light-9);
  border: 1px solid var(--el-color-success-light-7);
  border-radius: 7px;
  padding: 2px 10px;
  cursor: pointer;
  white-space: nowrap;
}
.h-basket:hover {
  background: var(--el-color-success);
  color: #fff;
  border-color: var(--el-color-success);
}

/* 讲解正文：书体散文 */
.prose {
  font-size: 15.5px;
  line-height: 1.95;
}
.explain {
  margin: 6px 0 18px;
  padding: 12px 16px;
  background: #fbf9f3;
  border: 1px solid #efe7d4;
  border-left: 3px solid #e2c893;
  border-radius: 0 8px 8px 0;
}
.explain-hd {
  font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: 13.5px;
  font-weight: 800;
  color: #9a6a12;
  margin-bottom: 6px;
}
.explain-body {
  color: #33322c;
}
/* 讲解正文内首行缩进（贴近纸书段落） */
.explain-body :deep(.qc-richtext p) {
  text-indent: 0;
}

/* 题目：编号悬挂 + 正文列 + 悬浮操作 */
.q {
  position: relative;
  display: flex;
  gap: 8px;
  padding: 10px 12px 12px 4px;
  margin: 4px 0;
  border-radius: 8px;
  border: 1px solid transparent;
  transition: background 0.12s, border-color 0.12s;
}
.q:hover {
  background: #fbfcfb;
  border-color: #eaefed;
}
.q.edited {
  background: #fdf9f0;
  border-color: #f0e0bd;
}
.q-no {
  font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
  flex: none;
  min-width: 26px;
  text-align: right;
  font-size: 15.5px;
  font-weight: 700;
  color: #1a1a1a;
  line-height: 1.7;
  padding-top: 1px;
}
.q-body {
  flex: 1;
  min-width: 0;
}
.q-main {
  color: #1f2937;
  /* 顶部右侧给常驻题型标签 / 悬浮操作条留出空档，避免压住首行题干 */
  padding-right: 58px;
}
/* 标签组：右上角，角色徽标 + 题型标签横排 */
.q-tags {
  position: absolute;
  top: 10px;
  right: 12px;
  display: flex;
  gap: 6px;
  align-items: center;
}
/* 题型标签：右上角低调 */
.q-type {
  font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: 11px;
  font-weight: 700;
  color: var(--el-text-color-secondary);
  background: #f2f5f4;
  border: 1px solid var(--bk-line);
  border-radius: 5px;
  padding: 0 7px;
  opacity: 0.9;
}
/* 角色徽标：example=典型例题（醒目实心）/ practice=对应练习（浅色） */
.q-role {
  font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: 11px;
  font-weight: 700;
  border-radius: 5px;
  padding: 0 7px;
  white-space: nowrap;
}
.q-role.role-example {
  color: #fff;
  background: var(--bk-teal);
  border: 1px solid var(--bk-teal-deep);
}
.q-role.role-practice {
  color: var(--bk-teal-deep);
  background: #eef7f5;
  border: 1px solid var(--bk-teal);
}
.q-flag {
  position: absolute;
  top: -8px;
  left: 30px;
  font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: 10px;
  background: var(--el-color-warning);
  color: #fff;
  border-radius: 4px;
  padding: 1px 6px;
  font-weight: 700;
}
/* 题目悬浮操作条（阅读优先，hover 才现，覆盖题型标签位） */
.q-ops {
  position: absolute;
  top: 6px;
  right: 8px;
  display: flex;
  gap: 5px;
  padding: 3px 5px;
  background: rgba(255, 255, 255, 0.96);
  border: 1px solid var(--bk-line);
  border-radius: 8px;
  box-shadow: 0 2px 10px rgba(20, 60, 54, 0.1);
  opacity: 0;
  transform: translateY(-2px);
  transition: opacity 0.14s, transform 0.14s;
  pointer-events: none;
}
.q:hover .q-ops {
  opacity: 1;
  transform: translateY(0);
  pointer-events: auto;
}

/* 还原对话框内的原题回看 */
.orig-box {
  border: 1px dashed var(--bk-line);
  border-radius: 8px;
  padding: 10px 12px;
  background: #fafcfb;
}
.orig-title {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 4px;
}
.orig-body {
  font-size: 13px;
  color: var(--el-text-color-regular);
  white-space: pre-wrap;
  word-break: break-word;
}

/* 导出本书对话框 */
.bexp-body {
  padding: 2px 2px 0;
}
.bexp-book {
  font-size: 15px;
  font-weight: 700;
  color: var(--el-text-color-primary);
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.bexp-chk {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 4px;
  cursor: pointer;
}
.bexp-chk-t {
  font-size: 14px;
  color: var(--el-text-color-primary);
  display: flex;
  flex-direction: column;
  line-height: 1.4;
}
.bexp-chk-d {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 2px;
}
.bexp-note {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  padding: 6px 4px;
}
.bexp-tip {
  font-size: 12px;
  color: #d48806;
  background: #fffbe6;
  border: 1px solid #ffe58f;
  border-radius: 6px;
  padding: 8px 10px;
  margin-top: 12px;
}
.bexp-result {
  margin-top: 14px;
  padding: 12px;
  background: #f2faf7;
  border: 1px solid #d3ece5;
  border-radius: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.bexp-result-t {
  width: 100%;
  font-size: 13px;
  color: #0a8e6a;
  font-weight: 600;
}

/* 响应式 */
@media (max-width: 860px) {
  .split {
    grid-template-columns: 1fr;
  }
  .tree {
    border-right: none;
    border-bottom: 1px solid var(--bk-line);
    max-height: 220px;
  }
  .doc {
    padding: 20px 18px 60px;
  }
}
</style>
