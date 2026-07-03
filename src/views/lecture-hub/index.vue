<script setup lang="ts">
/**
 * 讲义（Lecture Hub）—— 教辅讲义只读浏览器（PRD-C-207 P1）
 *
 * 三栏：左·教辅结构树（复用 SubjectDirectory，课时挂讲义处显"N版"徽标、未挂置灰）
 *      中·讲义渲染（UmoEditor readOnly 喂 getLecture 汇聚好的 docJson；顶部"讲义来源"切换器 + 上/下课时）
 *      右·本课目录（从渲染后 h1~h6 提取，scrollBy 循环逼近定位，驯 Umo 封闭滚动）
 *
 * 数据：GET /teacher/kg/lecture-catalog（左树灰置+来源）+ GET /teacher/kg/lecture（片段按前缀汇聚成一份 doc）。
 * example 节点仍复用 KgExampleNodeView → /teacher/kg/questions。编辑=P2（本页只读）。
 */
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { UmoEditor } from '@umoteam/editor'
// PRD-C-212 V0：Umo 样式从 main.ts 下沉到讲义两页（体积大含字体，别全站买单）
import '@umoteam/editor/style'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Edit, ArrowLeftBold, ArrowRightBold, Document, Check, Close } from '@element-plus/icons-vue'
import SubjectDirectory from '@/components/business/SubjectDirectory/index.vue'
import { KG_NODE_EXTENSIONS } from '@/extensions/kg-nodes/index'
import { lazyTree, questionPage, type SubjectNode, type QuestionItem } from '@/api/question'
import { useUserStore } from '@/store/user'
import { useDictStore, DICT_QUESTION_TYPE } from '@/store/dict'
import {
  getLectureCatalog, getLecture, saveLectureFrags,
  type CatalogLesson, type LectureSource, type LectureFragSave,
} from '@/api/kg/lecture'

const BOOK_ID = 'CC7S'
const userStore = useUserStore()
const dict = useDictStore()

// ── 目录数据（灰置 + 来源 + 上/下课时）─────────────────────────────
const lessons = ref<CatalogLesson[]>([])
/** 当前登录者 uid（catalog 响应带回；null=匿名只读官方） */
const viewerId = ref<number | null>(null)
/** 课时 subjectId → {badge}，喂给 SubjectDirectory 显"N版"徽标 */
const lessonMeta = computed<Record<string, { badge: string }>>(() => {
  const m: Record<string, { badge: string }> = {}
  for (const l of lessons.value) m[l.lessonId] = { badge: `${l.sources.length}版` }
  return m
})

// ── KG 知识点索引（编辑保存重切片段用：课时L4 id → 子知识点 [{id,title}]，D13）──
const kpByLesson = ref<Record<string, { id: string; title: string }[]>>({})
function indexKps(nodes: SubjectNode[]) {
  for (const n of nodes) {
    if (n.id?.length === 12 && n.children?.length) {
      kpByLesson.value[n.id] = n.children
        .filter((c) => c.id?.length === 15)
        .map((c) => ({ id: c.id, title: (c.title ?? '').trim() }))
    }
    if (n.children?.length) indexKps(n.children)
  }
}

// ── 当前课时 / 来源 ────────────────────────────────────────────────
const currentLesson = ref<CatalogLesson | null>(null)
const sources = ref<LectureSource[]>([])
const activeSourceIdx = ref(0)
const courseTitle = ref('')
const emptyHint = ref<string | null>('从左侧目录选择一个课时，查看它的讲义')
const loading = ref(false)

const curIndex = computed(() =>
  currentLesson.value ? lessons.value.findIndex((l) => l.lessonId === currentLesson.value!.lessonId) : -1,
)
const hasPrev = computed(() => curIndex.value > 0)
const hasNext = computed(() => curIndex.value >= 0 && curIndex.value < lessons.value.length - 1)

// ── Umo 只读 ───────────────────────────────────────────────────────
const editorRef = ref<InstanceType<typeof UmoEditor> | null>(null)
const docJson = ref<object | null>(null)
const readonlyConfig = {
  extensions: KG_NODE_EXTENSIONS,
  document: { title: '', readOnly: true },
  page: { showToc: true }, // Umo 自带大纲默认展开（读态用 CSS 藏掉，编辑态可见）
  assistant: false,
  locale: 'zh-CN',
}

/** Umo 媒体节点（image/video/audio/file）自带 uploaded 标记：录入的图是现成 OSS URL、不走 Umo 上传回调，
 *  uploaded=false 会让编辑态 NodeView 挂一根永远走不完的上传进度条 → 灌前统一补 true */
function markMediaUploaded(node: unknown): void {
  if (!node || typeof node !== 'object') return
  const n = node as { type?: string; attrs?: Record<string, unknown>; content?: unknown[] }
  if (n.attrs && (n.type === 'image' || n.type === 'video' || n.type === 'audio' || n.type === 'file')) {
    if (n.attrs.src || n.attrs.url) { n.attrs.uploaded = true; n.attrs.error = false }
  }
  n.content?.forEach(markMediaUploaded)
}

/** 灌内容（切课时可反复调，非一次性）；编辑器未就绪则退避重试。沿用旧 kg-lecture 的内联取 editor 模式。 */
function applyDoc(tries = 0) {
  const editor = editorRef.value?.useEditor?.()
  if (!editor) {
    if (tries < 20) setTimeout(() => applyDoc(tries + 1), 120)
    return
  }
  if (docJson.value) markMediaUploaded(docJson.value)
  editor.commands.setContent((docJson.value ?? { type: 'doc', content: [] }) as Parameters<typeof editor.commands.setContent>[0])
  scheduleToc()
}

// ── 加载 ───────────────────────────────────────────────────────────
/** 点左树某节点：课时→整份讲义（空课时也进，可新建）；知识点→单片段；章/节→提示 */
async function onSelectNode(id: string | null) {
  if (!id || editing.value) return
  const lesson = lessons.value.find((l) => l.lessonId === id)
  if (lesson) { selectLesson(lesson); return }
  if (id.length === 15) { // 知识点 L5：看单个片段
    currentLesson.value = null; sources.value = []
    await loadLecture(id, BOOK_ID, undefined, true)
    return
  }
  if (id.length === 12) { // 课时但未挂讲义：也选中（登录后可"新建我的讲义"）
    currentLesson.value = { lessonId: id, lessonName: '', sources: [] }
    sources.value = []
    activeSourceIdx.value = 0
    await loadLecture(id, BOOK_ID)
    return
  }
  resetToHint('请在左侧展开到具体课时查看讲义')
}

function selectLesson(lesson: CatalogLesson) {
  currentLesson.value = lesson
  sources.value = lesson.sources
  activeSourceIdx.value = 0
  // 默认视图不传 owner（BE 覆盖序 我的>本部门管理员>官方）
  loadLecture(lesson.lessonId, lesson.sources[0]?.bookId ?? BOOK_ID)
}

function switchSource(idx: number) {
  if (idx === activeSourceIdx.value || !currentLesson.value || editing.value) return
  activeSourceIdx.value = idx
  const s = sources.value[idx]
  loadLecture(currentLesson.value.lessonId, s.bookId, s.owner)
}

async function loadLecture(subjectId: string, bookId: string, owner?: number, isKnowledge = false) {
  loading.value = true
  emptyHint.value = null
  try {
    const res = await getLecture(subjectId, bookId, owner)
    docJson.value = res.docJson ?? null
    courseTitle.value = res.node?.name ?? ''
    if (currentLesson.value && !currentLesson.value.lessonName && res.node?.name) {
      currentLesson.value.lessonName = res.node.name
    }
    if (!docJson.value) {
      resetToHint(isKnowledge ? '该知识点暂无讲义片段' : '该课时暂无讲义（待录入）')
      return
    }
    await nextTick()
    applyDoc()
  } catch {
    resetToHint('讲义加载失败，请刷新重试')
  } finally {
    loading.value = false
  }
}

function resetToHint(msg: string) {
  docJson.value = null
  courseTitle.value = ''
  toc.value = []
  emptyHint.value = msg
}

function goPrev() { if (hasPrev.value && !editing.value) selectLesson(lessons.value[curIndex.value - 1]) }
function goNext() { if (hasNext.value && !editing.value) selectLesson(lessons.value[curIndex.value + 1]) }

// ── ✎ 编辑态（D13 整课时编辑 + 保存自动重切片段；D14 自由 H3 归所在片段）──────
const editing = ref(false)
const saving = ref(false)
/** 进编辑时的每节点片段快照（subjectId → JSON 串）；保存时 diff 只落有改动的（D13） */
let editSnapshot: Record<string, string> = {}

const canEdit = computed(() => !!viewerId.value && !!currentLesson.value && currentLesson.value.lessonId.length === 12)
const activeSource = computed<LectureSource | null>(() => sources.value[activeSourceIdx.value] ?? null)

function setEditorReadOnly(ro: boolean) {
  const inst = editorRef.value as unknown as { setReadOnly?: (v: boolean) => void } | null
  if (inst?.setReadOnly) { inst.setReadOnly(ro); return }
  const editor = editorRef.value?.useEditor?.()
  editor?.setEditable(!ro)
}

/** Tiptap doc → 按 H3↔KG 知识点切片段（镜像 V0 迁移切分器；H2 组头折进组首知识点；未匹配 H3 归当前片段=D14） */
function splitDoc(doc: { type: string; content?: unknown[] }, lessonId: string): Record<string, { title: string; nodes: unknown[] }> {
  const kps = kpByLesson.value[lessonId] ?? []
  const kpByName: Record<string, string> = {}
  for (const k of kps) kpByName[k.title] = k.id
  const kpTitleById: Record<string, string> = {}
  for (const k of kps) kpTitleById[k.id] = k.title

  const frags: Record<string, { title: string; nodes: unknown[] }> = {}
  const ensure = (sid: string, title: string) => (frags[sid] ??= { title, nodes: [] })
  let cur = lessonId
  ensure(lessonId, currentLesson.value?.lessonName ?? '')
  let pendingH2: unknown | null = null
  const text = (n: Record<string, unknown>): string =>
    ((n.content as Record<string, unknown>[] | undefined) ?? [])
      .map((c) => (c.type === 'text' ? String(c.text ?? '') : text(c))).join('')

  for (const raw of doc.content ?? []) {
    const n = raw as Record<string, unknown>
    const lv = n.type === 'heading' ? (n.attrs as Record<string, unknown>)?.level : null
    if (lv === 2) { pendingH2 = n; continue }
    if (lv === 3) {
      const kid = kpByName[text(n).trim()]
      if (kid) { // 匹配 KG 知识点 → 新片段边界
        cur = kid
        ensure(kid, kpTitleById[kid])
        if (pendingH2) { frags[kid].nodes.push(pendingH2); pendingH2 = null }
        frags[kid].nodes.push(n)
        continue
      }
      // D14：KG 没有的自由 H3 不成为边界，作为普通内容归入当前片段
    }
    if (pendingH2) { frags[cur].nodes.push(pendingH2); pendingH2 = null }
    frags[cur].nodes.push(n)
  }
  if (pendingH2) frags[cur].nodes.push(pendingH2)
  return frags
}

function fragKey(nodes: unknown[]): string {
  return JSON.stringify({ type: 'doc', content: nodes })
}

function enterEdit() {
  if (!canEdit.value) return
  const editor = editorRef.value?.useEditor?.()
  if (!editor || !currentLesson.value) return
  // 安全闸：切分器依赖该课时的 KG 知识点索引；没有则整份 doc 会塌进课时片段（与官方知识点片段叠加=重复渲染），禁止进入
  if (!kpByLesson.value[currentLesson.value.lessonId]?.length) {
    ElMessage.warning('该课时的知识点索引未就绪（KG 无子知识点或目录树未加载），暂不能编辑')
    return
  }
  if (!docJson.value) { // 空课时新建：喂空 doc
    editor.commands.setContent({ type: 'doc', content: [] } as Parameters<typeof editor.commands.setContent>[0])
    emptyHint.value = null
    docJson.value = { type: 'doc', content: [] }
  }
  // 快照取自编辑器（与保存同经 Tiptap 归一化 → 未动的节点 diff 必然相等）
  const snap = splitDoc(editor.getJSON() as { type: string; content?: unknown[] }, currentLesson.value.lessonId)
  editSnapshot = {}
  for (const [sid, f] of Object.entries(snap)) editSnapshot[sid] = fragKey(f.nodes)
  setEditorReadOnly(false)
  editing.value = true
}

function cancelEdit() {
  editing.value = false
  setEditorReadOnly(true)
  if (currentLesson.value) {
    const s = activeSource.value
    loadLecture(currentLesson.value.lessonId, s?.bookId ?? BOOK_ID, s?.owner)
  }
}

async function saveEdit() {
  const editor = editorRef.value?.useEditor?.()
  if (!editor || !currentLesson.value || viewerId.value == null) return
  const lessonId = currentLesson.value.lessonId
  const split = splitDoc(editor.getJSON() as { type: string; content?: unknown[] }, lessonId)
  const changed: LectureFragSave[] = []
  for (const [sid, f] of Object.entries(split)) {
    const key = fragKey(f.nodes)
    if (editSnapshot[sid] !== key && (f.nodes.length > 0 || editSnapshot[sid])) {
      changed.push({ subjectId: sid, title: f.title, contentJson: JSON.parse(key) })
    }
  }
  if (!changed.length) { ElMessage.info('没有改动'); return }

  // 目标归属：当前源是我的→存我；否则默认"保存为我的版本"（fork），管理员可选存到当前源名下
  const src = activeSource.value
  let targetOwner: number | undefined
  const isAdmin = userStore.roles.includes('superadmin') || userStore.roles.includes('org_admin')
  if (src && src.owner !== viewerId.value && isAdmin) {
    try {
      await ElMessageBox.confirm(
        `改动 ${changed.length} 个知识点片段。保存为我的版本（推荐），还是直接保存到「${src.ownerName ?? src.owner}」名下？`,
        '保存讲义',
        { confirmButtonText: '保存为我的版本', cancelButtonText: `存到${src.ownerName ?? '对方'}名下`, distinguishCancelAndClose: true, type: 'info' },
      )
      targetOwner = undefined // 我的
    } catch (action) {
      if (action !== 'cancel') return // 右上角关闭 = 放弃
      targetOwner = src.owner // 管理员在位改（BE 判权，官方 uid1 仅本人）
    }
  }

  saving.value = true
  try {
    const res = await saveLectureFrags(src?.bookId ?? BOOK_ID, changed, targetOwner)
    if (res.ok) {
      ElMessage.success(`已保存 ${res.stats.ok} 个片段${targetOwner == null ? '（我的版本）' : ''}`)
      editing.value = false
      setEditorReadOnly(true)
      await reloadCatalog()
      loadLecture(lessonId, src?.bookId ?? BOOK_ID) // 回默认视图（我的>管理员>官方）
    } else {
      const bad = res.results.filter((r) => r.action === 'fail')
      ElMessage.error(`部分失败：${bad.map((b) => b.reason).join('；')}`)
    }
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败（无权限或网络异常）')
  } finally {
    saving.value = false
  }
}

// ── 沉浸式编辑：插入自定义节点（移植自 kg-lecture-edit，含防吞卡 insertContentAt 修法）──
dict.load(DICT_QUESTION_TYPE)
function insertNode(type: string, attrs: Record<string, string>) {
  const editor = editorRef.value?.useEditor?.()
  if (!editor) return
  // 🔴 insertContentAt(selection.to) 而非 insertContent：后者=替换选区，光标停在原子卡上会静默吞卡
  editor.chain().focus().insertContentAt(editor.state.selection.to, { type, attrs }).run()
}
function insertKgMindmap() {
  insertNode('kgMindmap', {
    data: JSON.stringify({
      text: '思维导图根节点',
      children: [
        { text: '分支 A', color: '#ef4444', children: [{ text: '叶节点', detail: '说明' }] },
        { text: '分支 B', color: '#3b82f6', children: [] },
      ],
    }),
  })
}
// 名师解读/记忆框插入按钮已按维护者要求移除（2026-07-03）；节点扩展保留——存量内容仍要能渲染

// 例题选题器：搜题库选题插入（例题只存 qid，三位一体铁律）
const pickerVisible = ref(false)
const pickerKeyword = ref('')
const pickerLoading = ref(false)
const pickerList = ref<QuestionItem[]>([])
async function searchPicker() {
  pickerLoading.value = true
  try {
    const res = await questionPage({ pageIndex: 1, pageSize: 8, keyWord: pickerKeyword.value.trim() || undefined })
    pickerList.value = res.list ?? []
  } catch { pickerList.value = [] } finally { pickerLoading.value = false }
}
function insertKgExample() {
  pickerVisible.value = true
  if (!pickerList.value.length) searchPicker()
}
function pickQuestion(q: QuestionItem) {
  insertNode('kgExample', { qid: String(q.id), knowledgeId: q.subjectId ?? currentLesson.value?.lessonId ?? '' })
  pickerVisible.value = false
  ElMessage.success('例题已插入')
}
function pickerStem(q: QuestionItem): string {
  const raw = q.stemTextContent || q.stemText || ''
  return raw.replace(/<[^>]+>/g, ' ').trim() || '（无题干文本，图片题）'
}

// ── 本课目录（TOC）：复用 kg-lecture 的 scrollBy 循环逼近，驯 Umo 封闭滚动 ──
interface TocItem { level: number; text: string; index: number }
const toc = ref<TocItem[]>([])
const activeIndex = ref(-1)
let scrollHost: HTMLElement | null = null
let spyRaf = 0
let spyLocked = false

function editorHeadings(): NodeListOf<HTMLHeadingElement> | null {
  const root = document.querySelector('.lh-umo-wrap')
  return root ? root.querySelectorAll<HTMLHeadingElement>('h1,h2,h3,h4,h5,h6') : null
}
function scheduleToc() {
  let tries = 0
  const tryBuild = () => { buildToc(); if (toc.value.length === 0 && tries++ < 8) setTimeout(tryBuild, 250) }
  setTimeout(tryBuild, 350)
}
function buildToc() {
  if (scrollHost) { scrollHost.removeEventListener('scroll', onEditorScroll); scrollHost = null }
  const hs = editorHeadings()
  if (!hs || hs.length === 0) { toc.value = []; return }
  toc.value = Array.from(hs).map((h, i) => ({ level: Number(h.tagName[1]), text: (h.textContent ?? '').trim(), index: i }))
  activeIndex.value = 0
  bindScrollSpy(hs[0], 0)
}
function bindScrollSpy(h: HTMLElement, tries: number) {
  const host = findScrollParent(h)
  if (host) { scrollHost = host; host.addEventListener('scroll', onEditorScroll, { passive: true }) }
  else if (tries < 12) setTimeout(() => bindScrollSpy(h, tries + 1), 300)
}
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null
  while (node) {
    const oy = getComputedStyle(node).overflowY
    if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight) return node
    node = node.parentElement
  }
  return null
}
function scrollToHeading(item: TocItem) {
  const hs = editorHeadings()
  const h = hs?.[item.index]
  if (!h) return
  const host = findScrollParent(h) ?? scrollHost
  if (!host) { h.scrollIntoView({ behavior: 'smooth', block: 'start' }); activeIndex.value = item.index; return }
  spyLocked = true
  let steps = 0
  const step = () => {
    const delta = h.getBoundingClientRect().top - host.getBoundingClientRect().top - 12
    if (Math.abs(delta) <= 4 || steps >= 28) { setTimeout(() => { spyLocked = false }, 300); return }
    host.scrollBy(0, delta); steps += 1; setTimeout(step, 90)
  }
  step()
  activeIndex.value = item.index
}
function onEditorScroll() {
  if (spyLocked || spyRaf) return
  spyRaf = requestAnimationFrame(() => {
    spyRaf = 0
    const hs = editorHeadings()
    if (!hs) return
    const hostTop = (scrollHost ?? document.documentElement).getBoundingClientRect().top
    let cur = 0
    for (let i = 0; i < hs.length; i++) { if (hs[i].getBoundingClientRect().top - hostTop <= 12) cur = i; else break }
    activeIndex.value = cur
  })
}

// ── 初始化 ─────────────────────────────────────────────────────────
async function reloadCatalog() {
  const cat = await getLectureCatalog(BOOK_ID)
  lessons.value = cat.lessons ?? []
  viewerId.value = (cat as unknown as { viewer: number | null }).viewer ?? null
  // 同步当前课时的 sources（保存后可能多出"我的版"）
  if (currentLesson.value) {
    const l = lessons.value.find((x) => x.lessonId === currentLesson.value!.lessonId)
    if (l) { currentLesson.value = l; sources.value = l.sources }
  }
}

onMounted(async () => {
  try {
    await reloadCatalog()
  } catch {
    ElMessage.warning('讲义目录加载失败')
  }
  // KG 知识点索引（切分器用）；失败仅禁编辑不影响浏览
  try {
    const roots = await lazyTree(0, false)
    indexKps(Array.isArray(roots) ? roots : [])
  } catch { /* 编辑保存前会再校验 */ }
})
onBeforeUnmount(() => { if (scrollHost) scrollHost.removeEventListener('scroll', onEditorScroll) })
</script>

<template>
  <div class="lh-page" :class="{ immersive: editing }">
    <!-- 左·教辅结构树（复用题库目录，讲义装饰）；编辑态收起=沉浸式 -->
    <aside v-show="!editing" class="lh-left">
      <SubjectDirectory :lesson-meta="lessonMeta" dim-uncovered @select="onSelectNode" />
    </aside>

    <!-- 中·讲义 -->
    <section class="lh-center">
      <!-- 顶栏：来源切换 + 标题 + 上/下课时 + 编辑 -->
      <header class="lh-bar">
        <div class="lh-bar-l">
          <template v-if="sources.length">
            <span class="lh-bar-lab">讲义来源</span>
            <div class="lh-src">
              <button
                v-for="(s, i) in sources" :key="s.bookId + s.owner"
                class="lh-src-tab" :class="{ on: i === activeSourceIdx }" :disabled="editing"
                :title="s.owner === 1 ? s.bookName : s.ownerName" @click="switchSource(i)"
              >{{ s.owner === 1 ? `📗 ${s.bookName}` : s.owner === viewerId ? '👤 我的版' : `👥 ${s.ownerName}` }}</button>
            </div>
          </template>
          <span v-else class="lh-bar-lab muted">讲义浏览</span>
        </div>
        <!-- 编辑态：插入自定义节点快捷条（沉浸式，移植自旧课件编辑页） -->
        <div v-if="editing" class="lh-insert">
          <span class="lh-insert-lab">插入</span>
          <button class="lh-ins-btn mm" @click="insertKgMindmap">思维导图</button>
          <button class="lh-ins-btn ex" @click="insertKgExample">例题卡</button>
        </div>
        <div class="lh-bar-r">
          <span v-if="editing" class="lh-editing-tag">编辑中</span>
          <span v-if="courseTitle" class="lh-course">{{ courseTitle }}</span>
          <div v-if="currentLesson && !editing" class="lh-nav">
            <button :disabled="!hasPrev" title="上一课时" @click="goPrev"><el-icon><ArrowLeftBold /></el-icon></button>
            <button :disabled="!hasNext" title="下一课时" @click="goNext"><el-icon><ArrowRightBold /></el-icon></button>
          </div>
          <template v-if="editing">
            <button class="lh-save" :disabled="saving" @click="saveEdit"><el-icon><Check /></el-icon>{{ saving ? '保存中…' : '保存' }}</button>
            <button class="lh-cancel" :disabled="saving" @click="cancelEdit"><el-icon><Close /></el-icon>取消</button>
          </template>
          <button v-else-if="docJson && canEdit" class="lh-edit" title="编辑（改动只落有变化的知识点片段）" @click="enterEdit"><el-icon><Edit /></el-icon>编辑</button>
        </div>
      </header>

      <!-- 内容区 -->
      <div class="lh-body">
        <div v-if="emptyHint" class="lh-empty">
          <el-icon class="ic"><Document /></el-icon>
          <p>{{ emptyHint }}</p>
          <button v-if="canEdit && !docJson" class="lh-new" @click="enterEdit">＋ 新建我的讲义</button>
        </div>
        <div v-show="!emptyHint || editing" v-loading="loading" class="lh-umo-wrap" :class="{ editing }">
          <UmoEditor ref="editorRef" v-bind="readonlyConfig" />
        </div>
      </div>
    </section>

    <!-- 右·本课目录；编辑态收起=沉浸式 -->
    <aside v-show="!editing" class="lh-right">
      <div class="lh-toc-head">本课目录</div>
      <nav v-if="toc.length" class="lh-toc-list">
        <button
          v-for="item in toc" :key="item.index" type="button"
          class="lh-toc-item" :class="[`lv-${item.level}`, { active: item.index === activeIndex }]"
          :title="item.text" @click="scrollToHeading(item)"
        >{{ item.text }}</button>
      </nav>
      <div v-else class="lh-toc-empty">选择课时后<br>显示本课小节目录</div>
    </aside>

    <!-- 例题选题器（编辑态插入例题卡用；只存 qid） -->
    <el-dialog v-model="pickerVisible" title="从题库选例题" width="640px" append-to-body>
      <div class="lh-picker-search">
        <el-input v-model="pickerKeyword" placeholder="关键字搜题干…" clearable size="default" @keyup.enter="searchPicker" />
        <el-button type="primary" :loading="pickerLoading" @click="searchPicker">搜索</el-button>
      </div>
      <div v-loading="pickerLoading" class="lh-picker-list">
        <div v-for="q in pickerList" :key="String(q.id)" class="lh-picker-item" @click="pickQuestion(q)">
          <span class="lh-picker-type">{{ dict.label(DICT_QUESTION_TYPE, q.questionType) || '题' }}</span>
          <span class="lh-picker-stem">{{ pickerStem(q) }}</span>
        </div>
        <div v-if="!pickerLoading && !pickerList.length" class="lh-picker-empty">没有匹配的题，换个关键字试试</div>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.lh-page { display: flex; gap: 12px; height: calc(100vh - 60px); padding: 12px; background: #f4f7f7; overflow: hidden; box-sizing: border-box; }
.lh-left { width: 300px; flex-shrink: 0; height: 100%; }
.lh-right { width: 232px; flex-shrink: 0; height: 100%; background: #fff; border: 1px solid var(--bk-line); border-radius: 12px; box-shadow: 0 1px 3px rgba(22, 36, 42, .05); display: flex; flex-direction: column; overflow: hidden; }
.lh-center { flex: 1; min-width: 0; height: 100%; background: #fff; border: 1px solid var(--bk-line); border-radius: 12px; box-shadow: 0 1px 3px rgba(22, 36, 42, .05); display: flex; flex-direction: column; overflow: hidden; }

/* 顶栏 */
.lh-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 14px; border-bottom: 1px solid #eef2f2; flex-shrink: 0; min-height: 46px; }
.lh-bar-l { display: flex; align-items: center; gap: 9px; min-width: 0; }
.lh-bar-lab { font-size: 11px; font-weight: 700; letter-spacing: .5px; color: #7c8a90; flex-shrink: 0; }
.lh-bar-lab.muted { color: #a8b2b6; }
.lh-src { display: flex; gap: 6px; overflow-x: auto; }
.lh-src-tab { border: 1px solid #e3e9e9; background: #fafdfd; color: #536268; font-size: 12px; font-weight: 600; padding: 5px 12px; border-radius: 999px; cursor: pointer; white-space: nowrap; transition: .15s; max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
.lh-src-tab:hover { border-color: var(--bk-teal); color: var(--bk-teal); }
.lh-src-tab.on { background: var(--bk-teal); border-color: var(--bk-teal); color: #fff; }
.lh-bar-r { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.lh-course { font-size: 14px; font-weight: 700; color: var(--bk-ink); max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lh-nav { display: flex; gap: 4px; }
.lh-nav button { width: 28px; height: 28px; border: 1px solid #e3e9e9; background: #fff; border-radius: 7px; color: #536268; cursor: pointer; display: grid; place-items: center; transition: .15s; }
.lh-nav button:hover:not(:disabled) { border-color: var(--bk-teal); color: var(--bk-teal); }
.lh-nav button:disabled { opacity: .4; cursor: not-allowed; }
.lh-edit { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--bk-teal); background: var(--bk-teal-soft); color: var(--bk-teal); font-size: 12.5px; font-weight: 600; padding: 5px 11px; border-radius: 7px; cursor: pointer; transition: .15s; }
.lh-edit:hover { background: var(--bk-teal-soft); opacity: .8; }

/* 内容区 */
.lh-body { position: relative; flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.lh-umo-wrap { flex: 1; overflow: hidden; min-height: 0; }
/* 只读：隐藏 Umo 编辑工具栏 + 页脚水印（编辑态放出工具栏）。本页 flex 结构下 display:none
   不塌陷滚动容器（Playwright 实测 umo-main 撑满全高），AC6 只读无工具栏。 */
.lh-umo-wrap:not(.editing) :deep(.umo-toolbar) { display: none; }
.lh-umo-wrap:not(.editing) :deep(.umo-footer) { display: none; }
/* Umo 自带页面大纲：只在编辑态展示（page.showToc=true 默认展开），查看态有右栏"本课目录"不重复 */
.lh-umo-wrap:not(.editing) :deep(.umo-toc-container) { display: none; }

/* 编辑态控件 */
.lh-editing-tag { font-size: 11px; font-weight: 700; color: #b45309; background: #fef3c7; padding: 3px 9px; border-radius: 999px; }
.lh-save { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--bk-teal); background: var(--bk-teal); color: #fff; font-size: 12.5px; font-weight: 600; padding: 5px 13px; border-radius: 7px; cursor: pointer; transition: .15s; }
.lh-save:hover:not(:disabled) { background: var(--bk-teal-deep, #0B5D56); }
.lh-save:disabled { opacity: .6; cursor: not-allowed; }
.lh-cancel { display: inline-flex; align-items: center; gap: 4px; border: 1px solid #e3e9e9; background: #fff; color: #536268; font-size: 12.5px; font-weight: 600; padding: 5px 11px; border-radius: 7px; cursor: pointer; transition: .15s; }
.lh-cancel:hover:not(:disabled) { border-color: #cbd5d5; }
.lh-src-tab:disabled { opacity: .55; cursor: not-allowed; }
.lh-new { border: 1px dashed var(--bk-teal); background: #f0faf9; color: var(--bk-teal-deep, #0B5D56); font-size: 13px; font-weight: 600; padding: 8px 18px; border-radius: 9px; cursor: pointer; transition: .15s; }
.lh-new:hover { background: var(--bk-teal-soft); }

/* 沉浸式编辑：左右栏收起，编辑器满幅 */
.lh-page.immersive { padding: 8px; gap: 0; }
.lh-page.immersive .lh-center { border-radius: 8px; }

/* 插入快捷条（编辑态） */
.lh-insert { display: flex; align-items: center; gap: 6px; }
.lh-insert-lab { font-size: 11px; font-weight: 700; letter-spacing: .5px; color: #7c8a90; }
.lh-ins-btn { border: 1px solid #e3e9e9; background: #fff; font-size: 12px; font-weight: 600; padding: 4px 11px; border-radius: 7px; cursor: pointer; transition: .15s; }
.lh-ins-btn.mm { color: var(--bk-teal); border-color: var(--bk-line); } .lh-ins-btn.mm:hover { background: var(--bk-teal-soft); }
.lh-ins-btn.ex { color: var(--bk-teal); border-color: var(--bk-line); } .lh-ins-btn.ex:hover { background: var(--bk-teal-soft); }

/* 例题选题器 */
.lh-picker-search { display: flex; gap: 8px; margin-bottom: 10px; }
.lh-picker-list { min-height: 120px; max-height: 380px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
.lh-picker-item { display: flex; gap: 8px; align-items: flex-start; border: 1px solid #eef1f1; border-radius: 8px; padding: 9px 11px; cursor: pointer; transition: .15s; }
.lh-picker-item:hover { border-color: var(--bk-teal); background: #f7fcfb; }
.lh-picker-type { flex-shrink: 0; font-size: 10.5px; font-weight: 700; color: var(--bk-teal-deep, #0B5D56); background: var(--bk-teal-soft); padding: 2px 7px; border-radius: 999px; }
.lh-picker-stem { font-size: 12.5px; color: #2c3b42; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.lh-picker-empty { text-align: center; color: #a8b2b6; font-size: 12.5px; padding: 30px 0; }
.lh-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: #a8b2b6; }
.lh-empty .ic { font-size: 40px; color: #cdd6d6; }
.lh-empty p { font-size: 13.5px; }

/* 本课目录 */
.lh-toc-head { font-size: 12px; font-weight: 700; letter-spacing: .08em; color: #64748b; padding: 14px 16px 10px; border-bottom: 1px solid #eef1f4; flex-shrink: 0; }
.lh-toc-list { flex: 1; overflow-y: auto; padding: 8px 8px 12px; display: flex; flex-direction: column; gap: 1px; }
.lh-toc-item { text-align: left; background: none; border: none; cursor: pointer; font-size: 13px; line-height: 1.5; color: #475569; padding: 6px 10px; border-radius: 6px; border-left: 2px solid transparent; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: background .12s, color .12s; }
.lh-toc-item:hover { background: var(--bk-teal-soft); color: var(--bk-ink); }
.lh-toc-item.active { background: var(--bk-teal-soft); color: var(--bk-teal); font-weight: 600; border-left-color: var(--bk-teal); }
.lh-toc-item.lv-1 { font-weight: 700; color: #1e293b; }
.lh-toc-item.lv-2 { font-weight: 600; }
.lh-toc-item.lv-3 { padding-left: 22px; font-size: 12.5px; }
.lh-toc-item.lv-4 { padding-left: 34px; font-size: 12.5px; color: #64748b; }
.lh-toc-item.lv-5 { padding-left: 46px; font-size: 12px; color: #94a3b8; }
.lh-toc-empty { padding: 26px 14px; text-align: center; color: #a8b2b6; font-size: 12px; line-height: 1.7; }
</style>
