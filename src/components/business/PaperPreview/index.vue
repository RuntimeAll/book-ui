<script setup lang="ts">
// ────────────────────────────────────────────────────────────────────────────
// Q' 卡 段③ + 段④ FE 产物 — 试卷预览模态（el-dialog 全屏）
//   段③ 骨架：el-dialog + 顶部 paperName / 日期 / 答案&解析 checkbox + 底部按钮 + loading
//   段④ 渲染：onOpen fetch /teacher/question/list?ids=xxx → 按 basket 入参顺序 reorder
//             → 按 freeTags[0].name 分组（"其他"段末尾）→ v-html 渲染 → typesetPaperPreview
//   段⑤ PDF 工艺：本组件不实现，按钮 click handler stub（开发组长波 3 自接手）
// ────────────────────────────────────────────────────────────────────────────
import { ref, computed, nextTick, watch, onMounted, onUnmounted } from 'vue'
import { ElMessage, ElNotification } from 'element-plus'
import { Download } from '@element-plus/icons-vue'
import {
  questionListByIds,
  type QuestionDetail,
  type FreeTagVo,
} from '@/api/question'
import { typesetPaperPreview } from '@/utils/mathjax'
import { exportPaperToPdf } from '@/utils/pdf-export'
import { proxyImage } from '@/utils/image-proxy'
import { parseBlockDoc, type QuestionBlockDoc } from '@/utils/blockSchema'
import QuestionBlockRender from '@/components/business/QuestionBlockRender/index.vue'
import { useUserStore } from '@/store/user'
import { getCurrentUser } from '@/api/user'
// PRD-A-014 异步导出 API（2026-06-11 用户拍板去掉导出配置弹窗：导出直接用页面状态——
// 标题可编辑=文件名、显示答案/解析勾选=导出内容、水印开关；点导出即提交+原地赛跑轮询）
import { submitExport, getExportRecord, type ExportRecordVO } from '@/api/export'

const props = defineProps<{
  visible: boolean
  paperName: string
  // PRD-A-013 T2 — 雪花 ID string[]
  ids: string[]  // basket 提供的题目 id 列表（入参顺序 = 显示顺序）
  /** PRD-A-014 T2 — 整卷导出时传卷 ID（可选，自选题集不传） */
  paperId?: string
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

// ── 用户 store（水印用） ──────────────────────────────────────────────────────
const userStore = useUserStore()

// 🔴 onMounted 兜底：userInfo 是内存态，F5 刷新后会丢（A-002 老坑）
onMounted(async () => {
  if (!userStore.userInfo) {
    try {
      const user = await getCurrentUser()
      userStore.setUserInfo(user)
    } catch (e) {
      console.warn('[PaperPreview] getCurrentUser failed', e)
    }
  }
})

/**
 * PRD-A-015：结构化网格块文档（有 blockJson 且合法时返文档，否则 null）。
 * 非空 → 该题走 QuestionBlockRender 结构化渲染（KaTeX 同步入 DOM，html2canvas 直接截到）；
 * null → 回落原 image-only（stemImg）。
 */
function blockDocOf(q: QuestionDetail): QuestionBlockDoc | null {
  return parseBlockDoc(q.blockJson)
}

// PRD-C-204：答案/解析结构化块文档（统一富文本格式化层）。非空 → QuestionBlockRender；否则回落旧答案/解析图。
function answerDocOf(q: QuestionDetail): QuestionBlockDoc | null {
  return parseBlockDoc(q.answerBlockJson)
}
function analyzeDocOf(q: QuestionDetail): QuestionBlockDoc | null {
  return parseBlockDoc(q.analyzeBlockJson)
}

/** 手机号脱敏 138****1234 */
function maskPhone(phone?: string): string {
  if (!phone || phone.length < 7) return phone ?? ''
  return phone.slice(0, 3) + '****' + phone.slice(-4)
}

/** 水印文案：老师名 + 脱敏手机号 */
const watermarkText = computed(() => {
  const info = userStore.userInfo
  const name = info?.realName || info?.userName || '教师'
  const phone = maskPhone(info?.phone)
  return phone ? `${name}  ${phone}` : name
})

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

// 🔴 2026-06-11 用户两次拍板收口：①标题与导出文件名同源（显示什么导出就叫什么）；
// ②导出配置弹窗整个去掉 → 标题升级为 header 里可直接编辑的 input，编辑结果即导出文件名。
const fileName = ref('')

// 水印开关（header 控制台，默认开；导出与预览水印层同走此开关）
const watermark = ref(true)


// 按 basket ids 入参顺序 reorder（兜底 BE 不保序场景；BE 走 FIND_IN_SET 已保序，此处冗余兜底）
// PRD-A-013 T2 — id / orderIds 雪花 string
function reorderByIds(items: QuestionDetail[], orderIds: string[]): QuestionDetail[] {
  const map = new Map<string, QuestionDetail>()
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
    // 标题（=导出文件名）每次打开重置为卷名，用户可在 header 直接改
    fileName.value = (props.paperName || '').trim() || '未命名草稿'
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
    const filename = fileName.value.trim() || '未命名草稿'
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

// ── PRD-A-014 异步导出（2026-06-11 弹窗去除版：导出直接用页面状态） ─────────────
// 赛跑窗口：提交 → 1s 间隔轮询 ≤10 次；10s 内 done → 直接下载；超时 → 转后台 + 通知去向；
// 失败 → 错误提示。轮询不因关预览中断（用户发起的导出照常送达）。

const MAX_POLL = 10        // 最多 10 次 = 10 秒
const POLL_INTERVAL = 1000 // 1 秒

let pollTimer: ReturnType<typeof setTimeout> | null = null

function clearPoll() {
  if (pollTimer !== null) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}

onUnmounted(clearPoll)

/** 触发浏览器下载 */
function triggerDownload(fileUrl: string, name: string) {
  const a = document.createElement('a')
  a.href = fileUrl
  a.download = name.endsWith('.pdf') ? name : `${name}.pdf`
  a.target = '_blank'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

/** 把 estimatedSeconds 换算成人话 */
function humanizeSeconds(secs: number): string {
  if (secs <= 0) return '稍后'
  if (secs < 60) return `约 ${secs} 秒`
  return `约 ${Math.round(secs / 60)} 分钟`
}

function finishExportState() {
  exporting.value = false
  exportProgress.value = ''
}

/** 轮询单条记录直到 done/failed/超次数（超时转后台通知） */
function pollRecord(recordId: string, estimatedSeconds: number, name: string) {
  let count = 0

  const doOnePoll = async () => {
    count++
    let record: ExportRecordVO | null = null
    try {
      record = await getExportRecord(recordId)
    } catch (e) {
      // 网络抖动：继续轮询，但不超总次数
      console.warn('[PaperPreview] export poll failed', e)
    }

    if (record?.status === '2') {
      clearPoll()
      finishExportState()
      triggerDownload(record.fileUrl!, name)
      ElMessage.success(`PDF 已生成：${name}.pdf`)
      return
    }

    if (record?.status === '3') {
      clearPoll()
      finishExportState()
      ElMessage.error(`导出失败：${record.errorMsg || '未知错误'}`)
      return
    }

    if (count >= MAX_POLL) {
      // 10s 未完 → 转后台，通知去向
      clearPoll()
      finishExportState()
      ElNotification({
        title: `《${name}》正在后台生成`,
        message: `预计 ${humanizeSeconds(estimatedSeconds)}，完成后请前往 我的工作台→导出记录 下载。`,
        type: 'info',
        duration: 0,
        onClick: () => {
          import('@/router').then(({ default: router }) => {
            router.push('/workspace')
          })
        },
      })
      return
    }

    pollTimer = setTimeout(doOnePoll, POLL_INTERVAL)
  }

  // 第一次延迟 1s 再查（刚提交立刻查大概率还在排队）
  pollTimer = setTimeout(doOnePoll, POLL_INTERVAL)
}

/** 「导出 PDF」直接提交异步任务（无弹窗，所见即所得） */
async function handleAsyncExport() {
  if (exporting.value) return
  const name = fileName.value.trim()
  if (!name) {
    ElMessage.warning('请先填写试卷标题（即导出文件名）')
    return
  }
  if (props.ids.length === 0 || groups.value.length === 0) {
    ElMessage.warning('暂无试题数据，无法导出')
    return
  }

  exporting.value = true
  exportProgress.value = '提交中…'
  try {
    const resp = await submitExport({
      paperId: props.paperId,
      ids: props.ids,
      fileName: name,
      showAnswer: showAnswer.value,
      showExplain: showExplain.value,
      watermark: watermark.value,
    })
    exportProgress.value = '生成中…'
    pollRecord(resp.recordId, resp.estimatedSeconds, name)
  } catch (e) {
    // BE 业务错误（如并发 1 限制）拦截器已弹 toast，此处只收尾状态
    console.error('[PaperPreview] submitExport failed', e)
    finishExportState()
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
    <!-- 🔴 2026-06-11 用户反馈"导出按钮太下面几乎找不到"：原导出按钮在 footer，长卷要滚到最底。
         收口=导出/进度并入顶部控制台（与显示答案/解析同排），header 固定、正文区独立滚动（见 style flex）。 -->
    <template #header>
      <div class="pp-header">
        <div class="pp-header-left">
          <!-- 2026-06-11 弹窗去除：标题直接可编辑，编辑结果即导出文件名（所见即所得） -->
          <el-input
            v-model="fileName"
            class="pp-name-input"
            maxlength="100"
            placeholder="试卷标题（即导出文件名）"
            :disabled="exporting"
          />
          <span class="pp-date">{{ today }}</span>
        </div>
        <div class="pp-header-right">
          <el-checkbox v-model="showAnswer">显示答案</el-checkbox>
          <el-checkbox v-model="showExplain">显示解析</el-checkbox>
          <span class="pp-wm-switch">
            <span class="pp-wm-label">水印</span>
            <el-switch v-model="watermark" size="small" />
          </span>
          <el-divider direction="vertical" />
          <span v-if="exporting" class="pp-export-progress">{{ exportProgress }}</span>
          <!-- 2026-06-11 弹窗去除：导出直接用页面当前状态提交异步任务（赛跑窗口） -->
          <el-button
            type="primary"
            :icon="Download"
            :loading="exporting"
            :disabled="loading || groups.length === 0"
            @click="handleAsyncExport"
          >
            导出 PDF
          </el-button>
        </div>
      </div>
    </template>

    <div v-loading="loading" element-loading-text="试题加载中..." class="pp-body">
      <!-- PRD-A-014 §5 — 预览水印层：absolute 平铺，pointer-events:none。
           2026-06-11 起跟 header 水印开关联动（开关即时反馈，导出同走此值）。 -->
      <div v-if="watermark" class="pp-watermark" aria-hidden="true">
        <span
          v-for="n in 40"
          :key="n"
          class="pp-watermark-text"
        >{{ watermarkText }}</span>
      </div>
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
                <!-- PRD-A-015：结构化网格块题(个人题) → QuestionBlockRender(权威, 含选项); 否则回落题干图 -->
                <QuestionBlockRender
                  v-if="blockDocOf(q)"
                  :doc="blockDocOf(q)!"
                  :proxy="true"
                />
                <img
                  v-else-if="q.stemImg"
                  :src="proxyImage(q.stemImg)"
                  alt="题干图"
                  class="stem-img"
                />
                <!-- 纯文本题（AI 变式 / 举一反三入库）无题干图，但有 stemText → 提示「功能未覆盖」而非「系统故障」 -->
                <span v-else-if="q.stemText" class="pp-q-textonly">
                  AI 生成题为纯文本题，PDF 图片导出暂不支持（文本渲染开发中）；可在线查看或在组卷工作台使用
                </span>
                <!-- 真题确实缺图（图与文本皆空）→ 保留运维提示 -->
                <span v-else class="pp-q-missing">该题缺题干图（请联系管理员补图）</span>
              </div>

              <!-- 答案 — checkbox 控显隐。PRD-C-204：结构化 answerBlockJson 优先,否则回落答案图 -->
              <div v-show="showAnswer" class="pp-q-answer">
                <span class="label">【答案】</span>
                <QuestionBlockRender
                  v-if="answerDocOf(q)"
                  :doc="answerDocOf(q)!"
                  :proxy="true"
                />
                <img
                  v-else-if="q.answerImg"
                  :src="proxyImage(q.answerImg)"
                  alt="答案图"
                  class="ans-img"
                />
                <span v-else class="placeholder">（无答案图）</span>
              </div>

              <!-- 解析 — checkbox 控显隐。PRD-C-204：结构化 analyzeBlockJson 优先(选项分析/小问/步骤拆块),否则回落解析图 -->
              <div v-show="showExplain" class="pp-q-explain">
                <span class="label">【解析】</span>
                <QuestionBlockRender
                  v-if="analyzeDocOf(q)"
                  :doc="analyzeDocOf(q)!"
                  :proxy="true"
                />
                <img
                  v-else-if="q.explainImg"
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

  </el-dialog>
</template>

<style scoped>
/* 🔴 header 固定顶部 + 正文独立滚动：导出控制台永远可见，长卷不再把按钮顶出视野 */
.paper-preview-dialog {
  display: flex;
  flex-direction: column;
}

.paper-preview-dialog :deep(.el-dialog__header) {
  flex-shrink: 0;
}

.paper-preview-dialog :deep(.el-dialog__body) {
  padding: 0;
  background: #f5f7fa;
  flex: 1;
  overflow-y: auto;
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
  align-items: center;
  gap: 16px;
}

/* 标题输入框：平时看着像标题（无边框），hover/聚焦露出可编辑态 */
.pp-name-input {
  width: 340px;
}

.pp-name-input :deep(.el-input__wrapper) {
  box-shadow: none;
  background: transparent;
  padding-left: 0;
}

.pp-name-input:hover :deep(.el-input__wrapper),
.pp-name-input :deep(.el-input__wrapper.is-focus) {
  box-shadow: 0 0 0 1px #dcdfe6 inset;
  background: #fff;
  padding-left: 11px;
}

.pp-name-input :deep(.el-input__inner) {
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
  align-items: center;
  gap: 16px;
}

.pp-wm-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.pp-wm-label {
  font-size: 14px;
  color: #606266;
}

.pp-body {
  min-height: calc(100vh - 130px);
  padding: 24px 40px;
  position: relative;
}

/* PRD-A-014 T2 §5 — 预览水印层：pointer-events:none 不影响交互，absolute 平铺整个 body 区 */
.pp-watermark {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: hidden;
  z-index: 10;
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 0;
}

.pp-watermark-text {
  display: inline-block;
  font-size: 14px;
  color: rgba(30, 138, 138, 0.12);
  transform: rotate(-30deg);
  white-space: nowrap;
  width: 260px;
  margin: 40px 20px;
  user-select: none;
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
  border-bottom: 2px solid #1E8A8A;
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
  border-left: 3px solid #1E8A8A;
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
/* 纯文本题（AI 变式）导出暂不支持：信息提示而非错误红，弱化为中性灰蓝 */
.pp-q-textonly {
  display: inline-block;
  padding: 6px 10px;
  background: #f4f6f8;
  border: 1px dashed #c0c8d0;
  border-radius: 4px;
  color: #5b6770;
  font-size: 13px;
}

.pp-export-progress {
  font-size: 12px;
  color: #1E8A8A;
}
</style>
