<script setup lang="ts">
/**
 * 知识点讲义查看页（KG Lecture View）—— Umo 只读渲染版
 *
 * PRD-C-205：从「旧积木块 blocks 渲染」迁移到「UmoEditor readOnly 渲染 docJson」。
 *
 * 数据契约：GET /teacher/kg/doc/{courseId}?bookId=CC7S
 *   → { course: { id, name }, bookId, docJson }（misikt envelope，code===1 取 response）
 *
 * docJson 为 null 时（该课时尚未创建文档）：降级显示旧 blocks 内容（若接口可用）
 * 或显示空状态提示。
 *
 * 依赖 KG_NODE_EXTENSIONS（自定义节点，UmoEditor readOnly 渲染时也需要注册扩展）。
 */
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { UmoEditor } from '@umoteam/editor'
import { ElLoading } from 'element-plus'
import { KG_NODE_EXTENSIONS } from '@/extensions/kg-nodes/index'
import { getKgDoc } from '@/api/kg/doc'

// ── 常量 ─────────────────────────────────────────────────────────────────────
// 2026-07-02 定稿:讲义挂 KG「节」(L3)+lesson_no,课时不再是 KG 节点(PRD-C-206 P2)
const COURSE_ID = '901001002'
const BOOK_ID = 'CC7S'

// ── 状态 ─────────────────────────────────────────────────────────────────────
const editorRef = ref<InstanceType<typeof UmoEditor> | null>(null)
const courseTitle = ref('')
const docJson = ref<object | null>(null)
const errorMsg = ref<string | null>(null)
const docLoaded = ref(false) // 是否将内容灌入编辑器（只灌一次）

// ── 目录（TOC）：从渲染后编辑器 DOM 的 h1~h6 提取，点击滚动定位 ──
interface TocItem {
  level: number
  text: string
  index: number
}
const toc = ref<TocItem[]>([])
const activeIndex = ref<number>(-1)
let scrollHost: HTMLElement | null = null

function editorHeadings(): NodeListOf<HTMLHeadingElement> | null {
  const root = document.querySelector('.kg-lecture-umo-wrap')
  return root ? root.querySelectorAll<HTMLHeadingElement>('h1,h2,h3,h4,h5,h6') : null
}

function buildToc() {
  const hs = editorHeadings()
  if (!hs || hs.length === 0) {
    toc.value = []
    return
  }
  toc.value = Array.from(hs).map((h, i) => ({
    level: Number(h.tagName[1]),
    text: (h.textContent ?? '').trim(),
    index: i,
  }))
  // 绑 scroll-spy：Umo 容器异步定稿高度，可滚祖先可能还没就绪 → 重试直到找到
  bindScrollSpy(hs[0], 0)
}

function bindScrollSpy(h: HTMLElement, tries: number) {
  const host = findScrollParent(h)
  if (host) {
    scrollHost = host
    host.addEventListener('scroll', onEditorScroll, { passive: true })
  } else if (tries < 12) {
    setTimeout(() => bindScrollSpy(h, tries + 1), 300)
  }
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
  // 实时查找可滚容器（buildToc 时 Umo 可能尚未定稿高度，缓存的 scrollHost 可能为空）
  const host = findScrollParent(h) ?? scrollHost
  if (!host) {
    h.scrollIntoView({ behavior: 'smooth', block: 'start' })
    activeIndex.value = item.index
    return
  }
  // 🔴 Umo 的 zoomable 容器屏蔽程序化 scrollTop（赋值无效），只认 scrollBy 且单次调用被限幅 →
  // 用 scrollBy 循环逼近：每步按「heading 相对容器顶」的剩余差值滚一次，间隔 90ms 给 Umo 处理，
  // 直到对齐（留 12px，误差 ≤4）或达上限步数；期间题图懒加载撑高也被持续跟正。
  spyLocked = true
  let steps = 0
  const step = () => {
    const delta = h.getBoundingClientRect().top - host.getBoundingClientRect().top - 12
    if (Math.abs(delta) <= 4 || steps >= 28) {
      setTimeout(() => { spyLocked = false }, 300)
      return
    }
    host.scrollBy(0, delta)
    steps += 1
    setTimeout(step, 90)
  }
  step()
  activeIndex.value = item.index
}

// scroll-spy：滚动时高亮当前 heading（点击跳转期间锁定，避免中途误更新）
let spyRaf = 0
let spyLocked = false
function onEditorScroll() {
  if (spyLocked || spyRaf) return
  spyRaf = requestAnimationFrame(() => {
    spyRaf = 0
    const hs = editorHeadings()
    if (!hs) return
    const hostTop = (scrollHost ?? document.documentElement).getBoundingClientRect().top
    let cur = 0
    for (let i = 0; i < hs.length; i++) {
      if (hs[i].getBoundingClientRect().top - hostTop <= 12) cur = i
      else break
    }
    activeIndex.value = cur
  })
}

// ── Umo 只读配置（readOnly: true） ────────────────────────────────────────────
// 🔴 只读：document.readOnly=true，不传工具栏相关配置
const readonlyConfig = {
  extensions: KG_NODE_EXTENSIONS,
  document: {
    title: '',
    readOnly: true,
  },
  assistant: false,
  locale: 'zh-CN',
}

// ── 数据加载 ──────────────────────────────────────────────────────────────────
async function loadDoc() {
  errorMsg.value = null
  const loadingInstance = ElLoading.service({
    text: '讲义加载中…',
    background: 'rgba(255,255,255,0.85)',
  })
  try {
    const res = await getKgDoc(COURSE_ID, BOOK_ID)
    courseTitle.value = res.course?.name ?? ''
    docJson.value = res.docJson ?? null
  } catch (e: unknown) {
    errorMsg.value = e instanceof Error ? e.message : '加载失败，请刷新重试'
  } finally {
    loadingInstance.close()
  }
}

// ── 编辑器就绪后灌入内容 ──────────────────────────────────────────────────────
// UmoEditor 的 ready 事件或 onMounted 后 editorRef 可用时执行。
// 注意：Umo 内部组件初始化可能异步，用 requestAnimationFrame 兜底一次。
function applyContent() {
  if (docLoaded.value) return
  if (!editorRef.value) return
  if (!docJson.value) return
  const editor = editorRef.value.useEditor()
  if (!editor) return
  editor.commands.setContent(docJson.value as Parameters<typeof editor.commands.setContent>[0])
  docLoaded.value = true
}

onMounted(async () => {
  await loadDoc()
  // 等 Umo 挂载完再设内容（requestAnimationFrame 确保 DOM 已稳定）
  requestAnimationFrame(() => {
    applyContent()
    // 如果首帧 editor 还没就绪，再等一拍
    if (!docLoaded.value) {
      setTimeout(applyContent, 300)
    }
    // 内容渲染后提取目录（heading 渲染需要一点时间，多探几次直到拿到）
    let tries = 0
    const tryBuild = () => {
      buildToc()
      if (toc.value.length === 0 && tries++ < 8) setTimeout(tryBuild, 250)
    }
    setTimeout(tryBuild, 400)
  })
})

onBeforeUnmount(() => {
  if (scrollHost) scrollHost.removeEventListener('scroll', onEditorScroll)
})
</script>

<template>
  <div class="kg-lecture-page">

    <!-- 课时标题行 -->
    <div v-if="courseTitle" class="kg-lecture-title-bar">
      <h4 class="h-course">{{ courseTitle }}</h4>
    </div>

    <!-- 错误提示 -->
    <div v-if="errorMsg" class="error-tip">{{ errorMsg }}</div>

    <!-- docJson 为空时的空状态 -->
    <div v-else-if="docJson === null && !errorMsg" class="empty-state">
      该课时暂无课件内容，请前往
      <a href="#/kg-lecture-edit" class="edit-link">课件编辑页</a>
      创建。
    </div>

    <!-- 内容区（相对定位容器）：Umo 渲染 + 浮动目录卡片 -->
    <div v-else class="kg-lecture-body">
      <!-- 浮动目录卡片：贴内容区左侧空白，随文档滚动定位 -->
      <aside v-if="toc.length > 0" class="kg-toc">
        <div class="kg-toc-title">目录</div>
        <nav class="kg-toc-list">
          <button
            v-for="item in toc"
            :key="item.index"
            type="button"
            class="kg-toc-item"
            :class="[`lv-${item.level}`, { active: item.index === activeIndex }]"
            :title="item.text"
            @click="scrollToHeading(item)"
          >
            {{ item.text }}
          </button>
        </nav>
      </aside>

      <!-- Umo 只读渲染 -->
      <div class="kg-lecture-umo-wrap">
        <UmoEditor
          ref="editorRef"
          v-bind="readonlyConfig"
        />
      </div>
    </div>

  </div>
</template>

<style scoped>
/* 内容区：相对定位容器，承载 Umo + 浮动目录 */
/* 🔴 必须 flex column：否则内部 umo-wrap 的 flex:1 失效、被内容撑开，Umo 滚动容器塌陷 */
.kg-lecture-body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* 浮动目录卡片：贴内容区左侧空白，不再是最外层全高栏 */
.kg-toc {
  position: absolute;
  top: 124px; /* 浮在 Umo 工具栏（约 111px 高）下方，避免遮挡 */
  left: 16px;
  z-index: 20;
  width: 216px;
  max-height: calc(100% - 140px);
  background: rgba(255, 255, 255, 0.96);
  backdrop-filter: blur(4px);
  border: 1px solid #e5e9ee;
  border-radius: 12px;
  box-shadow: 0 4px 20px rgba(30, 41, 59, 0.08);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.kg-toc-title {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #64748b;
  padding: 13px 16px 9px;
  border-bottom: 1px solid #eef1f4;
  flex-shrink: 0;
}

.kg-toc-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.kg-toc-item {
  text-align: left;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 13px;
  line-height: 1.5;
  color: #475569;
  padding: 6px 10px;
  border-radius: 6px;
  border-left: 2px solid transparent;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: background 0.12s, color 0.12s;
}

.kg-toc-item:hover {
  background: #eef2f7;
  color: #1e293b;
}

.kg-toc-item.active {
  background: #e0f2fe;
  color: #0369a1;
  font-weight: 600;
  border-left-color: #0ea5e9;
}

/* 层级缩进 */
.kg-toc-item.lv-1 { font-weight: 700; color: #1e293b; }
.kg-toc-item.lv-2 { font-weight: 600; padding-left: 10px; }
.kg-toc-item.lv-3 { padding-left: 24px; font-size: 12.5px; }
.kg-toc-item.lv-4 { padding-left: 38px; font-size: 12.5px; color: #64748b; }
.kg-toc-item.lv-5 { padding-left: 52px; font-size: 12px; color: #94a3b8; }

/* 页面根：全高单栏 */
.kg-lecture-page {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 60px);
  overflow: hidden;
  background: #ffffff;
}

/* 课时标题行 */
.kg-lecture-title-bar {
  padding: 0 24px;
  flex-shrink: 0;
}

.h-course {
  font-size: 22px;
  font-weight: 700;
  background: #1e293b;
  color: #fff;
  padding: 10px 16px;
  border-radius: 8px;
  margin: 16px 0 12px;
}

/* 错误提示 */
.error-tip {
  background: #fef2f2;
  border-left: 4px solid #dc2626;
  padding: 8px 24px;
  font-size: 14px;
  color: #991b1b;
  flex-shrink: 0;
}

/* 空状态 */
.empty-state {
  padding: 40px 24px;
  font-size: 15px;
  color: #64748b;
  text-align: center;
}

.edit-link {
  color: #2563eb;
  text-decoration: underline;
}

/* Umo 只读容器：撑满剩余高度 */
.kg-lecture-umo-wrap {
  flex: 1;
  overflow: hidden;
  min-height: 0;
}

</style>
