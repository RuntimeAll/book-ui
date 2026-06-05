<script setup lang="ts">
// ────────────────────────────────────────────────────────────────────────────
// Q' 卡 段③ + 段④ FE 产物 — 试卷预览模态（el-dialog 全屏）
//   段③ 骨架：el-dialog + 顶部 paperName / 日期 / 答案&解析 checkbox + 底部按钮 + loading
//   段④ 渲染：onOpen fetch /teacher/question/list?ids=xxx → 按 basket 入参顺序 reorder
//             → 按 freeTags[0].name 分组（"其他"段末尾）→ v-html 渲染 → typesetPaperPreview
//   段⑤ PDF 工艺：本组件不实现，按钮 click handler stub（开发组长波 3 自接手）
// ────────────────────────────────────────────────────────────────────────────
import { ref, nextTick, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Download } from '@element-plus/icons-vue'
import {
  questionListByIds,
  type QuestionDetail,
  type FreeTagVo,
} from '@/api/question'
import { typesetPaperPreview } from '@/utils/mathjax'
import { exportPaperToPdf } from '@/utils/pdf-export'
import { proxyImage } from '@/utils/image-proxy'

const props = defineProps<{
  visible: boolean
  paperName: string
  ids: number[]  // basket 提供的题目 id 列表（入参顺序 = 显示顺序）
  /** 打开时的初始"显示答案"勾选态（可选，默认 false）— Wave2b 工作台右栏联动 */
  initialShowAnswer?: boolean
  /** 打开时的初始"显示解析"勾选态（可选，默认 false）— Wave2b 工作台右栏联动 */
  initialShowExplain?: boolean
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
}>()

// ── 渲染模式 ────────────────────────────────────────────────────────────────
// PRD §0.4 misikt 真站铁证：预览模态 + PDF 均为纯图模式（pdftotext 提取 0 文本 / 全位图）。
// V1 仅支持 image-only 模式；富文本模式待 B-014 录题完成后再考虑。
const RENDER_MODE = 'image-only' as const

// ── 状态 ────────────────────────────────────────────────────────────────────
const loading = ref(false)
const exporting = ref(false)
const exportProgress = ref('')
const showAnswer = ref(false)
const showExplain = ref(false)
const questions = ref<QuestionDetail[]>([])
const groups = ref<{ tagName: string; items: QuestionDetail[] }[]>([])
const previewRoot = ref<HTMLElement | null>(null)

// 当前日期 YYYY-MM-DD
const today = (() => {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
})()


// 按 basket ids 入参顺序 reorder（兜底 BE 不保序场景；BE 走 FIND_IN_SET 已保序，此处冗余兜底）
function reorderByIds(items: QuestionDetail[], orderIds: number[]): QuestionDetail[] {
  const map = new Map<number, QuestionDetail>()
  for (const q of items) map.set(q.id, q)
  const result: QuestionDetail[] = []
  for (const id of orderIds) {
    const q = map.get(id)
    if (q) result.push(q)
  }
  // BE 漏返兜底 — 多出来的（理论 ≤ 0，软删过滤除外）追加末尾
  for (const q of items) {
    if (!orderIds.includes(q.id)) result.push(q)
  }
  return result
}

// 按 freeTags[0].name 分组（PRD §0 / §3.3 分组逻辑）
// - 有 freeTag → 进对应 group（按首次出现顺序）
// - 无 freeTag → 进 "其他" 段，"其他" 段必须排最后
function groupByFreeTag(qs: QuestionDetail[]): { tagName: string; items: QuestionDetail[] }[] {
  const tagMap = new Map<string, QuestionDetail[]>()
  const others: QuestionDetail[] = []
  for (const q of qs) {
    const tags: FreeTagVo[] | null | undefined = q.freeTags
    const firstTag = tags && tags.length > 0 ? tags[0].name : null
    if (firstTag) {
      if (!tagMap.has(firstTag)) tagMap.set(firstTag, [])
      tagMap.get(firstTag)!.push(q)
    } else {
      others.push(q)
    }
  }
  const result: { tagName: string; items: QuestionDetail[] }[] = []
  for (const [tagName, items] of tagMap) result.push({ tagName, items })
  if (others.length > 0) result.push({ tagName: '其他', items: others })
  return result
}

// 全卷连续序号 — 给每 group items 顺次编号（不是组内编号）
function globalIndex(groupIdx: number, itemIdx: number): number {
  let count = 0
  for (let i = 0; i < groupIdx; i++) count += groups.value[i].items.length
  return count + itemIdx + 1
}

// ── onOpen 流程 ─────────────────────────────────────────────────────────────
// 1. loading=true
// 2. fetch /teacher/question/list?ids=xxx
// 3. reorder 按 basket 入参顺序
// 4. 按 freeTag 分组
// 5. nextTick + typesetPaperPreview（等 DOM 渲染完再 typeset MathJax）
// 6. loading=false
async function loadAndRender() {
  if (!props.ids || props.ids.length === 0) {
    questions.value = []
    groups.value = []
    return
  }
  loading.value = true
  try {
    const raw = await questionListByIds(props.ids)
    const list: QuestionDetail[] = Array.isArray(raw) ? raw : []
    questions.value = reorderByIds(list, props.ids)
    groups.value = groupByFreeTag(questions.value)
    await nextTick()
    if (previewRoot.value) {
      await typesetPaperPreview(previewRoot.value)
    }
  } catch (e) {
    console.error('[PaperPreview] load failed', e)
    ElMessage.error('试题数据加载失败，请稍后重试')
    questions.value = []
    groups.value = []
  } finally {
    loading.value = false
  }
}

// visible 由 false → true 触发 fetch；true → false 不清数据（保留以便下次打开省一次 fetch — 但 ids 变了仍重 fetch）
const lastLoadedIds = ref<string>('')
watch(
  () => props.visible,
  async (vis) => {
    if (!vis) return
    // 打开时同步外部传入的初始勾选态（外部未传则保持内部已有值）
    if (props.initialShowAnswer !== undefined) showAnswer.value = props.initialShowAnswer
    if (props.initialShowExplain !== undefined) showExplain.value = props.initialShowExplain
    const idsKey = props.ids.join(',')
    if (idsKey === lastLoadedIds.value && questions.value.length > 0) {
      // 同一组 ids 已加载过 — 跳过 fetch，只重 typeset 一次（防上次切走 MathJax 残留）
      await nextTick()
      if (previewRoot.value) await typesetPaperPreview(previewRoot.value)
      return
    }
    lastLoadedIds.value = idsKey
    await loadAndRender()
  },
)

// ── 按钮交互 ────────────────────────────────────────────────────────────────
function handleClose() {
  emit('update:visible', false)
}

// 段⑤ jsPDF + html2canvas 工艺管线（开发组长波 3 自接手 — utils/pdf-export.ts）
// 工艺铁律：① await MathJax typeset ② await all <img> onload ③ html2canvas scale=2 ④ jsPDF a4 分页 ⑤ save
async function handleExportPdf() {
  if (exporting.value) return
  if (!previewRoot.value) {
    ElMessage.error('预览未就绪，无法导出')
    return
  }
  if (groups.value.length === 0) {
    ElMessage.warning('暂无试题数据，无法导出')
    return
  }
  exporting.value = true
  exportProgress.value = '准备中…'
  try {
    // 🔴 2026-06-05：内容超过「一张截图带」(>28000px ≈ 多带，如 80+ 题大卷) 时，前端逐带截图+分页耗时较长，
    //   导出期间会阻塞主线程。导出前先弹提示让用户心里有数（最优解是后端异步生成，目前未设计，后期再说）。
    //   阈值与 pdf-export.ts 的 BAND_BUDGET_CSS(28000) 对齐 = 超过一带就提示。
    const LARGE_CONTENT_PX = 28000
    if (previewRoot.value.scrollHeight > LARGE_CONTENT_PX) {
      ElMessage.warning({
        message: '试卷内容较大，导出预计需要 1–2 分钟，请耐心等待，期间请勿关闭或刷新页面',
        duration: 8000,
      })
      // 让提示先渲染出来，再开始阻塞式截图（否则提示要等首带截完才显示）
      await nextTick()
      await new Promise((r) => setTimeout(r, 80))
    }
    const filename = (props.paperName || '未命名草稿').trim()
    await exportPaperToPdf({
      root: previewRoot.value,
      filename,
      onProgress: (msg) => { exportProgress.value = msg },
    })
    ElMessage.success(`PDF 已导出：${filename}.pdf`)
  } catch (e) {
    console.error('[PaperPreview] export PDF failed', e)
    const reason = e instanceof Error ? e.message : String(e)
    ElMessage.error(`PDF 导出失败：${reason}`)
  } finally {
    exporting.value = false
    exportProgress.value = ''
  }
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    fullscreen
    :show-close="true"
    :close-on-click-modal="false"
    :close-on-press-escape="true"
    class="paper-preview-dialog"
    @update:model-value="(v: boolean) => emit('update:visible', v)"
  >
    <template #header>
      <div class="pp-header">
        <div class="pp-header-left">
          <span class="pp-paper-name">{{ paperName }}</span>
          <span class="pp-date">{{ today }}</span>
        </div>
        <div class="pp-header-right">
          <el-checkbox v-model="showAnswer">显示答案</el-checkbox>
          <el-checkbox v-model="showExplain">显示解析</el-checkbox>
        </div>
      </div>
    </template>

    <div v-loading="loading" element-loading-text="试题加载中..." class="pp-body">
      <div ref="previewRoot" class="paper-preview-content">
        <div v-if="!loading && groups.length === 0" class="pp-empty">
          暂无试题数据
        </div>

        <section
          v-for="(group, gIdx) in groups"
          :key="`g-${gIdx}-${group.tagName}`"
          class="pp-group"
        >
          <!-- 单组（如卷库整卷无 freeTag → 全归"其他"）不显标题，避免冒出无意义的"其他"分段头 -->
          <h3 v-if="groups.length > 1" class="pp-group-title">{{ group.tagName }}</h3>
          <div
            v-for="(q, qIdx) in group.items"
            :key="q.id"
            class="pp-question"
          >
            <!-- 题号（全卷连续序号，不显示题型标签）= flex 行左列 -->
            <span class="pp-q-no">{{ globalIndex(gIdx, qIdx) }}.</span>
            <!-- 内容列（题干/答案/解析）= flex 行右列，与题号顶对齐，消除号与题干错位 -->
            <div class="pp-q-content">

            <!-- ── 纯图模式（PRD §0.4 misikt 真站铁证，当前默认）──────────────── -->
            <!-- 🟢 hotfix-4：图 URL 经 proxyImage() 改写走 BE /teacher/image-proxy 同源化（PRD §10.2 坑 #12）。 -->
            <!-- 同源 image 默认 canvas 不 tainted，html2canvas 截图无 CORS 边界问题；crossorigin 属性可去亦可留（保留更安全）。 -->
            <!-- BE 端 ImageProxyController.java 走 Redis 24h 缓存 + SSRF 白名单。 -->
            <template v-if="RENDER_MODE === 'image-only'">
              <!-- 题干图（已含选项 + LaTeX 渲染） -->
              <div class="pp-q-stem">
                <img
                  v-if="q.stemImg"
                  :src="proxyImage(q.stemImg)"
                  alt="题干图"
                  class="stem-img"
                />
                <span v-else class="pp-q-missing">该题缺题干图（请联系管理员补图）</span>
              </div>

              <!-- 答案图 — checkbox 控显隐 -->
              <div v-show="showAnswer" class="pp-q-answer">
                <span class="label">【答案】</span>
                <img
                  v-if="q.answerImg"
                  :src="proxyImage(q.answerImg)"
                  alt="答案图"
                  class="ans-img"
                />
                <span v-else class="placeholder">（无答案图）</span>
              </div>

              <!-- 解析图 — checkbox 控显隐 -->
              <div v-show="showExplain" class="pp-q-explain">
                <span class="label">【解析】</span>
                <img
                  v-if="q.explainImg"
                  :src="proxyImage(q.explainImg)"
                  alt="解析图"
                  class="exp-img"
                />
                <span v-else class="placeholder">（无解析图）</span>
              </div>
            </template>

            </div>
          </div>
        </section>
      </div>
    </div>

    <template #footer>
      <div class="pp-footer">
        <span v-if="exporting" class="pp-export-progress">{{ exportProgress }}</span>
        <el-button :disabled="exporting" @click="handleClose">取消</el-button>
        <el-button
          type="primary"
          :icon="Download"
          :loading="exporting"
          :disabled="loading || groups.length === 0"
          @click="handleExportPdf"
        >
          {{ exporting ? '导出中…' : '导出 PDF' }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.paper-preview-dialog :deep(.el-dialog__body) {
  padding: 0;
  background: #f5f7fa;
}

.pp-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  padding-right: 40px;
}

.pp-header-left {
  display: flex;
  align-items: baseline;
  gap: 16px;
}

.pp-paper-name {
  font-size: 18px;
  font-weight: 600;
  color: #1d2129;
}

.pp-date {
  font-size: 13px;
  color: #86909c;
}

.pp-header-right {
  display: flex;
  gap: 16px;
}

.pp-body {
  min-height: calc(100vh - 130px);
  padding: 24px 40px;
}

.paper-preview-content {
  max-width: 880px;
  margin: 0 auto;
  background: #fff;
  padding: 40px 56px;
  box-shadow: 0 1px 8px rgba(0, 0, 0, 0.06);
  border-radius: 4px;
  min-height: 600px;
}

.pp-empty {
  text-align: center;
  padding: 80px 0;
  color: #c9cdd4;
}

.pp-group {
  margin-bottom: 32px;
}

.pp-group-title {
  font-size: 16px;
  font-weight: 600;
  color: #1d2129;
  padding-bottom: 8px;
  border-bottom: 2px solid #4080ff;
  margin: 0 0 16px;
}

.pp-question {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 12px 0;
  border-bottom: 1px dashed #f0f1f3;
  page-break-inside: avoid;
}

.pp-question:last-child {
  border-bottom: none;
}

.pp-q-no {
  flex-shrink: 0;
  font-weight: 600;
  color: #1d2129;
  font-size: 15px;
  line-height: 1.8;       /* 与题干行高一致，号与题干首行顶对齐 */
}

.pp-q-content {
  flex: 1;
  min-width: 0;           /* flex 子项防止图片撑破换行 */
}

.pp-q-stem {
  font-size: 14px;
  color: #1d2129;
  line-height: 1.8;
  word-break: break-word;
}

.pp-q-stem :deep(p) {
  margin: 0;
}

.pp-q-stem :deep(img) {
  /* 🔴 2026-06-05 铁则：试卷图文不压缩 — 去掉 max-height 高度上限(原 280px 会等比缩图丢信息)，仅按列宽兜底防溢出 */
  max-width: 100%;
  height: auto;
  vertical-align: middle;
}

.stem-img {
  display: block;
  /* 🔴 2026-06-05 铁则：试卷图文不压缩 — 去掉 max-height:280px(会压扁大图)。用 max-width:100%+height:auto：
     大图填满列宽=清晰，小图保持原始尺寸=不强制放大不模糊(不上不下,均不损质)。 */
  max-width: 100%;
  height: auto;
  margin-top: 0;          /* 题号已同行左列，题干图不再下移，消除错位 */
  border-radius: 4px;
}

.pp-q-options {
  list-style: none;
  padding: 8px 0 0 0;
  margin: 0;
}

.pp-q-option {
  display: flex;
  gap: 8px;
  padding: 4px 0;
  font-size: 14px;
  line-height: 1.7;
  color: #1d2129;
}

.opt-key {
  font-weight: 600;
  min-width: 22px;
}

.pp-q-answer,
.pp-q-explain {
  margin-top: 10px;
  padding: 8px 12px;
  background: #f7f8fa;
  border-left: 3px solid #4080ff;
  font-size: 14px;
  line-height: 1.8;
  color: #4e5969;
}

.pp-q-explain {
  border-left-color: #00b42a;
}

.pp-q-answer .label,
.pp-q-explain .label {
  font-weight: 600;
  color: #1d2129;
  margin-right: 6px;
}

.ans-img,
.exp-img {
  display: block;
  /* 🔴 2026-06-05 铁则：试卷图文不压缩 — 解析/答案图是整段解答(正文+图,原始~2007×900+)，原 max-height:200px
     先触发把整图等比缩到 200px 高 → 宽缩到~430px 挤左窄条、字小看不清。去掉高度上限，max-width:100%+height:auto：
     大图填满列宽=清晰，小图保持原尺寸=不放大不模糊。 */
  max-width: 100%;
  height: auto;
  margin-top: 6px;
}

.placeholder {
  color: #c9cdd4;
  font-style: italic;
}

.pp-q-missing {
  display: inline-block;
  padding: 6px 10px;
  background: #fff7e6;
  border: 1px dashed #ff9000;
  border-radius: 4px;
  color: #ff9000;
  font-size: 13px;
}

.pp-footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 12px;
}

.pp-export-progress {
  font-size: 12px;
  color: #4080ff;
  margin-right: auto;
}
</style>
