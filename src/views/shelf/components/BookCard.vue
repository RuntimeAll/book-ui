<script setup lang="ts">
/**
 * 书架书卡（2026-07-31 书架改版）——立在层板上的「书」。
 * 封面即主体（点击打开），操作悬停浮现；⋯ 菜单常驻右上。
 * 全部业务动作通过 emit 交回父页（导出/删除/弹窗逻辑不下沉，卡片只管展示与分发）。
 */
import { computed } from 'vue'
import {
  readBookNetdiskCount,
  readBookPdfMeta,
  readBookPunchExport,
  hasBookPromo,
  type ShelfBookVO,
} from '@/api/shelf'
import { proxyImage } from '@/utils/image-proxy'

const props = defineProps<{
  book: ShelfBookVO
  /** 录入审核进度（无进度不传） */
  reviewInfo?: { reviewed: number; total: number; pct: number; done: boolean } | null
  /** 打卡整册导出进行中（菜单置灰用） */
  punchExportRunning?: boolean
  /** 普通书整书导出进行中 */
  exporting?: boolean
}>()

const emit = defineEmits<{
  (e: 'open'): void
  (e: 'review'): void
  (e: 'punch-review'): void
  (e: 'menu', cmd: string): void
}>()

const type = computed(() => String(props.book.bookType))
const isPunch = computed(() => type.value === 'daily_punch')
const isPdf = computed(() => type.value === 'pdf_pending')
const isTextbook = computed(() => type.value === 'textbook')

const coverClass = computed(() => {
  const t = type.value
  if (t === 'lecture') return 'c1'
  if (t === 'special' || t === 'variant_special') return 'c3'
  if (t === 'daily_punch') return 'c4'
  if (t === 'pdf_pending') return 'c5'
  return 'c2'
})

/** 待解析书封面缩略图（OSS 图走 BE proxy 防 Content-Disposition 拒渲）。 */
const coverStyle = computed<Record<string, string>>(() => {
  const style: Record<string, string> = {}
  if (!isPdf.value) return style
  const url = proxyImage(readBookPdfMeta(props.book).coverUrl)
  if (url) style.backgroundImage = `url("${url}")`
  return style
})
const hasCoverImg = computed(() => Boolean(coverStyle.value.backgroundImage))

const netdiskCount = computed(() => readBookNetdiskCount(props.book))
const hasPromo = computed(() => hasBookPromo(props.book))
const punchExport = computed(() => readBookPunchExport(props.book))

/** 结构统计串（口径与旧版一致：打卡按天 / 课本按章页 / 待解析按 PDF 页 / 其余节·题）。 */
const statLine = computed(() => {
  const b = props.book
  if (isPunch.value) return b.nodeCount != null ? `${b.nodeCount} 天 · 每天一练` : '空书'
  if (isTextbook.value) return b.nodeCount != null ? `${b.nodeCount} 章 · ${b.questionCount ?? 0} 页` : '空书'
  if (isPdf.value) {
    const pages = readBookPdfMeta(b).pdfPages
    return pages > 0 ? `${pages} 页 PDF` : 'PDF'
  }
  const parts: string[] = []
  if (b.nodeCount != null) parts.push(`${b.nodeCount} 节`)
  if (b.questionCount != null) parts.push(`${b.questionCount} 题`)
  else if (b.itemCount != null) parts.push(`${b.itemCount} 项`)
  return parts.join(' · ') || '空书'
})
</script>

<template>
  <div class="bookv" :title="book.title">
    <!-- 封面 = 书本体：点击打开 -->
    <div :class="['cover', coverClass, { 'has-img': hasCoverImg }]" :style="coverStyle" @click="emit('open')">
      <span class="spine" />
      <span class="cover-title">{{ book.title }}</span>
      <span v-if="isPdf" class="pending-flag">待解析</span>
      <!-- 小标：网盘 / 宣发 -->
      <span v-if="netdiskCount > 0 || hasPromo" class="chips">
        <span v-if="netdiskCount > 0" class="chip" title="已绑网盘链接">☁{{ netdiskCount }}</span>
        <span v-if="hasPromo" class="chip" title="已存宣发文案">📣</span>
      </span>
      <!-- 录入审核进度：细条压封面底边；审完出对号 -->
      <span v-if="reviewInfo && !reviewInfo.done" class="rv-bar"><i :style="{ width: reviewInfo.pct + '%' }" /></span>
      <span v-else-if="reviewInfo?.done" class="rv-done" title="录入确认完成">✓</span>
      <!-- 悬停操作层 -->
      <span class="hover-ops" @click.stop>
        <el-button size="small" type="primary" @click="emit('open')">打开</el-button>
        <el-button v-if="isPunch" size="small" class="ghost-btn" @click="emit('punch-review')">审核</el-button>
        <el-button v-else-if="!isPdf" size="small" class="ghost-btn" @click="emit('review')">录入审核</el-button>
      </span>
    </div>
    <!-- 书脚：统计 + ⋯ 菜单 -->
    <div class="foot">
      <span class="stat">{{ statLine }}</span>
      <el-dropdown trigger="click" @command="(c: string) => emit('menu', c)">
        <button class="more-btn" @click.stop>⋯</button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="netdisk">网盘链接</el-dropdown-item>
            <el-dropdown-item command="promo">宣发文案</el-dropdown-item>
            <!-- 打卡书：整册异步导出 + 导好的全册直接可下 -->
            <template v-if="isPunch">
              <el-dropdown-item command="export" :disabled="punchExportRunning">
                {{ punchExportRunning ? '整册导出中…' : '导出整册 PDF' }}
              </el-dropdown-item>
              <el-dropdown-item v-if="punchExport?.questionUrl" command="dl-q">下载题目全册</el-dropdown-item>
              <el-dropdown-item v-if="punchExport?.answerUrl" command="dl-a">下载解析全册</el-dropdown-item>
            </template>
            <!-- 待解析书：导出 = 取 PDF 原件 -->
            <el-dropdown-item v-else-if="isPdf" command="export">下载 PDF 原件</el-dropdown-item>
            <!-- 讲义/练习册/课本：BE 整书导出 -->
            <el-dropdown-item v-else command="export" :disabled="exporting">
              {{ exporting ? '整书导出中…' : '导出整书 PDF' }}
            </el-dropdown-item>
            <el-dropdown-item command="del" style="color: var(--el-color-danger)">删除书</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
  </div>
</template>

<style scoped>
.bookv {
  width: 128px;
  flex: none;
  display: flex;
  flex-direction: column;
}
/* ── 封面：书本体 ── */
.cover {
  position: relative;
  height: 156px;
  border-radius: 3px 7px 7px 3px;   /* 右缘圆、书脊侧直，书的轮廓 */
  display: flex;
  align-items: flex-end;
  padding: 9px 10px 12px 14px;
  color: #fff;
  font-weight: 800;
  font-size: 13px;
  line-height: 1.4;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.22);
  cursor: pointer;
  box-shadow: 0 2px 5px rgba(19, 49, 43, 0.16), inset -2px 0 4px rgba(255, 255, 255, 0.12);
  transition: transform 0.16s ease, box-shadow 0.16s ease;
  overflow: hidden;
}
.bookv:hover .cover {
  transform: translateY(-5px);
  box-shadow: 0 10px 20px rgba(19, 49, 43, 0.24);
}
/* 书脊压边条 */
.spine {
  position: absolute;
  inset: 0 auto 0 0;
  width: 7px;
  background: linear-gradient(to right, rgba(0, 0, 0, 0.22), rgba(0, 0, 0, 0.02));
  pointer-events: none;
}
.cover.c1 { background: linear-gradient(150deg, #1268b3, #4fa3e0); }
.cover.c2 { background: linear-gradient(150deg, #0f766e, #4cc2b4); }
.cover.c3 { background: linear-gradient(150deg, #7a4fc0, #a98ae0); }
.cover.c4 { background: linear-gradient(150deg, #c2701a, #f0b45c); }
.cover.c5 { background: linear-gradient(150deg, #4a5b66, #8ea3ad); }
.cover.has-img {
  background-size: cover;
  background-position: center top;
  background-repeat: no-repeat;
}
.cover.has-img::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.05) 30%, rgba(0, 0, 0, 0.65));
}
.cover-title {
  position: relative;
  z-index: 1;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  word-break: break-all;
}
.pending-flag {
  position: absolute;
  z-index: 1;
  top: 7px;
  right: 7px;
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 999px;
  background: #fde68a;
  color: #92400e;
  text-shadow: none;
  white-space: nowrap;
}
.chips {
  position: absolute;
  z-index: 1;
  top: 7px;
  left: 10px;
  display: flex;
  gap: 4px;
}
.chip {
  font-size: 10px;
  font-weight: 700;
  padding: 0 5px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.88);
  color: #1268b3;
  text-shadow: none;
}
/* 录入审核进度：封面底边细条 */
.rv-bar {
  position: absolute;
  z-index: 1;
  left: 7px;
  right: 0;
  bottom: 0;
  height: 4px;
  background: rgba(255, 255, 255, 0.35);
}
.rv-bar > i {
  display: block;
  height: 100%;
  background: #2dd4bf;
}
.rv-done {
  position: absolute;
  z-index: 1;
  right: 7px;
  bottom: 7px;
  width: 17px;
  height: 17px;
  border-radius: 50%;
  background: var(--bk-red-pen, #e0526b);
  color: #fff;
  font-size: 11px;
  font-weight: 800;
  line-height: 17px;
  text-align: center;
  text-shadow: none;
}
/* 悬停操作层 */
.hover-ops {
  position: absolute;
  z-index: 2;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: rgba(19, 49, 43, 0.42);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.16s ease;
}
.bookv:hover .hover-ops {
  opacity: 1;
  pointer-events: auto;
}
.hover-ops :deep(.el-button + .el-button) {
  margin-left: 0;
}
.hover-ops .ghost-btn {
  background: rgba(255, 255, 255, 0.92);
  color: var(--bk-teal-deep);
  border-color: transparent;
}
/* ── 书脚 ── */
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 5px 2px 0;
}
.stat {
  font-size: 10.5px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.more-btn {
  flex: none;
  border: 0;
  background: transparent;
  color: var(--el-text-color-secondary);
  font-size: 14px;
  font-weight: 800;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 5px;
  cursor: pointer;
}
.more-btn:hover {
  background: #eef2f2;
  color: var(--bk-teal-deep);
}
</style>
