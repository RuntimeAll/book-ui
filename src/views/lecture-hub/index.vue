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
import { ElMessage } from 'element-plus'
import { Edit, ArrowLeftBold, ArrowRightBold, Document } from '@element-plus/icons-vue'
import SubjectDirectory from '@/components/business/SubjectDirectory/index.vue'
import { KG_NODE_EXTENSIONS } from '@/extensions/kg-nodes/index'
import {
  getLectureCatalog, getLecture,
  type CatalogLesson, type LectureSource,
} from '@/api/kg/lecture'

const BOOK_ID = 'CC7S'

// ── 目录数据（灰置 + 来源 + 上/下课时）─────────────────────────────
const lessons = ref<CatalogLesson[]>([])
/** 课时 subjectId → {badge}，喂给 SubjectDirectory 显"N版"徽标 */
const lessonMeta = computed<Record<string, { badge: string }>>(() => {
  const m: Record<string, { badge: string }> = {}
  for (const l of lessons.value) m[l.lessonId] = { badge: `${l.sources.length}版` }
  return m
})

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
  assistant: false,
  locale: 'zh-CN',
}

/** 等编辑器就绪后回调（切课时可反复灌内容，非一次性） */
function whenEditor(cb: (editor: ReturnType<InstanceType<typeof UmoEditor>['useEditor']>) => void, tries = 0) {
  const editor = editorRef.value?.useEditor?.()
  if (editor) cb(editor)
  else if (tries < 20) setTimeout(() => whenEditor(cb, tries + 1), 120)
}

function applyDoc() {
  whenEditor((editor) => {
    if (!editor) return
    editor.commands.setContent((docJson.value ?? { type: 'doc', content: [] }) as Parameters<typeof editor.commands.setContent>[0])
    scheduleToc()
  })
}

// ── 加载 ───────────────────────────────────────────────────────────
/** 点左树某节点：课时→整份讲义；知识点→单片段；章/节/未挂→提示 */
async function onSelectNode(id: string | null) {
  if (!id) return
  const lesson = lessons.value.find((l) => l.lessonId === id)
  if (lesson) { selectLesson(lesson); return }
  if (id.length === 15) { // 知识点 L5：看单个片段
    currentLesson.value = null; sources.value = []
    await loadLecture(id, BOOK_ID, true)
    return
  }
  if (id.length === 12) { // 课时但未挂讲义
    resetToHint('该课时暂无讲义（待录入）')
    return
  }
  resetToHint('请在左侧展开到具体课时查看讲义')
}

function selectLesson(lesson: CatalogLesson) {
  currentLesson.value = lesson
  sources.value = lesson.sources
  activeSourceIdx.value = 0
  loadLecture(lesson.lessonId, lesson.sources[0]?.bookId ?? BOOK_ID)
}

function switchSource(idx: number) {
  if (idx === activeSourceIdx.value || !currentLesson.value) return
  activeSourceIdx.value = idx
  loadLecture(currentLesson.value.lessonId, sources.value[idx].bookId)
}

async function loadLecture(subjectId: string, bookId: string, isKnowledge = false) {
  loading.value = true
  emptyHint.value = null
  try {
    const res = await getLecture(subjectId, bookId)
    docJson.value = res.docJson ?? null
    courseTitle.value = res.node?.name ?? ''
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

function goPrev() { if (hasPrev.value) selectLesson(lessons.value[curIndex.value - 1]) }
function goNext() { if (hasNext.value) selectLesson(lessons.value[curIndex.value + 1]) }
function onEditClick() { ElMessage.info('讲义编辑（复制为我的 / 直接改）即将开放') }

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
onMounted(async () => {
  try {
    const cat = await getLectureCatalog(BOOK_ID)
    lessons.value = cat.lessons ?? []
  } catch {
    ElMessage.warning('讲义目录加载失败')
  }
})
onBeforeUnmount(() => { if (scrollHost) scrollHost.removeEventListener('scroll', onEditorScroll) })
</script>

<template>
  <div class="lh-page">
    <!-- 左·教辅结构树（复用题库目录，讲义装饰） -->
    <aside class="lh-left">
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
                class="lh-src-tab" :class="{ on: i === activeSourceIdx }"
                :title="s.bookName" @click="switchSource(i)"
              >📗 {{ s.bookName }}</button>
            </div>
          </template>
          <span v-else class="lh-bar-lab muted">讲义浏览</span>
        </div>
        <div class="lh-bar-r">
          <span v-if="courseTitle" class="lh-course">{{ courseTitle }}</span>
          <div v-if="currentLesson" class="lh-nav">
            <button :disabled="!hasPrev" title="上一课时" @click="goPrev"><el-icon><ArrowLeftBold /></el-icon></button>
            <button :disabled="!hasNext" title="下一课时" @click="goNext"><el-icon><ArrowRightBold /></el-icon></button>
          </div>
          <button v-if="docJson" class="lh-edit" title="编辑（P2）" @click="onEditClick"><el-icon><Edit /></el-icon>编辑</button>
        </div>
      </header>

      <!-- 内容区 -->
      <div class="lh-body">
        <div v-if="emptyHint" class="lh-empty">
          <el-icon class="ic"><Document /></el-icon>
          <p>{{ emptyHint }}</p>
        </div>
        <div v-show="!emptyHint" v-loading="loading" class="lh-umo-wrap">
          <UmoEditor ref="editorRef" v-bind="readonlyConfig" />
        </div>
      </div>
    </section>

    <!-- 右·本课目录 -->
    <aside class="lh-right">
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
  </div>
</template>

<style scoped>
.lh-page { display: flex; gap: 12px; height: calc(100vh - 60px); padding: 12px; background: #f4f7f7; overflow: hidden; box-sizing: border-box; }
.lh-left { width: 300px; flex-shrink: 0; height: 100%; }
.lh-right { width: 232px; flex-shrink: 0; height: 100%; background: #fff; border: 1px solid #eef1f1; border-radius: 10px; box-shadow: 0 1px 3px rgba(22, 36, 42, .05); display: flex; flex-direction: column; overflow: hidden; }
.lh-center { flex: 1; min-width: 0; height: 100%; background: #fff; border: 1px solid #eef1f1; border-radius: 10px; box-shadow: 0 1px 3px rgba(22, 36, 42, .05); display: flex; flex-direction: column; overflow: hidden; }

/* 顶栏 */
.lh-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 14px; border-bottom: 1px solid #eef2f2; flex-shrink: 0; min-height: 46px; }
.lh-bar-l { display: flex; align-items: center; gap: 9px; min-width: 0; }
.lh-bar-lab { font-size: 11px; font-weight: 700; letter-spacing: .5px; color: #7c8a90; flex-shrink: 0; }
.lh-bar-lab.muted { color: #a8b2b6; }
.lh-src { display: flex; gap: 6px; overflow-x: auto; }
.lh-src-tab { border: 1px solid #e3e9e9; background: #fafdfd; color: #536268; font-size: 12px; font-weight: 600; padding: 5px 12px; border-radius: 999px; cursor: pointer; white-space: nowrap; transition: .15s; max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
.lh-src-tab:hover { border-color: #2ba3a3; color: #176e6e; }
.lh-src-tab.on { background: #1e8a8a; border-color: #1e8a8a; color: #fff; }
.lh-bar-r { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.lh-course { font-size: 14px; font-weight: 700; color: #16242a; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lh-nav { display: flex; gap: 4px; }
.lh-nav button { width: 28px; height: 28px; border: 1px solid #e3e9e9; background: #fff; border-radius: 7px; color: #536268; cursor: pointer; display: grid; place-items: center; transition: .15s; }
.lh-nav button:hover:not(:disabled) { border-color: #2ba3a3; color: #176e6e; }
.lh-nav button:disabled { opacity: .4; cursor: not-allowed; }
.lh-edit { display: inline-flex; align-items: center; gap: 4px; border: 1px solid #d9d5f6; background: #f4f2fe; color: #6357d6; font-size: 12.5px; font-weight: 600; padding: 5px 11px; border-radius: 7px; cursor: pointer; transition: .15s; }
.lh-edit:hover { background: #ebe8fc; }

/* 内容区 */
.lh-body { position: relative; flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.lh-umo-wrap { flex: 1; overflow: hidden; min-height: 0; }
/* 只读：隐藏 Umo 编辑工具栏 + 页脚水印。本页 .lh-umo-wrap(flex:1;min-height:0) 结构下 display:none
   不会塌陷滚动容器（已用 Playwright 实测 umo-main 撑满全高），故此处安全，AC6 只读无工具栏。 */
.lh-umo-wrap :deep(.umo-toolbar) { display: none; }
.lh-umo-wrap :deep(.umo-footer) { display: none; }
.lh-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: #a8b2b6; }
.lh-empty .ic { font-size: 40px; color: #cdd6d6; }
.lh-empty p { font-size: 13.5px; }

/* 本课目录 */
.lh-toc-head { font-size: 12px; font-weight: 700; letter-spacing: .08em; color: #64748b; padding: 14px 16px 10px; border-bottom: 1px solid #eef1f4; flex-shrink: 0; }
.lh-toc-list { flex: 1; overflow-y: auto; padding: 8px 8px 12px; display: flex; flex-direction: column; gap: 1px; }
.lh-toc-item { text-align: left; background: none; border: none; cursor: pointer; font-size: 13px; line-height: 1.5; color: #475569; padding: 6px 10px; border-radius: 6px; border-left: 2px solid transparent; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: background .12s, color .12s; }
.lh-toc-item:hover { background: #eef2f7; color: #1e293b; }
.lh-toc-item.active { background: #e0f2fe; color: #0369a1; font-weight: 600; border-left-color: #0ea5e9; }
.lh-toc-item.lv-1 { font-weight: 700; color: #1e293b; }
.lh-toc-item.lv-2 { font-weight: 600; }
.lh-toc-item.lv-3 { padding-left: 22px; font-size: 12.5px; }
.lh-toc-item.lv-4 { padding-left: 34px; font-size: 12.5px; color: #64748b; }
.lh-toc-item.lv-5 { padding-left: 46px; font-size: 12px; color: #94a3b8; }
.lh-toc-empty { padding: 26px 14px; text-align: center; color: #a8b2b6; font-size: 12px; line-height: 1.7; }
</style>
