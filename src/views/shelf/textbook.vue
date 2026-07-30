<script setup lang="ts">
/**
 * 电子课本阅读页（2026-07-30 课本展示改版 —— 用户拍板：单页翻页）。
 *
 * 交互：左=章目录（章名+起始页，当前章随翻页高亮联动，点章跳该章首页）；
 *       中=整页大图（等比适配一屏一页）+ ◀上一页/下一页▶ + 页码框直跳 + 键盘 ←/→；
 *       顶=返回/书名/第 x / N 页/下载整书 PDF（走既有 /book/{id}/export）。
 *
 * 数据：GET /teacher/shelf/book/{id}/pages 一次拉全书「章目录+页码→页图」表——
 *       零迁移（页图=题块整页图，页码=source_page），本页只管展示不碰题块语义。
 * 🔴 页图走 proxyImage（OSS Content-Disposition 拒渲防护）；前后各 1 页预加载防翻页白屏。
 *
 * 入口：书架 textbook 卡片「打开」分流（讲义/练习册仍走 book.vue 题块浏览页）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  getTextbookPages,
  exportBook,
  type TextbookPagesResult,
} from '@/api/shelf'
import { proxyImage } from '@/utils/image-proxy'

const route = useRoute()
const router = useRouter()
const bookId = String(route.params.id ?? '')

const loading = ref(true)
const data = ref<TextbookPagesResult | null>(null)
/** 当前页码（源书页码口径，与目录 startPage 同源） */
const cur = ref(1)

/** 页码→图 url 映射 + 有图页码升序表（页码可能不连续：无图页被跳过） */
const urlByPage = computed<Map<number, string>>(() => {
  const m = new Map<number, string>()
  for (const p of data.value?.pages ?? []) m.set(p.page, p.url)
  return m
})
const pageNos = computed<number[]>(() => (data.value?.pages ?? []).map((p) => p.page))
const curIdx = computed(() => pageNos.value.indexOf(cur.value))
const curUrl = computed(() => proxyImage(urlByPage.value.get(cur.value) ?? ''))

/** 当前章 = startPage ≤ 当前页 的最后一章（目录高亮联动） */
const activeChapter = computed(() => {
  let hit = ''
  for (const c of data.value?.chapters ?? []) {
    if (c.startPage <= cur.value) hit = c.nodeId
  }
  return hit
})

function jumpTo(page: number) {
  const nos = pageNos.value
  if (!nos.length) return
  // 落到最近的有图页（页码可能不连续）
  let target = nos[0]
  for (const n of nos) {
    if (n <= page) target = n
    else break
  }
  if (page > nos[nos.length - 1]) target = nos[nos.length - 1]
  cur.value = target
}

function prev() {
  if (curIdx.value > 0) cur.value = pageNos.value[curIdx.value - 1]
}
function next() {
  if (curIdx.value >= 0 && curIdx.value < pageNos.value.length - 1) cur.value = pageNos.value[curIdx.value + 1]
}

/** 页码框直跳（输入源书页码回车） */
const pageInput = ref<string>('')
function onPageInput() {
  const n = Number(pageInput.value)
  if (Number.isFinite(n) && n >= 1) jumpTo(Math.floor(n))
  pageInput.value = ''
}

/** 键盘 ←/→ 翻页（输入框聚焦时不抢） */
function onKey(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return
  if (e.key === 'ArrowLeft') prev()
  else if (e.key === 'ArrowRight') next()
}

/** 前后各 1 页预加载（防翻页白屏） */
watch(cur, () => {
  for (const d of [-1, 1]) {
    const idx = curIdx.value + d
    const no = pageNos.value[idx]
    const u = no != null ? urlByPage.value.get(no) : undefined
    if (u) new Image().src = proxyImage(u)
  }
  // 页码进 URL（刷新/分享保位）
  router.replace({ query: { ...route.query, p: String(cur.value) } })
})

// ── 下载整书 PDF（既有同步导出端点，大书 1-3 分钟）──
const exporting = ref(false)
async function onExportPdf() {
  if (exporting.value) return
  exporting.value = true
  ElMessage.info('正在生成整书 PDF（约 1-3 分钟），完成后自动打开…')
  try {
    const res = await exportBook(bookId)
    if (res?.url) window.open(res.url, '_blank')
    else ElMessage.warning('导出未返回文件地址')
  } catch {
    /* http 拦截器已弹错 */
  } finally {
    exporting.value = false
  }
}

function goBack() {
  router.push('/bookshelf')
}

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  try {
    data.value = await getTextbookPages(bookId)
    const q = Number(route.query.p)
    if (Number.isFinite(q) && q >= 1) jumpTo(Math.floor(q))
    else if (pageNos.value.length) cur.value = pageNos.value[0]
  } catch {
    /* http 拦截器已弹错 */
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div class="tb-page">
    <!-- ══ 顶栏 ══ -->
    <div class="tb-head">
      <el-button text @click="goBack">← 返回书架</el-button>
      <div class="tb-title">{{ data?.title ?? '电子课本' }}</div>
      <div class="tb-pageno" v-if="data">第 {{ cur }} / {{ data.totalPages }} 页</div>
      <el-button :loading="exporting" @click="onExportPdf">下载整书 PDF</el-button>
    </div>

    <div v-loading="loading" class="tb-body">
      <!-- ══ 左：章目录（章名+起始页；当前章高亮；点章跳首页）══ -->
      <aside class="tb-toc">
        <div class="toc-cap">目录</div>
        <button
          v-for="c in data?.chapters ?? []"
          :key="c.nodeId"
          class="toc-item"
          :class="{ on: c.nodeId === activeChapter }"
          @click="jumpTo(c.startPage)"
        >
          <span class="toc-name">{{ c.name }}</span>
          <span class="toc-pg">p{{ c.startPage }}</span>
        </button>
      </aside>

      <!-- ══ 中：单页大图 + 翻页控制 ══ -->
      <main class="tb-main">
        <div class="tb-canvas">
          <img v-if="curUrl" :src="curUrl" class="tb-img" :alt="`第 ${cur} 页`" />
          <div v-else-if="!loading" class="tb-empty">本页无图</div>
        </div>
        <div class="tb-nav">
          <el-button :disabled="curIdx <= 0" @click="prev">◀ 上一页</el-button>
          <div class="tb-jump">
            <input
              v-model="pageInput"
              class="tb-jump-input"
              :placeholder="String(cur)"
              @keydown.enter="onPageInput"
            />
            <span class="tb-jump-total">/ {{ data?.totalPages ?? '-' }}</span>
          </div>
          <el-button :disabled="curIdx < 0 || curIdx >= pageNos.length - 1" @click="next">下一页 ▶</el-button>
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.tb-page {
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--header-h, 64px));
  background: #f5f6f7;
}
.tb-head {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 18px;
  background: #fff;
  border-bottom: 1px solid #e5e7eb;
}
.tb-title {
  font-size: 16px;
  font-weight: 700;
  color: #1f2937;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tb-pageno {
  font-size: 13px;
  color: #6b7280;
  white-space: nowrap;
}
.tb-body {
  flex: 1;
  display: flex;
  min-height: 0;
}
/* ── 目录 ── */
.tb-toc {
  width: 220px;
  flex-shrink: 0;
  overflow-y: auto;
  background: #fff;
  border-right: 1px solid #e5e7eb;
  padding: 10px 8px 20px;
}
.toc-cap {
  font-size: 12px;
  color: #9ca3af;
  padding: 4px 10px 8px;
}
.toc-item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  background: none;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  font-size: 13px;
  color: #374151;
  line-height: 1.4;
}
.toc-item:hover {
  background: #f3f4f6;
}
.toc-item.on {
  background: #ecfdf5;
  color: #047857;
  font-weight: 700;
}
.toc-name {
  flex: 1;
}
.toc-pg {
  font-size: 12px;
  color: #9ca3af;
  flex-shrink: 0;
}
.toc-item.on .toc-pg {
  color: #059669;
}
/* ── 阅读区 ── */
.tb-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.tb-canvas {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 14px;
}
.tb-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  box-shadow: 0 2px 14px rgba(0, 0, 0, 0.12);
  background: #fff;
  border-radius: 3px;
}
.tb-empty {
  color: #9ca3af;
  font-size: 14px;
}
.tb-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 18px;
  padding: 10px 0 16px;
}
.tb-jump {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.tb-jump-input {
  width: 56px;
  text-align: center;
  font-size: 14px;
  padding: 5px 6px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  outline: none;
}
.tb-jump-input:focus {
  border-color: #10b981;
}
.tb-jump-total {
  font-size: 13px;
  color: #6b7280;
}
</style>
