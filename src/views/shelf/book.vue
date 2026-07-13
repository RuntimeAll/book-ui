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
 * 性能：整本书 600+ 题不一次性 render——每「讲」为一段 section，用 IntersectionObserver
 *   懒挂载（滚到视口附近才挂 body，未挂时占位撑高），跳转前强制挂载目标讲。
 *
 * 数据源：
 *  - GET /teacher/shelf/book/{id}/structure → 整树（节点 + 内容项，含 override/explain 回显）
 *  - GET /teacher/question/list?ids= → 批量取 question 内容项的题面（override 缺省时用原题）
 *  - override 编辑 → PUT /teacher/shelf/item/{id}（只改本书，题库原题不动，D3）
 *  - 入专项 → POST /teacher/special/{specialId}/pick（C 线契约§3；未上线容错不崩页）
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import QuestionContent from '@/components/business/QuestionContent/index.vue'
import QuestionBlockRender from '@/components/business/QuestionBlockRender/index.vue'
import {
  getBookStructure,
  updateItem,
  incrItemUsed,
  pickToSpecial,
  BOOK_TYPE_LABEL,
  type BookType,
  type ShelfNodeVO,
  type ShelfItemVO,
  type ShelfStructureVO,
} from '@/api/shelf'
import { questionListByIds, type QuestionDetail } from '@/api/question'

const route = useRoute()
const router = useRouter()
const bookId = String(route.params.id)

const loading = ref(false)
const book = ref<ShelfStructureVO | null>(null)

// 扁平节点（带 depth，用于左树缩进渲染）
interface FlatNode {
  node: ShelfNodeVO
  depth: number
  questionCount: number
}
const flatNodes = ref<FlatNode[]>([])
const nodeById = ref<Record<string, ShelfNodeVO>>({})
/** 任意节点 → 其所属顶层「讲」id（懒挂载定位用）。 */
const nodeToSection = ref<Record<string, string>>({})
/** 当前高亮节点（滚动联动 / 点击定位）。 */
const activeNodeId = ref<string>('')

// 题内容 map（questionId → QuestionDetail）
const qMap = ref<Record<string, QuestionDetail>>({})

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

/** 递归统计某节点子树内 question 项数（含自身节点直属项）。 */
function countQuestions(n: ShelfNodeVO): number {
  let c = (n.items ?? []).filter((it) => it.kind === 'question').length
  for (const ch of n.children ?? []) c += countQuestions(ch)
  return c
}

/** 深度优先展平树 + 建 id 索引 + node→讲 映射 + 收集 questionId。 */
function walk(
  nodes: ShelfNodeVO[],
  depth: number,
  secId: string,
  flat: FlatNode[],
  ids: Set<string>,
) {
  for (const n of [...nodes].sort(bySeq)) {
    nodeById.value[n.id] = n
    const topId = depth === 0 ? n.id : secId
    nodeToSection.value[n.id] = topId
    flat.push({ node: n, depth, questionCount: countQuestions(n) })
    for (const it of n.items ?? []) {
      if (it.kind === 'question' && it.questionId) ids.add(it.questionId)
    }
    if (n.children?.length) walk(n.children, depth + 1, topId, flat, ids)
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 缺陷1：先序遍历收集「节点 + 全部后代」的内容块。
//   t='group'   → 分组小标题（node + 相对层级 level）
//   t='explain' → 讲解块（item.explain_json）
//   t='question'→ 题目（item，no=同讲连续题序）
// 单接口而非联合类型，避免 vue-tsc 模板窄化失效。
// ───────────────────────────────────────────────────────────────────────────
interface RenderBlock {
  t: 'group' | 'explain' | 'question'
  key: string
  node?: ShelfNodeVO
  level?: number
  qCount?: number
  item?: ShelfItemVO
  no?: number
}

/** 先序：node 分组头 → 自身 items（seq）→ 递归 children（seq）。题号 ctr 跨讲连续。 */
function collectBlocks(node: ShelfNodeVO, level: number, out: RenderBlock[], ctr: { n: number }) {
  const items = [...(node.items ?? [])].sort(bySeq)
  const children = [...(node.children ?? [])].sort(bySeq)
  out.push({ t: 'group', key: `g_${node.id}`, node, level, qCount: countQuestions(node) })
  for (const it of items) {
    if (it.kind === 'explain') {
      out.push({ t: 'explain', key: it.id, item: it })
    } else {
      ctr.n += 1
      out.push({ t: 'question', key: it.id, item: it, no: ctr.n })
    }
  }
  for (const ch of children) collectBlocks(ch, level + 1, out, ctr)
}

/** 每「讲」= 一段 section（body = 讲根分组之后的所有块；estH = 未挂载时占位高度估算）。 */
interface DocSection {
  node: ShelfNodeVO
  body: RenderBlock[]
  estH: number
}
const sections = computed<DocSection[]>(() => {
  const roots = [...(book.value?.tree ?? [])].sort(bySeq)
  return roots.map((root) => {
    const out: RenderBlock[] = []
    collectBlocks(root, 0, out, { n: 0 })
    const body = out.slice(1) // 去掉讲根分组（讲标题单独常驻渲染）
    let estH = 60
    for (const b of body) {
      estH += b.t === 'question' ? 130 : b.t === 'explain' ? 120 : 34
    }
    return { node: root, body, estH: Math.max(estH, 180) }
  })
})

// —— 懒挂载：已挂载的讲 id 集合（reactive Set 可被追踪）——
const activeSecs = reactive(new Set<string>())
function isActive(id: string) {
  return activeSecs.has(id)
}

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
const activeNode = computed<ShelfNodeVO | null>(() =>
  activeNodeId.value ? nodeById.value[activeNodeId.value] ?? null : null,
)

async function load() {
  loading.value = true
  try {
    const res = await getBookStructure(bookId)
    book.value = res
    nodeById.value = {}
    nodeToSection.value = {}
    const flat: FlatNode[] = []
    const ids = new Set<string>()
    walk(res.tree ?? [], 0, '', flat, ids)
    flatNodes.value = flat
    activeNodeId.value = flat[0]?.node.id ?? ''
    // 批量拉题面
    if (ids.size) {
      try {
        const list = await questionListByIds([...ids])
        const m: Record<string, QuestionDetail> = {}
        for (const q of list ?? []) m[String(q.id)] = q
        qMap.value = m
      } catch (e) {
        console.warn('[book] 批量拉题面失败:', e)
      }
    }
    // 挂载观察器（懒挂载 + 滚动联动）——等 DOM 出来
    await nextTick()
    setupObserver()
    refreshHeadings()
  } catch (e) {
    console.warn('[book] 加载书结构失败:', e)
    ElMessage.error('加载书结构失败')
  } finally {
    loading.value = false
  }
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
      let mounted = false
      for (const en of entries) {
        if (en.isIntersecting) {
          const id = (en.target as HTMLElement).dataset.sec
          if (id && !activeSecs.has(id)) {
            activeSecs.add(id)
            mounted = true
          }
        }
      }
      if (mounted) nextTick(refreshHeadings)
    },
    { root: contentEl.value, rootMargin: '900px 0px', threshold: 0 },
  )
  for (const el of contentEl.value.querySelectorAll<HTMLElement>('.doc-section')) io.observe(el)
}

// ─── 滚动联动：高亮当前节点 + 目录树跟随 ──────────────────────────────────────
let headingEls: HTMLElement[] = []
function refreshHeadings() {
  if (!contentEl.value) return
  headingEls = Array.from(contentEl.value.querySelectorAll<HTMLElement>('.doc-h[data-node-id]'))
}
let spyScheduled = false
function onScroll() {
  if (spyScheduled) return
  spyScheduled = true
  requestAnimationFrame(() => {
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

/** 目录点击 = 锚点跳转（先强制挂载目标讲，再滚到锚点）。 */
function goToNode(id: string) {
  activeNodeId.value = id
  const secId = nodeToSection.value[id] || id
  activeSecs.add(secId)
  nextTick(() => {
    refreshHeadings()
    scrollToAnchor(id)
    // 内容懒挂 + KaTeX 渲染会撑高，二次校正
    window.setTimeout(() => scrollToAnchor(id), 260)
  })
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
function origQ(it: ShelfItemVO): QuestionDetail | undefined {
  return it.questionId ? qMap.value[it.questionId] : undefined
}
function itemStemText(it: ShelfItemVO): string | null {
  if (it.override?.stem) return it.override.stem
  const q = origQ(it)
  return q?.stemTextContent ?? q?.stemText ?? null
}
function itemStemImg(it: ShelfItemVO): string | null {
  if (it.override?.stem) return null
  return origQ(it)?.stemImg ?? null
}
/** 原题结构化块（含选项网格）；override 改题 / 无块 → 富文本+图。 */
function itemBlockJson(it: ShelfItemVO): string | null {
  if (it.override?.stem) return null
  return origQ(it)?.blockJson ?? null
}
/** override.options（原题选项已在 blockJson 网格内）。 */
function itemOptions(it: ShelfItemVO): string[] | null {
  const opts = it.override?.options
  return opts && opts.length ? opts : null
}
function itemTypeLabel(it: ShelfItemVO): string | null {
  const t = origQ(it)?.questionType
  return t != null ? QTYPE_LABEL[t] ?? null : null
}
function isEdited(it: ShelfItemVO): boolean {
  return !!it.override && Object.keys(it.override).length > 0
}
const optLetters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']

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

// —— override 编辑对话框 ——
const editVisible = ref(false)
const editing = ref(false)
const editItem = ref<ShelfItemVO | null>(null)
const editStem = ref('')
const originalStem = ref<string | null>(null)

function openEdit(it: ShelfItemVO) {
  editItem.value = it
  editStem.value = it.override?.stem ?? itemStemText(it) ?? ''
  const q = origQ(it)
  originalStem.value = q?.stemTextContent ?? q?.stemText ?? null
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
    it.override = override
    ElMessage.success('已修改（仅本书生效，题库原题不变）')
    editVisible.value = false
  } catch (e) {
    console.warn('[book] override 保存失败:', e)
    ElMessage.error('保存失败')
  } finally {
    editing.value = false
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
  editing.value = true
  try {
    await updateItem(it.id, { override: {} as never })
    it.override = null
    ElMessage.success('已还原')
    editVisible.value = false
  } catch (e) {
    console.warn('[book] 还原失败:', e)
    ElMessage.error('还原失败')
  } finally {
    editing.value = false
  }
}

function goShelf() {
  router.push('/bookshelf')
}
function viewInBank(it: ShelfItemVO) {
  if (it.questionId) router.push(`/question/detail/${it.questionId}`)
}

onMounted(() => {
  loadCurrentSpecial()
  load()
})
onBeforeUnmount(() => io?.disconnect())
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
      <el-button size="small" @click="ElMessage.info('导出功能由备课链（PRD-003）承载')">导出本书</el-button>
    </div>

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
        <div v-if="!flatNodes.length && !loading" class="tree-empty">这本书还没有目录</div>
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
          <el-button size="small" type="primary" plain class="crumb-pick" @click="pickNode">＋ 当前节点入专项</el-button>
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
                <span class="h-pick" @click="pick({ nodeId: sec.node.id })">＋ 整讲入专项</span>
              </span>
            </h1>

            <!-- 讲正文（懒挂载） -->
            <template v-if="isActive(sec.node.id)">
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
                    <span class="h-pick" @click="pick({ nodeId: b.node!.id })">＋ 入专项</span>
                  </span>
                </component>

                <!-- 讲解正文（书体散文，含【注意】等） -->
                <div v-else-if="b.t === 'explain'" class="explain">
                  <div v-if="b.item?.explain?.title" class="explain-hd">{{ b.item.explain.title }}</div>
                  <div class="explain-body prose">
                    <QuestionContent :text="b.item?.explain?.text ?? null" />
                  </div>
                </div>

                <!-- 题目（编号悬挂 + 正文；操作悬浮嵌入） -->
                <div v-else class="q" :class="{ edited: isEdited(b.item!) }">
                  <span class="q-no">{{ b.no }}.</span>
                  <div class="q-body">
                    <div class="q-main prose">
                      <QuestionBlockRender v-if="itemBlockJson(b.item!)" :doc="itemBlockJson(b.item!)" />
                      <QuestionContent v-else :text="itemStemText(b.item!)" :img-url="itemStemImg(b.item!)" />
                    </div>
                    <div v-if="itemOptions(b.item!)" class="q-opts">
                      <span v-for="(op, i) in itemOptions(b.item!)" :key="i" class="opt">
                        <b>{{ optLetters[i] }}.</b> {{ op }}
                      </span>
                    </div>
                  </div>
                  <span v-if="isEdited(b.item!)" class="q-flag">本书已修改</span>
                  <span v-if="itemTypeLabel(b.item!)" class="q-type">{{ itemTypeLabel(b.item!) }}</span>
                  <div class="q-ops">
                    <el-button size="small" type="primary" @click="pick({ questionId: b.item!.questionId ?? undefined }, b.item!.id)">＋ 入专项</el-button>
                    <el-button size="small" @click="openEdit(b.item!)">✎ 改题</el-button>
                    <el-button v-if="b.item!.questionId" size="small" text @click="viewInBank(b.item!)">原题</el-button>
                  </div>
                </div>
              </template>
            </template>
            <div v-else class="sec-ph" :style="{ height: sec.estH + 'px' }">
              <span class="sec-ph-tip">滚动到此加载…</span>
            </div>
          </section>

          <el-empty v-if="!sections.length && !loading" description="这本书还没有内容" />
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
.q-opts {
  margin-top: 7px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 5px 24px;
  font-size: 15px;
  color: #1f2937;
}
.opt b {
  color: var(--bk-teal-deep);
  margin-right: 5px;
}
/* 题型标签：右上角低调 */
.q-type {
  position: absolute;
  top: 10px;
  right: 12px;
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

/* 懒挂载占位 */
.sec-ph {
  display: flex;
  align-items: center;
  justify-content: center;
}
.sec-ph-tip {
  font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: 12px;
  color: #c3ccc9;
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
