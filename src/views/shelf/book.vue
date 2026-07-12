<script setup lang="ts">
/**
 * PRD-002 P2 — 书浏览页。
 * 左目录树右内容：讲解块渲染 + 题目渲染（复用 QuestionContent）+ override 就地编辑 + 挑题入专项。
 *
 * 数据源：
 *  - GET /teacher/shelf/book/{id}/structure → 整树（节点 + 内容项，含 override/explain 回显）
 *  - GET /teacher/question/list?ids= → 批量取 question 内容项的题面（override 缺省时用原题）
 *  - override 编辑 → PUT /teacher/shelf/item/{id}（只改本书，题库原题不动，D3）
 *  - 入专项 → POST /teacher/special/{specialId}/pick（C 线契约§3；未上线容错不崩页）
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import QuestionContent from '@/components/business/QuestionContent/index.vue'
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
const selectedNodeId = ref<string>('')

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

/** 递归统计某节点子树内 question 项数（含自身节点直属项）。 */
function countQuestions(n: ShelfNodeVO): number {
  let c = (n.items ?? []).filter((it) => it.kind === 'question').length
  for (const ch of n.children ?? []) c += countQuestions(ch)
  return c
}

/** 深度优先展平树 + 建 id 索引 + 收集所有 questionId。 */
function walk(nodes: ShelfNodeVO[], depth: number, flat: FlatNode[], ids: Set<string>) {
  for (const n of nodes) {
    nodeById.value[n.id] = n
    flat.push({ node: n, depth, questionCount: countQuestions(n) })
    for (const it of n.items ?? []) {
      if (it.kind === 'question' && it.questionId) ids.add(it.questionId)
    }
    if (n.children?.length) walk(n.children, depth + 1, flat, ids)
  }
}

async function load() {
  loading.value = true
  try {
    const res = await getBookStructure(bookId)
    book.value = res
    nodeById.value = {}
    const flat: FlatNode[] = []
    const ids = new Set<string>()
    walk(res.tree ?? [], 0, flat, ids)
    flatNodes.value = flat
    // 默认选中第一个有内容的节点，否则第一个节点
    const firstWithItems = flat.find((f) => (f.node.items ?? []).length > 0)
    selectedNodeId.value = (firstWithItems ?? flat[0])?.node.id ?? ''
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
  } catch (e) {
    console.warn('[book] 加载书结构失败:', e)
    ElMessage.error('加载书结构失败')
  } finally {
    loading.value = false
  }
}

const selectedNode = computed<ShelfNodeVO | null>(() =>
  selectedNodeId.value ? nodeById.value[selectedNodeId.value] ?? null : null,
)

/** 面包屑：从根到选中节点的名称链。 */
const crumb = computed<string[]>(() => {
  const chain: string[] = []
  let cur = selectedNode.value
  const guard = new Set<string>()
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id)
    chain.unshift(cur.name)
    cur = cur.parentId ? nodeById.value[cur.parentId] ?? null : null
  }
  return chain
})

function selectNode(id: string) {
  selectedNodeId.value = id
}

// —— 题面解析（override 优先，否则原题） ——
function itemStemText(it: ShelfItemVO): string | null {
  if (it.override?.stem) return it.override.stem
  const q = it.questionId ? qMap.value[it.questionId] : undefined
  return q?.stemTextContent ?? q?.stemText ?? null
}
function itemStemImg(it: ShelfItemVO): string | null {
  if (it.override?.stem) return null // override 纯文本，不带原题图
  const q = it.questionId ? qMap.value[it.questionId] : undefined
  return q?.stemImg ?? null
}
/** 选项：override.options 优先；原题选项内嵌 blockJson 不在此拆，仅 override 时展示。 */
function itemOptions(it: ShelfItemVO): string[] | null {
  const opts = it.override?.options
  return opts && opts.length ? opts : null
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
    // 认证计数：单题入专项即 used_count+1（best-effort，失败不打断）
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
  const n = selectedNode.value
  if (!n) return
  pick({ nodeId: n.id })
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
  // 原题面（override 前的底稿）供回看
  const q = it.questionId ? qMap.value[it.questionId] : undefined
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
    it.override = override // 就地回显（即改即生效）
    ElMessage.success('已修改（仅本书生效，题库原题不变）')
    editVisible.value = false
  } catch (e) {
    console.warn('[book] override 保存失败:', e)
    ElMessage.error('保存失败')
  } finally {
    editing.value = false
  }
}

/** 还原：清空 override（回落原题）。BE updateItem 对 null 不写，故传空对象覆盖。 */
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
</script>

<template>
  <div v-loading="loading" class="book-page">
    <!-- 顶栏 -->
    <div class="book-head">
      <span class="back" @click="goShelf">← 书架</span>
      <b class="bname">{{ book?.title ?? '…' }}</b>
      <span v-if="book" :class="bookTagClass">{{ bookTypeLabel }}</span>
      <span class="sp"></span>
      <span class="cur-special">
        <template v-if="currentSpecial">正在备课：<b>{{ currentSpecial.name }}</b></template>
        <template v-else>未选择专项</template>
      </span>
      <el-button size="small" @click="ElMessage.info('导出功能由备课链（PRD-003）承载')">导出本书</el-button>
    </div>

    <div class="split">
      <!-- 左目录树 -->
      <div class="tree">
        <div
          v-for="f in flatNodes"
          :key="f.node.id"
          class="tnode"
          :class="[`l${Math.min(f.depth + 1, 3)}`, { on: f.node.id === selectedNodeId }]"
          @click="selectNode(f.node.id)"
        >
          <span class="tname">{{ f.node.name }}</span>
          <span v-if="f.questionCount" class="cnt">{{ f.questionCount }}题</span>
        </div>
        <div v-if="!flatNodes.length && !loading" class="tree-empty">这本书还没有目录</div>
      </div>

      <!-- 右内容 -->
      <div class="content">
        <template v-if="selectedNode">
          <div class="crumb">
            <span>{{ crumb.join(' › ') }}</span>
            <el-button size="small" text type="primary" class="crumb-pick" @click="pickNode">＋ 整节入专项</el-button>
          </div>

          <div v-if="!(selectedNode.items && selectedNode.items.length)" class="node-empty">
            该节点暂无内容项（可能内容在子节点，点开左侧子节点查看）
          </div>

          <template v-for="it in selectedNode.items ?? []" :key="it.id">
            <!-- 讲解块 -->
            <div v-if="it.kind === 'explain'" class="explain">
              <b v-if="it.explain?.title">{{ it.explain.title }}</b>
              <b v-else>讲解</b>
              <div class="explain-body">
                <QuestionContent :text="it.explain?.text ?? null" />
              </div>
            </div>

            <!-- 题目行 -->
            <div v-else class="qrow" :class="{ edited: isEdited(it) }">
              <span v-if="isEdited(it)" class="flag">本书已修改</span>
              <div class="stem">
                <QuestionContent :text="itemStemText(it)" :img-url="itemStemImg(it)" />
              </div>
              <div v-if="itemOptions(it)" class="opts">
                <span v-for="(op, i) in itemOptions(it)" :key="i" class="opt">{{ optLetters[i] }}. {{ op }}</span>
              </div>
              <div class="qops">
                <el-button size="small" type="primary" @click="pick({ questionId: it.questionId ?? undefined }, it.id)">＋ 入专项</el-button>
                <el-button size="small" @click="openEdit(it)">✎</el-button>
                <el-button v-if="it.questionId" size="small" text @click="viewInBank(it)">原题</el-button>
              </div>
            </div>
          </template>
        </template>
        <el-empty v-else-if="!loading" description="从左侧选择一个目录节点" />
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
  padding: 14px 24px 60px;
}
.book-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0 14px;
  border-bottom: 1px solid var(--bk-line);
}
.back {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  cursor: pointer;
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
  padding: 3px 12px;
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

.split {
  display: grid;
  grid-template-columns: 260px 1fr;
  min-height: 460px;
  border: 1px solid var(--bk-line);
  border-top: none;
  border-radius: 0 0 12px 12px;
  overflow: hidden;
}
.tree {
  border-right: 1px solid var(--bk-line);
  padding: 12px 0;
  background: #f8fbfa;
  font-size: 13px;
  overflow-y: auto;
  max-height: 72vh;
}
.tnode {
  padding: 5px 16px;
  color: var(--el-text-color-regular);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
}
.tnode:hover {
  background: var(--bk-teal-soft);
}
.tnode.l2 {
  padding-left: 32px;
}
.tnode.l3 {
  padding-left: 48px;
  font-size: 12.5px;
}
.tnode.on {
  background: var(--bk-teal-soft);
  color: var(--bk-teal-deep);
  font-weight: 700;
  border-right: 2px solid var(--bk-teal);
}
.tname {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cnt {
  font-size: 10.5px;
  color: var(--el-text-color-secondary);
}
.tree-empty,
.node-empty {
  padding: 16px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.content {
  padding: 16px 22px;
  overflow-y: auto;
  max-height: 72vh;
}
.crumb {
  font-size: 12.5px;
  color: var(--el-text-color-secondary);
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.crumb-pick {
  padding: 0 6px;
}
.explain {
  background: #fdf6ec;
  border-left: 3px solid var(--el-color-warning);
  border-radius: 0 8px 8px 0;
  padding: 10px 14px;
  font-size: 13px;
  color: var(--el-text-color-regular);
  margin-bottom: 12px;
}
.explain b {
  color: var(--bk-ink);
  display: block;
  margin-bottom: 4px;
}
.qrow {
  border: 1px solid var(--bk-line);
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 10px;
  position: relative;
}
.qrow.edited {
  border-color: var(--el-color-warning);
}
.qrow .flag {
  position: absolute;
  top: -9px;
  left: 12px;
  font-size: 10px;
  background: var(--el-color-warning);
  color: #fff;
  border-radius: 4px;
  padding: 1px 6px;
  font-weight: 700;
}
.opts {
  font-size: 13px;
  color: var(--el-text-color-regular);
  margin-top: 6px;
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
}
.qops {
  margin-top: 10px;
  display: flex;
  gap: 6px;
  align-items: center;
}
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
@media (max-width: 760px) {
  .split {
    grid-template-columns: 1fr;
  }
  .tree {
    border-right: none;
    border-bottom: 1px solid var(--bk-line);
    max-height: 240px;
  }
}
</style>
