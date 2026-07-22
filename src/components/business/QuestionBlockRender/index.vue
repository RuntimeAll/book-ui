<script setup lang="ts">
/**
 * QuestionBlockRender — 结构化网格块统一渲染组件（PRD-A-015）
 *
 * 🔒 渲染 A-015 §10.1 锁定的 block schema（A-015 ∥ C-100 双分支共享接口）：
 *   { v, rows: [ { cells: [ <block> ] } ] }
 *   block 三型（type 判别）：
 *     - text   { type:'text',   md }
 *     - image  { type:'image',  url, width(1-100 占容器宽%), align(left|center|right), caption?(新增可选) }
 *     - option { type:'option', label, content:[ text|image block ] }
 *
 * 布局语义：一行(row) 放 N 个 cell = N 列网格；图片位置 = 它在 rows/cells 的次序；不存绝对坐标。
 *
 * 🔴 三端一致由「单一渲染组件」保证：编辑器预览 / 卷库·详情 / PDF 导出统一用本组件渲染，
 *    文字块复用 renderRichText（KaTeX+markdown-it）+ v-safe-html（DOMPurify 白名单，已补 preserveAspectRatio）。
 *
 * 多图并列（本次新增）：
 *   连续的「单 image cell 的 row」(≥2 个相邻) → 合并成 figgroup，flex-wrap 并排显示 + caption。
 *   单独一张图的 row 保持原 grid/块级 width% 渲染，不进 figgroup。
 */
import { computed } from 'vue'
import { renderRichText } from '@/utils/richtext'
import type { QuestionBlockDoc, BlockRow, Block, ImageBlock } from '@/utils/blockSchema'
import { parseBlockDoc } from '@/utils/blockSchema'
import { proxyImage } from '@/utils/image-proxy'

const props = withDefaults(
  defineProps<{
    /** block 文档对象，或后端返回的 JSON 字符串；非法/空时渲染空 */
    doc?: QuestionBlockDoc | string | null
    /**
     * 图片是否走 BE 同源代理（proxyImage）。默认 false（页面内直连 OSS url 即可）。
     * 🔴 PDF 导出场景(PaperPreview)须传 true：html2canvas 截图要求图片同源，否则跨域图污染 canvas/被跳过。
     */
    proxy?: boolean
  }>(),
  { doc: null, proxy: false },
)

const docObj = computed<QuestionBlockDoc | null>(() => parseBlockDoc(props.doc))
const rows = computed<BlockRow[]>(() => docObj.value?.rows ?? [])

// ─── 显示组（DisplayGroup）预处理 ─────────────────────────────────────────────
/**
 * 判断一行是否为"单张图片行"：cells 长度 = 1 且唯一 cell 是 image 类型。
 * 只有这类 row 的连续区间（≥2）才收进 figgroup 并列。单独一行走普通 row。
 */
function isSingleImageRow(row: BlockRow): boolean {
  return row.cells.length === 1 && row.cells[0].type === 'image'
}

/** figgroup：连续 ≥2 单图行合并 */
interface FigGroup {
  kind: 'figgroup'
  images: ImageBlock[]
}
/** 普通行：文字/多 cell/选项/单图（不在 figgroup 内）*/
interface NormalRow {
  kind: 'row'
  row: BlockRow
}
type DisplayGroup = FigGroup | NormalRow

/**
 * 把 rows 预处理成 DisplayGroup 序列：
 *   - 扫描每 row，连续单图行临时收入 buffer
 *   - 遇到非单图行：先 flush buffer（≥2 → figgroup；=1 → normalRow），再把当前行加 normalRow
 *   - 结束时 flush 剩余 buffer
 */
const displayGroups = computed<DisplayGroup[]>(() => {
  const result: DisplayGroup[] = []
  let imgBuffer: ImageBlock[] = []

  function flushBuffer() {
    if (imgBuffer.length === 0) return
    if (imgBuffer.length >= 2) {
      result.push({ kind: 'figgroup', images: [...imgBuffer] })
    } else {
      // 只有 1 张：退回普通行（保持 width% / align 原渲染）
      result.push({
        kind: 'row',
        row: { cells: [imgBuffer[0]] },
      })
    }
    imgBuffer = []
  }

  for (const row of rows.value) {
    if (isSingleImageRow(row)) {
      imgBuffer.push(row.cells[0] as ImageBlock)
    } else {
      flushBuffer()
      result.push({ kind: 'row', row })
    }
  }
  flushBuffer()
  return result
})

// ─── 渲染辅助 ─────────────────────────────────────────────────────────────────

function textHtml(md: string): string {
  return renderRichText(md ?? '')
}

/** 图片 src：导出场景(proxy=true)走 BE 同源代理避 html2canvas 跨域污染 */
function imgSrc(url: string): string {
  return props.proxy ? proxyImage(url) : url
}

/**
 * 图片块行内样式：width 占容器宽百分比 + 左中右对齐（块级 margin）。
 * 🔴 PRD-A-018：缺失/非法 width 的兜底从 100→40。原 100 = 缺 width 时整图铺满容器（最易喧宾夺主），
 *    40 与入库默认（variant_support.DEFAULT_IMAGE_WIDTH_PCT）对齐，缺值时也是「默认即可看不过大」。
 *    显式存了 width 的（含老题 width=60）照原值渲染，不动。
 */
function imageStyle(b: ImageBlock) {
  const w = Math.min(100, Math.max(1, Number(b.width) || 40))
  const style: Record<string, string> = { width: `${w}%`, display: 'block' }
  if (b.align === 'center') {
    style.marginLeft = 'auto'
    style.marginRight = 'auto'
  } else if (b.align === 'right') {
    style.marginLeft = 'auto'
    style.marginRight = '0'
  } else {
    style.marginLeft = '0'
    style.marginRight = 'auto'
  }
  return style
}

/**
 * figgroup 内单张图的 flex-item 样式。
 * 🔴 2026-07-21 修（用户"图片宽度调不动"根因）：原 basis=width/2 px + 下限 120px 的组内算法
 *    覆盖了 width% 语义——编辑器把 64 拖到 100 视觉几乎不变。改为直接尊重 width%：
 *    所设即所得；两张 w44 图 88% 仍并排，超 100% 自动换行（2×2 场景与源书一致）。
 */
function figItemStyle(b: ImageBlock) {
  const w = Math.min(100, Math.max(1, Number(b.width) || 40))
  return {
    flex: `0 1 ${w}%`,
    maxWidth: `${w}%`,
  }
}

// 供模板用的 Extract 类型辅助（避免 as any）
function asImageBlock(b: Block): ImageBlock {
  return b as ImageBlock
}

/**
 * 图注切段（2026-07-22 图文列对齐方案）：合成图（一张图内含 N 个子图）的作答位图注
 * 「( )个角　( )个角　( )个角」按全角空格/连续空白切段，flex space-around 均布在图宽内，
 * 与子图逐列对齐。单段图注也走 flex（space-around 单项=居中），行为不变。
 */
function captionSegs(c: string): string[] {
  return c
    .split(/　+|\s{2,}/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 单图行图注样式：宽度/对齐随图（imageStyle 同款 margin 方案），确保图注均布区间=图的实际宽度。 */
function captionStyle(b: ImageBlock) {
  const w = Math.min(100, Math.max(1, Number(b.width) || 40))
  const style: Record<string, string> = { width: `${w}%` }
  if (b.align === 'center') {
    style.marginLeft = 'auto'
    style.marginRight = 'auto'
  } else if (b.align === 'right') {
    style.marginLeft = 'auto'
    style.marginRight = '0'
  } else {
    style.marginLeft = '0'
    style.marginRight = 'auto'
  }
  return style
}

/** 图点击看原图（2026-07-21 审核"图片不能放大缩小"）：事件委托覆盖结构图+md 内联图，新页签开原图可任意缩放。 */
function onRootClick(e: MouseEvent) {
  const t = e.target as HTMLElement
  if (t?.tagName === 'IMG') {
    const src = (t as HTMLImageElement).src
    if (src) window.open(src, '_blank')
  }
}
</script>

<template>
  <div
    v-if="rows.length > 0"
    class="qbr-root"
    @click="onRootClick"
  >
    <template
      v-for="(group, gi) in displayGroups"
      :key="gi"
    >
      <!-- ① figgroup：≥2 连续单图行并列显示 -->
      <div
        v-if="group.kind === 'figgroup'"
        class="qbr-figgroup"
      >
        <figure
          v-for="(img, ii) in group.images"
          :key="ii"
          class="qbr-figure"
          :style="figItemStyle(img)"
        >
          <img
            :src="imgSrc(img.url)"
            class="qbr-img qbr-fig-img"
            alt="题目图片"
            loading="lazy"
            referrerpolicy="no-referrer"
            @error="(e: Event) => ((e.target as HTMLImageElement).style.display = 'none')"
          />
          <figcaption
            v-if="img.caption"
            class="qbr-figcaption"
          >
            <span
              v-for="(seg, si2) in captionSegs(img.caption!)"
              :key="si2"
            >{{ seg }}</span>
          </figcaption>
        </figure>
      </div>

      <!-- ② 普通行：文字 / 多 cell / 选项 / 单图（不在 figgroup 内） -->
      <div
        v-else
        class="qbr-row"
        :style="{ gridTemplateColumns: `repeat(${Math.max(1, group.row.cells.length)}, minmax(0, 1fr))` }"
      >
        <div
          v-for="(cell, ci) in group.row.cells"
          :key="ci"
          class="qbr-cell"
        >
          <!-- 文字块 -->
          <div
            v-if="cell.type === 'text'"
            v-safe-html="textHtml(cell.md)"
            class="qbr-text"
          />

          <!-- 图片块（单图普通行，保持 width%/align 原渲染） -->
          <figure
            v-else-if="cell.type === 'image'"
            class="qbr-figure qbr-figure--block"
          >
            <img
              :src="imgSrc(asImageBlock(cell).url)"
              :style="imageStyle(asImageBlock(cell))"
              class="qbr-img"
              alt="题目图片"
              loading="lazy"
              referrerpolicy="no-referrer"
              @error="(e: Event) => ((e.target as HTMLImageElement).style.display = 'none')"
            />
            <figcaption
              v-if="asImageBlock(cell).caption"
              class="qbr-figcaption"
              :style="captionStyle(asImageBlock(cell))"
            >
              <span
                v-for="(seg, si2) in captionSegs(asImageBlock(cell).caption!)"
                :key="si2"
              >{{ seg }}</span>
            </figcaption>
          </figure>

          <!-- 选项块 -->
          <div
            v-else-if="cell.type === 'option'"
            class="qbr-option"
          >
            <span class="qbr-option-label">{{ cell.label }}.</span>
            <div class="qbr-option-content">
              <template
                v-for="(sub, si) in cell.content"
                :key="si"
              >
                <div
                  v-if="sub.type === 'text'"
                  v-safe-html="textHtml(sub.md)"
                  class="qbr-text"
                />
                <img
                  v-else-if="sub.type === 'image'"
                  :src="imgSrc(asImageBlock(sub).url)"
                  :style="imageStyle(asImageBlock(sub))"
                  class="qbr-img"
                  alt="选项图片"
                  loading="lazy"
                  referrerpolicy="no-referrer"
                  @error="(e: Event) => ((e.target as HTMLImageElement).style.display = 'none')"
                />
              </template>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.qbr-root {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

/* ── figgroup：多图并列容器 ─────────────────────────────────────────────────── */
.qbr-figgroup {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 16px; /* 行间12px / 列间16px */
  align-items: flex-start;
}

/* ── figure / figcaption ────────────────────────────────────────────────────── */
.qbr-figure {
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
}

/* 单图普通行：figure 作为 block 容器，尊重 imageStyle 的 width%/align */
.qbr-figure--block {
  display: block; /* 让 img 的 margin:auto 生效 */
  width: 100%;
}

.qbr-figcaption {
  margin-top: 6px;
  /* 题卡语境里图注=作答位(「( )个角」等题目内容,非装饰注释)——正文样式(2026-07-22 图文列对齐方案)。
     flex space-around: 多段作答位均布在图宽内与子图逐列对齐;单段时=居中,行为不变。 */
  display: flex;
  justify-content: space-around;
  font-size: 15px;
  color: var(--el-text-color-primary, #1d2129);
  line-height: 1.5;
  text-align: center;
  white-space: nowrap;
}

/* ── 普通 row / cell ─────────────────────────────────────────────────────────── */
.qbr-row {
  display: grid;
  gap: 12px;
  align-items: start;
}

.qbr-cell {
  min-width: 0;
}

/* ── 文字块 ──────────────────────────────────────────────────────────────────── */
.qbr-text {
  font-size: 14px;
  line-height: 1.7;
  color: var(--el-text-color-primary, #1d2129);
  word-break: break-word;
}

.qbr-text :deep(p) {
  margin: 0 0 0.4em;
}

/* 🔴 2026-07-21 一上审核根因（代码层）：作答括号「(        )」内的连续半角空格被 HTML
   默认 white-space:normal 折叠成 1 个 → 渲染成「( )」没了作答位（用户"空格没有填充"）。
   pre-wrap 保留文本节点内的连续空格与 U+3000，只挂叶子元素（p/li/td/th），
   不挂 .qbr-text 容器本身——容器直接子级是标签间的格式化换行，挂了会渲出空白行。 */
.qbr-text :deep(p),
.qbr-text :deep(li),
.qbr-text :deep(td),
.qbr-text :deep(th) {
  white-space: pre-wrap;
}

.qbr-text :deep(p:last-child) {
  margin-bottom: 0;
}

/* 块公式横向可滚，防超宽溢出 */
.qbr-text :deep(.math-block) {
  display: block;
  overflow-x: auto;
  padding: 4px 0;
}

.qbr-text :deep(.math-inline) {
  display: inline;
  vertical-align: middle;
}

/* GFM 表格网格线：markdown-it 渲出的 <table> 默认无边框，浏览页/导出双端补网格 */
.qbr-text :deep(table) {
  border-collapse: collapse;
  /* 超宽表格自行横滚，配合 keep-all 不再把窄列数字拆行（2026-07-22 自查批量：22→"2/2"） */
  display: block;
  max-width: 100%;
  overflow-x: auto;
  width: fit-content;
}

.qbr-text :deep(td),
.qbr-text :deep(th) {
  border: 1px solid #ccc;
  padding: 2px 8px;
  /* 空作答格行高保底：GFM 空 cell 会塌缩成一条线，学生没地方写 */
  height: 1.9em;
  /* 数字/单词永不拆行（"22"被窄列拆成两行的根因），中文仍按标点断行；超宽走表格横滚 */
  word-break: keep-all;
}

/* 作答/图形字符放大（richtext Step 5 包的 span）：□○△☆＝＋－按源书大号印刷框渲染，
   学生有地方写（"答题的框太小"根因，2026-07-21；1.35→1.8em 用户拍板"默认都是大号"）。 */
.qbr-text :deep(.glyph-ans) {
  font-size: 1.8em;
  line-height: 1.15;
  vertical-align: -0.1em;
}

/* 行内图护栏（2026-07-15 内嵌图原位内联修复轮）：
   text 块 md 里的 ![](ossUrl) 句中图与文字同行、垂直居中，限高防撑行。
   🔴 2026-07-21 一上审核根因A：内联 ![]() 图无逐图尺寸旋钮（=用户"月亮图标太大且不能修改"的代码根因），
   仅此全局上限可调。源书里 月牙/△○□ 类符号约 1 字高，2.5em(≈35px) 相对 14px 正文偏大 →
   收到 1.8em；2026-07-21 二轮用户复看仍偏大（月亮比☆○□字符大一圈）→ 再收到 1.4em ≈ 字符高。 */
.qbr-text :deep(img) {
  display: inline-block;
  vertical-align: middle;
  max-height: 1.4em;
  max-width: 100%;
}

/* 表格 cell 内的 md 图（媒体表：图排+作答格，如低年级数一数/照样子画一画）：
   2.5em 句中钳制会把计数图压到不可辨认，表格上下文放开限高 */
.qbr-text :deep(td) img,
.qbr-text :deep(th) img {
  max-height: 100px;
}

/* ── 图片 ────────────────────────────────────────────────────────────────────── */
.qbr-img {
  /* 🔴 PRD-C-204 渲染修复：max-height + object-fit:contain 让图按比例缩放、不溢出不变形。
     原仅 max-width:100%+height:auto，高瘦图(几何图常见)按 width% 渲染时高度被无限拉伸 → 撑爆卡片。
     对四端(列表/详情/卷库/PDF)均安全：contain 只缩不裁，仅高图不再无限拉伸。 */
  max-width: 100%;
  max-height: 240px;
  height: auto;
  object-fit: contain;
  /* 🔴 2026-07-21 审核根因：教辅线稿图(作答框条/几何图)白底贴边，border-radius:6px
     会把贴边框线削掉一截——用户看着像"图被切了角"。线稿图为主，圆角一律去掉。 */
  border-radius: 0;
  cursor: zoom-in; /* 点击开原图（onRootClick 委托） */
}

.qbr-text :deep(img) {
  cursor: zoom-in;
}

/* figgroup 内的图：max-height 可稍大，让分子结构图等有足够高度展示细节 */
.qbr-fig-img {
  max-height: 200px;
  width: 100%; /* 在 figure flex 容器内充满，受 figItemStyle maxWidth 约束 */
  object-fit: contain;
}

/* 选项内的图通常更小，max-height 更紧凑，避免选项行被大图撑高、破坏 A/B/C/D 整齐 */
.qbr-option .qbr-img {
  max-height: 120px;
}

/* ── 选项块 ──────────────────────────────────────────────────────────────────── */
.qbr-option {
  display: flex;
  gap: 6px;
  align-items: flex-start;
}

.qbr-option-label {
  font-weight: 600;
  color: var(--el-color-primary, #1e8a8a);
  flex-shrink: 0;
  line-height: 1.7;
}

.qbr-option-content {
  min-width: 0;
  flex: 1;
}
</style>
