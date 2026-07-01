<script setup lang="ts">
/**
 * KgBlock — 六类积木块分发渲染器
 *
 * para     段落（spans 拼接，mark:1 → <mark> 标红）
 * note     名师解读红框
 * callout  蓝字记忆框（带色边框居中盒）
 * image    配图（max-width:100%）
 * table    表格（header=橙底白字，含 colspan/rowspan/imgs）
 * example  例题蓝卡（答案蓝字，详解灰底可折叠）
 *
 * 富文本规则：
 *   - mark:1 → <mark>，DOMPurify 白名单已含 mark，一律走 v-safe-html
 *   - t 内 \n → <br>
 *   - 禁裸 v-html
 */
import { ref, computed } from 'vue'
import type {
  KgBlock,
  KgSpan,
  KgTableCell,
  KgExampleItem,
} from '@/api/kg/index'

const props = defineProps<{
  block: KgBlock
}>()

// ── Span 工具：spans 数组 → 安全 HTML 字符串 ─────────────────────────────────
/**
 * 把 span[] 转成 HTML 字符串，mark:1 用 <mark>，\n 转 <br>
 * 最终通过 v-safe-html 渲染，DOMPurify 会再过滤一遍
 */
function spansToHtml(spans: KgSpan[]): string {
  return spans
    .map((s) => {
      // 转义纯文字中的 < > & 防止被当 HTML（DOMPurify 最后兜）
      const escaped = s.t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
      return s.mark ? `<mark>${escaped}</mark>` : escaped
    })
    .join('')
}

// ── 折叠状态（example 详解） ──────────────────────────────────────────────────
const explainOpen = ref(false)
function toggleExplain() {
  explainOpen.value = !explainOpen.value
}

// ── example 头部标签文字 ──────────────────────────────────────────────────────
const exampleHeader = computed(() => {
  if (props.block.type !== 'example') return ''
  const { year, region } = props.block.payload
  if (year && region) return `${year} · ${region}`
  if (year) return year
  if (region) return region
  return '例题'
})

// ── example item 类型守卫 ─────────────────────────────────────────────────────
function isSpanItem(item: KgExampleItem): item is { spans: KgSpan[] } {
  return 'spans' in item
}
function isImgItem(item: KgExampleItem): item is { img: string; w: number; role?: string } {
  return 'img' in item
}
function isTableItem(item: KgExampleItem): item is { table: KgTableCell[][] } {
  return 'table' in item
}

// ── 表格辅助（example 内嵌 table item 与 table 块共用） ──────────────────────
function cellHtml(cell: KgTableCell): string {
  return spansToHtml(cell.spans)
}
</script>

<template>
  <!-- ── para ──────────────────────────────────────────────────────────────── -->
  <p v-if="block.type === 'para'" class="kg-para" v-safe-html="spansToHtml(block.payload.spans)" />

  <!-- ── note（名师解读红框） ───────────────────────────────────────────────── -->
  <div v-else-if="block.type === 'note'" class="kg-note">
    <span class="kg-note-tag">{{ block.payload.title }}</span>
    <span class="kg-note-text">{{ block.payload.text }}</span>
  </div>

  <!-- ── callout（蓝字记忆框） ──────────────────────────────────────────────── -->
  <div
    v-else-if="block.type === 'callout'"
    class="kg-callout"
    :style="{ '--callout-color': block.payload.color }"
  >
    <div
      v-for="(line, i) in block.payload.lines"
      :key="i"
      class="kg-callout-line"
    >{{ line }}</div>
  </div>

  <!-- ── image ──────────────────────────────────────────────────────────────── -->
  <div v-else-if="block.type === 'image'" class="kg-image-wrap">
    <img
      :src="block.payload.url"
      :alt="block.payload.role ?? '图片'"
      :style="{ maxWidth: '100%', width: block.payload.w ? `${block.payload.w}px` : 'auto' }"
      class="kg-image"
    />
    <div v-if="block.payload.role" class="kg-image-role">{{ block.payload.role }}</div>
  </div>

  <!-- ── table ──────────────────────────────────────────────────────────────── -->
  <div v-else-if="block.type === 'table'" class="kg-table-wrap">
    <table class="kg-table">
      <tbody>
        <tr v-for="(row, ri) in block.payload.rows" :key="ri">
          <template v-for="(cell, ci) in row" :key="ci">
            <th
              v-if="cell.header"
              class="kg-th"
              :colspan="cell.colspan ?? 1"
              :rowspan="cell.rowspan ?? 1"
            >
              <div v-safe-html="cellHtml(cell)" />
              <template v-if="cell.imgs && cell.imgs.length > 0">
                <img
                  v-for="(imgUrl, ii) in cell.imgs"
                  :key="ii"
                  :src="imgUrl"
                  class="kg-cell-img"
                  alt="表格图片"
                />
              </template>
            </th>
            <td
              v-else
              class="kg-td"
              :colspan="cell.colspan ?? 1"
              :rowspan="cell.rowspan ?? 1"
            >
              <div v-safe-html="cellHtml(cell)" />
              <template v-if="cell.imgs && cell.imgs.length > 0">
                <img
                  v-for="(imgUrl, ii) in cell.imgs"
                  :key="ii"
                  :src="imgUrl"
                  class="kg-cell-img"
                  alt="表格图片"
                />
              </template>
            </td>
          </template>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- ── example（例题蓝卡） ────────────────────────────────────────────────── -->
  <div v-else-if="block.type === 'example'" class="kg-example">
    <!-- 例题头部 -->
    <div class="kg-example-header">
      <span class="kg-example-badge">例题</span>
      <span v-if="exampleHeader" class="kg-example-source">{{ exampleHeader }}</span>
    </div>

    <!-- 题干 items（文字/图片/表格 混排） -->
    <div class="kg-example-body">
      <template v-for="(item, ii) in block.payload.items" :key="ii">
        <!-- 文字 item -->
        <span
          v-if="isSpanItem(item)"
          class="kg-example-span"
          v-safe-html="spansToHtml(item.spans)"
        />
        <!-- 图片 item -->
        <div v-else-if="isImgItem(item)" class="kg-example-img-wrap">
          <img
            :src="item.img"
            :alt="item.role ?? '题图'"
            :style="{ maxWidth: '100%', width: item.w ? `${item.w}px` : 'auto' }"
            class="kg-image"
          />
        </div>
        <!-- 内嵌表格 item -->
        <div v-else-if="isTableItem(item)" class="kg-table-wrap">
          <table class="kg-table">
            <tbody>
              <tr v-for="(row, ri) in item.table" :key="ri">
                <template v-for="(cell, ci) in row" :key="ci">
                  <th
                    v-if="cell.header"
                    class="kg-th"
                    :colspan="cell.colspan ?? 1"
                    :rowspan="cell.rowspan ?? 1"
                  >
                    <div v-safe-html="cellHtml(cell)" />
                    <template v-if="cell.imgs && cell.imgs.length > 0">
                      <img
                        v-for="(imgUrl, ii3) in cell.imgs"
                        :key="ii3"
                        :src="imgUrl"
                        class="kg-cell-img"
                        alt="表格图片"
                      />
                    </template>
                  </th>
                  <td
                    v-else
                    class="kg-td"
                    :colspan="cell.colspan ?? 1"
                    :rowspan="cell.rowspan ?? 1"
                  >
                    <div v-safe-html="cellHtml(cell)" />
                    <template v-if="cell.imgs && cell.imgs.length > 0">
                      <img
                        v-for="(imgUrl, ii2) in cell.imgs"
                        :key="ii2"
                        :src="imgUrl"
                        class="kg-cell-img"
                        alt="表格图片"
                      />
                    </template>
                  </td>
                </template>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>

    <!-- 答案行（蓝字） -->
    <div class="kg-example-answer">
      <span class="kg-answer-label">【答案】</span>
      <span>{{ block.payload.answer }}</span>
    </div>

    <!-- 详解折叠 -->
    <div class="kg-explain-toggle" @click="toggleExplain">
      {{ explainOpen ? '收起详解' : '查看详解' }}
      <span class="kg-explain-arrow">{{ explainOpen ? '▲' : '▼' }}</span>
    </div>
    <div v-if="explainOpen" class="kg-explain-body">
      <span class="kg-explain-label">【详解】</span>
      <span>{{ block.payload.explain }}</span>
    </div>
  </div>
</template>

<style scoped>
/* ── para ── */
.kg-para {
  margin: 4px 0 8px;
  font-size: 14px;
  line-height: 1.9;
  color: #1e293b;
}

:deep(mark) {
  background: none;
  color: #dc2626;
  font-weight: 600;
}

/* ── note（名师解读） ── */
.kg-note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  border-left: 4px solid #dc2626;
  background: #fff5f5;
  border-radius: 0 6px 6px 0;
  padding: 8px 12px;
  margin: 8px 0;
  font-size: 14px;
  line-height: 1.8;
  color: #1e293b;
}

.kg-note-tag {
  flex-shrink: 0;
  display: inline-block;
  background: #dc2626;
  color: #fff;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  white-space: nowrap;
  margin-top: 2px;
}

.kg-note-text {
  flex: 1;
}

/* ── callout（蓝字记忆口诀框） ── */
.kg-callout {
  border: 2px solid var(--callout-color, #2563eb);
  border-radius: 8px;
  padding: 12px 20px;
  margin: 10px auto;
  max-width: 480px;
  text-align: center;
  background: #eff6ff;
}

.kg-callout-line {
  color: var(--callout-color, #2563eb);
  font-size: 15px;
  font-weight: 600;
  line-height: 2;
  letter-spacing: 0.02em;
}

/* ── image ── */
.kg-image-wrap {
  margin: 8px 0;
  text-align: center;
}

.kg-image {
  max-width: 100%;
  height: auto;
  border-radius: 4px;
  vertical-align: top;
}

.kg-image-role {
  font-size: 12px;
  color: #94a3b8;
  margin-top: 4px;
}

/* ── table ── */
.kg-table-wrap {
  margin: 8px 0;
  overflow-x: auto;
}

.kg-table {
  border-collapse: collapse;
  width: 100%;
  font-size: 14px;
}

.kg-th {
  background: #f97316;
  color: #fff;
  border: 1px solid #cbd5e1;
  padding: 6px 10px;
  text-align: left;
  vertical-align: top;
  font-weight: 600;
  white-space: nowrap;
  min-width: 72px;
}

.kg-td {
  border: 1px solid #cbd5e1;
  padding: 6px 10px;
  vertical-align: top;
  line-height: 1.8;
}

.kg-cell-img {
  display: block;
  max-width: 120px;
  max-height: 150px;
  width: auto;
  height: auto;
  margin: 4px 0;
  border-radius: 3px;
  object-fit: contain;
}

/* ── example（例题蓝卡） ── */
.kg-example {
  border: 1px solid #bfdbfe;
  border-left: 4px solid #3b82f6;
  border-radius: 6px;
  background: #f8fafc;
  padding: 12px 14px;
  margin: 10px 0;
}

.kg-example-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.kg-example-badge {
  display: inline-block;
  background: #3b82f6;
  color: #fff;
  font-size: 11px;
  padding: 2px 10px;
  border-radius: 10px;
  font-weight: 600;
}

.kg-example-source {
  font-size: 12px;
  color: #64748b;
}

.kg-example-body {
  font-size: 14px;
  color: #1e293b;
  line-height: 1.9;
  margin-bottom: 8px;
}

.kg-example-span {
  /* inline，让文字和图片自然流排 */
}

.kg-example-img-wrap {
  margin: 6px 0;
  text-align: center;
}

.kg-example-answer {
  font-size: 14px;
  color: #1d4ed8;
  font-weight: 500;
  margin: 6px 0 4px;
  line-height: 1.8;
}

.kg-answer-label {
  font-weight: 700;
}

/* 详解折叠按钮 */
.kg-explain-toggle {
  display: inline-block;
  font-size: 12px;
  color: #2563eb;
  border: 1px solid #bfdbfe;
  border-radius: 4px;
  padding: 2px 10px;
  cursor: pointer;
  user-select: none;
  margin-bottom: 4px;
  transition: background 0.15s;
}

.kg-explain-toggle:hover {
  background: #eff6ff;
}

.kg-explain-arrow {
  font-size: 10px;
  margin-left: 4px;
}

/* 详解内容 */
.kg-explain-body {
  background: #f1f5f9;
  border-radius: 4px;
  padding: 8px 12px;
  font-size: 13px;
  color: #475569;
  line-height: 1.8;
  margin-top: 4px;
}

.kg-explain-label {
  font-weight: 700;
  color: #334155;
}
</style>
