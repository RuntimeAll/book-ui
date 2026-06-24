<script setup lang="ts">
/**
 * QuestionBlockRender — 结构化网格块统一渲染组件（PRD-A-015）
 *
 * 🔒 渲染 A-015 §10.1 锁定的 block schema（A-015 ∥ C-100 双分支共享接口）：
 *   { v, rows: [ { cells: [ <block> ] } ] }
 *   block 三型（type 判别）：
 *     - text   { type:'text',   md }
 *     - image  { type:'image',  url, width(1-100 占容器宽%), align(left|center|right) }
 *     - option { type:'option', label, content:[ text|image block ] }
 *
 * 布局语义：一行(row) 放 N 个 cell = N 列网格；图片位置 = 它在 rows/cells 的次序；不存绝对坐标。
 *
 * 🔴 三端一致由「单一渲染组件」保证：编辑器预览 / 卷库·详情 / PDF 导出统一用本组件渲染，
 *    文字块复用 renderRichText（KaTeX+markdown-it）+ v-safe-html（DOMPurify 白名单，已补 preserveAspectRatio）。
 */
import { computed } from 'vue'
import { renderRichText } from '@/utils/richtext'
import type { QuestionBlockDoc, BlockRow, Block } from '@/utils/blockSchema'
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
function imageStyle(b: Extract<Block, { type: 'image' }>) {
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
</script>

<template>
  <div
    v-if="rows.length > 0"
    class="qbr-root"
  >
    <div
      v-for="(row, ri) in rows"
      :key="ri"
      class="qbr-row"
      :style="{ gridTemplateColumns: `repeat(${Math.max(1, row.cells.length)}, minmax(0, 1fr))` }"
    >
      <div
        v-for="(cell, ci) in row.cells"
        :key="ci"
        class="qbr-cell"
      >
        <!-- 文字块 -->
        <div
          v-if="cell.type === 'text'"
          v-safe-html="textHtml(cell.md)"
          class="qbr-text"
        />

        <!-- 图片块 -->
        <img
          v-else-if="cell.type === 'image'"
          :src="imgSrc(cell.url)"
          :style="imageStyle(cell)"
          class="qbr-img"
          alt="题目图片"
          loading="lazy"
          referrerpolicy="no-referrer"
          @error="(e: Event) => ((e.target as HTMLImageElement).style.display = 'none')"
        />

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
                :src="imgSrc(sub.url)"
                :style="imageStyle(sub)"
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
  </div>
</template>

<style scoped>
.qbr-root {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.qbr-row {
  display: grid;
  gap: 12px;
  align-items: start;
}

.qbr-cell {
  min-width: 0;
}

.qbr-text {
  font-size: 14px;
  line-height: 1.7;
  color: var(--el-text-color-primary, #1d2129);
  word-break: break-word;
}

.qbr-text :deep(p) {
  margin: 0 0 0.4em;
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

.qbr-img {
  /* 🔴 PRD-C-204 渲染修复：max-height + object-fit:contain 让图按比例缩放、不溢出不变形。
     原仅 max-width:100%+height:auto，高瘦图(几何图常见)按 width% 渲染时高度被无限拉伸 → 撑爆卡片。
     对四端(列表/详情/卷库/PDF)均安全：contain 只缩不裁，仅高图不再无限拉伸。 */
  max-width: 100%;
  max-height: 240px;
  height: auto;
  object-fit: contain;
  border-radius: 6px;
}

/* 选项内的图通常更小，max-height 更紧凑，避免选项行被大图撑高、破坏 A/B/C/D 整齐 */
.qbr-option .qbr-img {
  max-height: 120px;
}

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
