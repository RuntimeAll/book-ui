<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import {
  composeVariantFigure,
  cropMotherFigure,
  editVariantDna,
  editVariantItem,
  fetchVariantArtifact,
  fetchVariantHistory,
  markVariantManualBlock,
  persistVariantGroup,
  persistVariantOne,
  pickMotherCard,
  regenVariant,
  reorderVariant,
  reverifyVariantItem,
  setVariantFigureUrl,
  streamVariant,
  undoRegenVariant,
  uploadMotherImage,
} from '@/api/variant'
import type { DnaEditValue, DnaField } from '@/api/variant'
import type {
  ToolkitChatMessage,
  VariantArtifact,
  VariantArtifactItem,
  VariantNeedConfirm,
  VariantReasoning,
  VariantReject,
  VariantStage,
  VariantStreamHandle,
} from '@/api/variant'
import { useQuestionBasket } from '@/composables/useQuestionBasket'
import { createQuestionWithDna, deleteQuestionBlock } from '@/api/question/index'
import type { CreateQuestionWithDnaBo, QuestionItem } from '@/api/question/index'
import MarkdownMath from '@/components/MarkdownMath.vue'
import AiStageRail from '@/components/AiStageRail.vue'
import ArtifactPanel from './ArtifactPanel.vue'
import MotherCard from './MotherCard.vue'
import GradeChapterConfirmDialog from './GradeChapterConfirmDialog.vue'

// 登录老师身份：入库 owner 走透传 token（agent_config.ruoyi_token），落老师本人个人题库。
const userStore = useUserStore()
// PRD-C-014 T2：试题篮（全局 singleton composable，与库内列表共用计数/LS）—— 透明入库后加篮、计数+1。
const basket = useQuestionBasket()
// PRD-C-100 BC3：手动排版跳 A-015 网格编辑器全页路由（/question/editor/:id）。
const router = useRouter()

// ---------------------------------------------------------------------------
// PRD-C-009/C-011 — 图片举一反三 agent（toolkit :8093 variant agent，/agent proxy）。
//
// PRD-C-011 Bucket3 双栏形态（DESIGN.md §14）：
//   左栏 = 「AI 命题搭子」聊天面板（气泡 markdown+LaTeX 叙述保留 + 思路条 + 输入）。
//   右栏 = 「变式题组 · N 道」卡片栅，数据源 = BE artifact 快照帧（铁律 2：FE 不
//          parse markdown 拼卡片），snapshot 全量整量替换。
//   🔴 统一指令通道（铁律 1）：卡片快捷键（换数字/换场景/答疑）与「全部入库」全部 =
//      utterance 预设句，走【现有 chat SSE 通道】（同 thread_id），零新增结构化端点。
//
// 思路条位置（用户反馈①）：消息流改为联合类型（气泡 | rail 锚点）。send 时 push 用户
// 气泡后立即 push 本轮 rail 锚点，onStage 只更新当前轮锚点 → 思路条钉在本轮头部
//（用户问下方、本轮 AI 产出上方），历史轮 rail 留存，不再永远沉底。
//
// 母题图入口（用户反馈②）：剪贴板 Ctrl+V 粘贴截图即传（页面级 paste 监听，复用
// uploadMotherImage + 同口径类型/10MB 校验）；「上传图片」按钮已删；URL 输入框保留。
//
// 渲染策略：agent 人话叙述仍走 AIMessage 文本块成左栏气泡（铁律 5 保留）；LLM 逐字
// token 期只显「思考中」动效，不外放原始 token（思考型模型 reasoning 不外放，有意为之）。
// ---------------------------------------------------------------------------

interface Bubble {
  type: 'bubble'
  role: 'user' | 'ai'
  kind?: 'normal' | 'error'
  text: string
  /**
   * PRD-C-013 P10：随气泡进对话流的图片（公网 URL）。母题图不再只钉顶部，发送时随用户
   * 气泡进流（~120px 缩略图，点开看大图）。BE 零改动（imageUrl 走 FE 独立字段、不进
   * messages）；会话恢复时从 localStorage per-message 注册表贴回（checkpointer 回放无图）。
   */
  images?: string[]
}

/** 本轮思路条锚点（钉在该轮用户气泡之后、AI 产出之前；历史轮留存） */
interface RailItem {
  type: 'rail'
  stages: VariantStage[]
  /**
   * 🔴 PRD-C-100 B6：本轮 AI 思考流（reasoning 增量拼接）。流式期默认展开滚动、结束自动折叠。
   * 现状 opus 经 aigeek 不吐 reasoning → 多数轮该值为空串，思考块不渲染（向后兼容）。
   */
  reasoning: string
  /** 思考块当前是否展开（流式期 true，onClose 自动置 false） */
  reasoningOpen: boolean
}

type StreamItem = Bubble | RailItem

const stream = ref<StreamItem[]>([])
const input = ref('')
const imageUrl = ref('') // URL 输入框：手贴公网图地址（回车/发送时并入 pendingImages）
// PRD-C-013 P10：待发附件缩略图（粘贴上传 / 贴 URL 都进这里）。发送时随用户气泡进流后清空。
const pendingImages = ref<string[]>([])
const motherImg = ref('') // 已发出的母题图，顶部小徽章常驻（守恒锚视觉提示）
const previewUrl = ref('') // 点开看大图（el-image-viewer / 简易遮罩）
const sending = ref(false)
const thinking = ref(false) // LLM token 流期的「思考中」动效
// 当前轮 rail 锚点（onStage 只更新它；新一轮 send 换新锚点，旧轮 rail 冻结留存）
const currentRail = ref<RailItem | null>(null)
// PRD-C-011：右栏卡片栅数据源 = artifact 快照帧（snapshot 全量，整量替换）
const artifact = ref<VariantArtifact | null>(null)

// 🔴 PRD-C-100 B6·成本相关 UI（轻量）：今日 AI 额度用尽的友好横幅。
//   SSE error 帧 reason==='budget_exceeded'（或 content 含「额度/budget」关键词）→ 置位 + 横幅外显。
//   文案直接用后端给的（含已用/上限 ¥），FE 不自拼金额。下一条成功请求时清掉。
const budgetExceeded = ref(false)
const budgetMessage = ref('')

/** 判一条 error 文案是否「今日额度用尽」（结构化 reason 缺位时按关键词兜底） */
function isBudgetError(msg: string): boolean {
  return /budget_exceeded|额度|预算用尽|余额不足/i.test(msg)
}

// ---------------------------------------------------------------------------
// 🔴 PRD-C-017 B3 — 母题年级章确认面 + 母题卡 + 入库态。
// ---------------------------------------------------------------------------
// needConfirm 弹窗（母题每次必停·决策表）：收到 SSE needConfirm → 弹年级册+章确认面
const needConfirmPayload = ref<VariantNeedConfirm | null>(null)
const confirmDialogVisible = ref(false)
const confirmSubmitting = ref(false) // 确认续聊回合发送中
// 母题卡：从 artifact 解出（① header.mother_card 专帧优先；② items[0].dna 兜底拼）
const motherCard = computed(() => pickMotherCard(artifact.value))
// 🔴 PRD-C-017 B5-fix2：右栏 chip 用的 artifact —— 母题卡先出专帧 header 不带人话年级名
//   （pickArtifact 只能从 anchor 回退到 grade_book_id 代码）。老师确认面亲选的年级册人话名
//   （confirmedGradeBookName）最可靠 → 覆盖 header.grade，让 chip 显「七年级上」而非代码/「未定」。
//   主考点 kp 已由 pickArtifact 从 mother_card.main_kp 回灌，无需此处再补。仅在有覆盖值时浅拷，
//   否则原样透传（不破增量帧引用，省无谓重渲染）。
const displayArtifact = computed<VariantArtifact | null>(() => {
  const a = artifact.value
  if (!a) return null
  const human = confirmedGradeBookName.value
  if (!human) return a
  return { ...a, header: { ...a.header, grade: human } }
})
// 🔴 B4-polish：老师在确认面亲手选的章「人话名」（如「第二章 一元二次方程」）——
// 确认时本就拿得到 chapterName/gradeBookName，存这里传给母题卡显示锚定章，最可靠、不依赖 toolkit 回灌。
const confirmedChapterName = ref('')
// 🔴 PRD-C-017 B5：老师确认面亲选的年级册人话名（如「七年级上」）——chip 年级显示 + 续聊回合
//   回传 toolkit（grade_book_name）同步年级，不依赖 toolkit 回灌 header.grade。
const confirmedGradeBookName = ref('')
// 母题入库态（G12）
const motherPersisting = ref(false)
const motherPersisted = ref(false)
const motherQuestionId = ref('') // 入库后的母题题 id（雪花 string）

// ---------------------------------------------------------------------------
// 🔴 PRD-C-100 B6 — 带图展示 + 图片重生（toolkit /variant/compose-figure）。
//   母题切图（crop_mother）：母题卡里展示切出的图形区。
//   变式造图（compose_variant）：每道变式按需造图 + 「图歪了？重新生成」（带 correctionPrompt）。
// ---------------------------------------------------------------------------
// 母题切图态
const motherFigurePng = ref<string | null>(null)
const motherFigureLoading = ref(false)
const motherFigureNeeds = ref(false)
const motherFigureReason = ref<string | null>(null)

// 变式图态：按题 index（1-based）存。{png, loading, needs, reason, ossUrl}
interface VariantFigureState {
  png: string | null
  loading: boolean
  needs: boolean
  reason: string | null
  /** PRD-C-100 BC2：本图已传 OSS 后的 https url（base64→OSS 只传一次，防重复入库重传） */
  ossUrl?: string | null
}
const variantFigures = reactive<Record<number, VariantFigureState>>({})

// 🔴 修1（图串台 root cause）：variantFigures 按「裸 1-based index」缓存，而 index 在「换一批」/
//   改主考点·年级重出 / onArtifact 整量替换后会被新一组题复用 —— 旧 index 的图直接套到新题上。
//   这里记下「该 index 当前缓存的图是为哪条题面（stem）生成的」，onArtifact 收到新快照时逐 index 比对，
//   凡题面变了的 index 一律作废它的旧图（删 variantFigures[index]），让新题用自己的题面重画，不复用旧图。
//   选 (a)「按 stem 比对作废」而非 (b)「换 key」：因为「换一批」是新的一组题、seq 仍从 1 重排，
//   seq/index 都不足以区分新旧题，唯有题面 stem 是真正的内容信号；且所有变更路径都汇流到 onArtifact，
//   在此一处兜底最稳、partial 增量帧也天然覆盖（某题 stem 跨帧变化只作废它自己）。
const figureStemAtIndex = reactive<Record<number, string>>({})

// 🔴 修2（第一张图直出）：每「一组」变式只自动触发一次首图（母题切图 + 第一道变式造图），
//   用一次性 guard 防 reactivity tick 重复打。换一批 / 改范围 = 新的一组 → guard 重置后重新自动出第一张。
//   这两个 guard 在 onArtifact 检测到「新的一组题」（首题题面变了）时复位，clearCanvas 也复位。
let autoCropMotherDone = false
let autoComposeFirstDone = false

/**
 * 修1 核心：onArtifact 整量替换前，按 stem 作废受影响 index 的旧配图。
 *   - 新快照里某 index 的 stem ≠ 该 index 已缓存图对应的 stem → 删 variantFigures[index]（旧图作废）。
 *   - 当前快照里不存在的 index（题被删 / 组变小）→ 连带清掉残留图，免下一组复用。
 *   - 首题（index 最小，通常 1）题面变了 = 这是「新的一组」→ 复位 autoComposeFirstDone，让首图重新自动出。
 *   纯 partial 增量帧（同组逐题上屏）里 stem 不变 → 不误删已生成的图（只新增 index 登记）。
 */
function invalidateStaleFigures(next: VariantArtifact | null) {
  const items = next?.items ?? []
  const nextStems = new Map<number, string>()
  for (const it of items) nextStems.set(it.index, it.stem || '')

  // 1) 当前快照已不含的 index：清残留图 + 登记
  for (const k of Object.keys(variantFigures)) {
    const idx = Number(k)
    if (!nextStems.has(idx)) {
      delete variantFigures[idx]
      delete figureStemAtIndex[idx]
    }
  }
  // 2) 题面变了的 index：作废旧图（让新题用自己的题面重画）
  let firstItemChanged = false
  const minIndex = items.length ? Math.min(...items.map((it) => it.index)) : 0
  for (const [idx, stem] of nextStems) {
    const prev = figureStemAtIndex[idx]
    if (prev !== undefined && prev !== stem) {
      delete variantFigures[idx] // 旧图作废，绝不串到新题
      if (idx === minIndex) firstItemChanged = true
    }
    figureStemAtIndex[idx] = stem
  }
  // 3) 首题题面变了 = 新的一组 → 复位首图自动 guard（换一批 / 改范围重出后重新直出第一张）
  if (firstItemChanged) autoComposeFirstDone = false
}

function ensureVariantFigure(index: number): VariantFigureState {
  if (!variantFigures[index]) {
    variantFigures[index] = { png: null, loading: false, needs: false, reason: null, ossUrl: null }
  }
  return variantFigures[index]
}

/**
 * 修2：拿到一组题后，自动出「第一张图」（低频=至少一张，不全手动）。
 *   - 母题「切图形」：母题确有原图（motherImg 非空）且本组未自动切过 → 触发一次 cropMotherFigure。
 *   - 变式第一道造图：当前快照已有变式题、第一道尚无图、本组未自动造过 → 触发一次 composeVariantFigure。
 *   每组只触发一次（autoCropMotherDone / autoComposeFirstDone 一次性 guard），且只对还没图的题触发；
 *   定稿帧才自动造变式图（partial 增量帧首题题面可能还在变，等定稿再造避免造废）。母题切图便宜，不 gate partial。
 */
function maybeAutoFirstFigures(a: VariantArtifact | null) {
  // 母题切图（裁图便宜，没理由 gate；母题原图在即可，partial/定稿都可）
  if (!autoCropMotherDone && motherImg.value && !motherFigurePng.value && !motherFigureLoading.value) {
    autoCropMotherDone = true
    void onCropMotherFigure()
  }
  // 变式第一道造图：仅定稿帧（无 partial）才自动造，避免对还在变的增量首题造废图
  if (a && !a.partial && !autoComposeFirstDone && a.items.length) {
    const first = a.items.reduce((m, it) => (it.index < m.index ? it : m), a.items[0])
    const st = variantFigures[first.index]
    const hasFig = !!(st && st.png)
    if (!hasFig && !(st && st.loading)) {
      autoComposeFirstDone = true
      void onComposeVariantFigure({ index: first.index })
    }
  }
}

/**
 * PRD-C-100 BC2：入库前把该题已生成的配图 base64 传 OSS → 回写 toolkit state.figure_url，
 * 这样 BE build_create_bo 才能据 figure_url 产 A-015 image 块。
 *   - 该题无配图 base64（纯文本变式）→ 直接返回，不调任何接口（无 image 块，符合契约）。
 *   - 已传过（ossUrl 在）→ 复用，不重传。
 *   - 上传/回写失败 → 抛错（由调用方落到 persist 的 catch，提示老师，不静默丢图）。
 * PNG 无损：data:image/png;base64 → Blob → File(image/png) → uploadMotherImage（走 OSS 公读桶）。
 */
async function flushFigureToOss(index: number): Promise<void> {
  const st = variantFigures[index]
  if (!st || !st.png) return // 纯文本变式或未造图：无 image 块
  let url = st.ossUrl || ''
  if (!url) {
    const blob = await (await fetch(`data:image/png;base64,${st.png}`)).blob()
    const file = new File([blob], `variant_fig_${index}.png`, { type: 'image/png' })
    const up = await uploadMotherImage(file)
    url = up.url
    st.ossUrl = url
  }
  await setVariantFigureUrl(threadId.value, index, url)
}

/** 母题切图（crop_mother）：从母题原图切出图形区。重切=再调一次。 */
async function onCropMotherFigure() {
  if (motherFigureLoading.value || !motherImg.value) return
  motherFigureLoading.value = true
  motherFigureReason.value = null
  try {
    const res = await cropMotherFigure(threadId.value, userStore.accessToken, motherImg.value)
    motherFigurePng.value = res.pngBase64
    motherFigureNeeds.value = res.needsFigure && !res.pngBase64
    motherFigureReason.value = res.reason
  } catch (e) {
    motherFigureReason.value = `切图失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    motherFigureLoading.value = false
  }
}

/**
 * 变式造图（compose_variant）：为某道变式造配图。correctionPrompt 非空 = 图片重生（人在回路）。
 */
async function onComposeVariantFigure(payload: { index: number; correctionPrompt?: string }) {
  const st = ensureVariantFigure(payload.index)
  if (st.loading) return
  const item = findItem(payload.index)
  if (!item) return
  st.loading = true
  st.reason = null
  try {
    const res = await composeVariantFigure(threadId.value, userStore.accessToken, {
      stem: item.stem,
      answer: item.answer || undefined,
      itemId: item.seq || item.index,
      correctionPrompt: payload.correctionPrompt,
    })
    st.png = res.pngBase64
    st.needs = res.needsFigure && !res.pngBase64
    st.reason = res.reason
  } catch (e) {
    // 🔴 PRD-C-100 B3-配图：失败也落「⚠待补图」徽章（对齐 D9 降级 UI，不静默无图），
    //   错误可读（API 已把 422 结构化 detail 摊成 message，不再 [object Object]）。
    st.needs = true
    st.reason = `配图失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    st.loading = false
  }
}
// 题组编辑器：正在重新验算的题 index（1-based），驱动该卡 loading 态
const reverifyingIndex = ref<number | null>(null)
// PRD-C-014 T1/T2：正在「收录入库」/「加入试题篮」的题 index（1-based），驱动该卡按钮 loading
const persistingIndex = ref<number | null>(null)
const basketingIndex = ref<number | null>(null)
// PRD-C-015 批5：正在重生的题号集合（1-based），驱动命中卡 loading + 重生按钮转圈
const regeneratingIndexes = ref<number[]>([])
const streamRef = ref<HTMLElement | null>(null)

const currentRailEmpty = computed(
  () => !currentRail.value || currentRail.value.stages.length === 0
)

// ---------------------------------------------------------------------------
// 母题图：剪贴板粘贴上传（BE /teacher/variant/upload-image → 公读 OSS URL）
// ---------------------------------------------------------------------------
const uploading = ref(false)

const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024

async function uploadPastedImage(file: File) {
  // 客户端先挡一道（BE 同口径再硬校验）；截图粘贴通常是 image/png
  if (!UPLOAD_TYPES.includes(file.type)) {
    ElMessage.error('仅支持 jpg / png / webp / gif 图片')
    return
  }
  if (file.size > UPLOAD_MAX_BYTES) {
    ElMessage.error('图片不能超过 10MB')
    return
  }
  if (uploading.value) return
  uploading.value = true
  try {
    const { url } = await uploadMotherImage(file)
    // P10：进「待发附件」缩略图区（可删），发送时随用户气泡进流
    if (!pendingImages.value.includes(url)) pendingImages.value.push(url)
    ElMessage.success('截图已上传，已加入待发附件，回车即可出题')
  } catch {
    // 失败 toast 由 http 拦截器统一弹，这里只收 loading
  } finally {
    uploading.value = false
  }
}

/** 移除一张待发附件 */
function removePending(url: string) {
  pendingImages.value = pendingImages.value.filter((u) => u !== url)
}

/** 把 URL 输入框里手贴的公网图地址并入待发附件（发送 / 失焦时调用，去重 + 清空输入框） */
function commitUrlInput() {
  const url = imageUrl.value.trim()
  if (!url) return
  if (!/^https?:\/\//i.test(url)) return // 非法地址留在输入框，不入队
  if (!pendingImages.value.includes(url)) pendingImages.value.push(url)
  imageUrl.value = ''
}

/** 页面级 paste 监听：输入框 / 页面任意处 Ctrl+V 截图均可触发 */
function onPaste(e: ClipboardEvent) {
  if (sending.value) return
  const items = e.clipboardData?.items
  if (!items) return
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const file = it.getAsFile()
      if (file) {
        e.preventDefault()
        void uploadPastedImage(file)
      }
      return
    }
  }
}

onMounted(() => document.addEventListener('paste', onPaste))

// ---------------------------------------------------------------------------
// 会话注册表（用户反馈③④ 2026-06-11）：BE checkpointer（sqlite）一直按 thread_id
// 持久着全部对话 —— 缺的只是 FE 这边「记住 thread_id + 取回」。注册表落 localStorage
//（id/标题/时间/母题图），刷新恢复上次会话；历史会话可切换/删除（删的只是本地索引，
// BE checkpoint 不动）。气泡回放走 /history，右栏卡片重建走 /variant/artifact。
// ---------------------------------------------------------------------------

interface SessionMeta {
  id: string
  title: string
  at: number // 最近活跃时间戳
  img?: string // 母题图（列表缩略 + 恢复时回填顶部）
}

const SESSIONS_KEY = 'variant.sessions.v1'
const ACTIVE_KEY = 'variant.active.v1'
// PRD-C-013 P10：per-message 图片注册表。BE checkpointer 回放的 messages 没有图（imageUrl
// 走 FE 独立字段、不进 messages）→ 把每条「带图的用户消息」的 URL 按发送序存这里，恢复时按
// 用户气泡序贴回。结构 = { [threadId]: string[][] }，第 N 项 = 第 N 条用户气泡的图（无图为 []）。
const MSG_IMG_KEY = 'variant.msgimg.v1'
const SESSIONS_MAX = 50

function loadMsgImgMap(): Record<string, string[][]> {
  try {
    const raw = JSON.parse(localStorage.getItem(MSG_IMG_KEY) || '{}') as unknown
    return raw && typeof raw === 'object' ? (raw as Record<string, string[][]>) : {}
  } catch {
    return {}
  }
}

/** 取本 thread 的用户气泡图序列（恢复时用） */
function getThreadMsgImgs(id: string): string[][] {
  const m = loadMsgImgMap()[id]
  return Array.isArray(m) ? m : []
}

/** 追加一条用户气泡的图（发送时调用，保发送序 = 用户气泡序） */
function pushMsgImgs(urls: string[]) {
  try {
    const map = loadMsgImgMap()
    const arr = Array.isArray(map[threadId.value]) ? map[threadId.value] : []
    arr.push(urls)
    map[threadId.value] = arr
    localStorage.setItem(MSG_IMG_KEY, JSON.stringify(map))
  } catch {
    /* 配额满等异常不影响主流程 */
  }
}

/** 删除本 thread 的图注册（删会话时连带清理） */
function dropThreadMsgImgs(id: string) {
  try {
    const map = loadMsgImgMap()
    if (id in map) {
      delete map[id]
      localStorage.setItem(MSG_IMG_KEY, JSON.stringify(map))
    }
  } catch {
    /* noop */
  }
}

function loadSessions(): SessionMeta[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]') as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (s): s is SessionMeta =>
        !!s && typeof (s as SessionMeta).id === 'string' && typeof (s as SessionMeta).title === 'string'
    )
  } catch {
    return []
  }
}

const sessions = ref<SessionMeta[]>(loadSessions())
const restoring = ref(false)

function saveSessions() {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions.value.slice(0, SESSIONS_MAX)))
  } catch {
    /* 配额满等异常不影响主流程 */
  }
}

/** 本会话首条消息时登记 / 后续消息只刷活跃时间，并置顶 */
function touchSession(firstShownText?: string) {
  const idx = sessions.value.findIndex((s) => s.id === threadId.value)
  if (idx >= 0) {
    const s = sessions.value[idx]
    s.at = Date.now()
    if (motherImg.value && !s.img) s.img = motherImg.value
    sessions.value.splice(idx, 1)
    sessions.value.unshift(s)
  } else {
    const title =
      (firstShownText || '')
        .replace(/https?:\/\/[^\s)>'"]+/g, '')
        .replace(/🖼|🔁/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 24) || '图片举一反三'
    sessions.value.unshift({ id: threadId.value, title, at: Date.now(), img: motherImg.value || undefined })
  }
  saveSessions()
  try {
    localStorage.setItem(ACTIVE_KEY, threadId.value)
  } catch {
    /* 同上 */
  }
}

// ---------------------------------------------------------------------------
// 会话 / 发送
// ---------------------------------------------------------------------------

// 会话级 thread_id：同会话所有 send 复用 → agent 记住当前题组。
// 刷新不再换新 —— onMounted 恢复上次活跃会话（用户反馈③）。ref 是为了
// 会话列表里 is-active 高亮能跟着切换走（模板里要响应式）。
const threadId = ref<string>(crypto.randomUUID())
let handle: VariantStreamHandle | null = null
// 「换一批」= 重发初始出题 utterance（PRD 开放问题方案 b：不动 agent 路由）
let firstComposeMessage: string | null = null
// 打字机气泡（用户反馈① 思维外放）：BE 只对人话型 LLM 输出（答疑等）放行 token
//（JSON 中间产物打 skip_stream 在服务端就被滤掉），所以这里收到的 token 可直接外放。
let typingBubble: Bubble | null = null

async function scrollToBottom() {
  await nextTick()
  const el = streamRef.value
  if (el) el.scrollTop = el.scrollHeight
}

/**
 * 思路条终态收口：流中途出错/异常断流时，把【当前轮】还在 running 的条目就地改成 warn
 *（标「已中断」）。历史轮 rail 已冻结不受影响；幂等，可重复调用。
 */
function settleStages() {
  const rail = currentRail.value
  if (!rail) return
  rail.stages = rail.stages.map((s) =>
    s.status === 'running'
      ? { ...s, status: 'warn' as const, detail: s.detail ? `${s.detail}·已中断` : '已中断' }
      : s
  )
}

/**
 * 🔴 统一发送管道：输入框手打 / 卡片快捷键 / 全部入库 / 换一批最终都走这里
 *（同 thread_id 同 chat SSE 通道，agent 既有受约束分类器路由）。
 */
function dispatch(
  message: string,
  shownText?: string,
  images?: string[],
  // 🔴 PRD-C-017 B3/B5：母题确认续聊回合带确认章 id（+年级册 id +年级册人话名）/ 母题硬停 resume
  //   信号 startVariants → 全部经 agent_config 回传 toolkit（接 B2 闸B / B5 awaiting_mother_review）。
  confirmCtx?: {
    confirmedChapterId?: string
    confirmedGradeBookId?: string
    gradeBookName?: string
    startVariants?: boolean
  }
) {
  if (sending.value) return
  handle?.abort()
  // PRD-C-100 B6：新一轮请求清掉上轮的额度横幅（让老师重试时不残留旧提示）
  budgetExceeded.value = false
  budgetMessage.value = ''

  stream.value.push({
    type: 'bubble',
    role: 'user',
    text: shownText ?? message,
    images: images && images.length ? images : undefined,
  })
  // P10：把本条用户气泡的图按发送序登记，会话恢复时贴回（checkpointer 回放无图）
  pushMsgImgs(images ?? [])
  // 本轮思路条锚点：紧跟用户气泡 push，后续 AI 气泡追加在它下方 → rail 钉在本轮头部
  const rail = reactive<RailItem>({ type: 'rail', stages: [], reasoning: '', reasoningOpen: true })
  stream.value.push(rail)
  currentRail.value = rail
  touchSession(shownText ?? message) // 会话注册表：首条登记 / 后续刷活跃置顶

  sending.value = true
  thinking.value = true
  typingBubble = null
  scrollToBottom()

  handle = streamVariant(
    {
      message,
      thread_id: threadId.value,
      ruoyiToken: userStore.accessToken,
      confirmedChapterId: confirmCtx?.confirmedChapterId,
      confirmedGradeBookId: confirmCtx?.confirmedGradeBookId,
      gradeBookName: confirmCtx?.gradeBookName,
      startVariants: confirmCtx?.startVariants,
    },
    {
      onToken: (delta) => {
        // 思维外放（用户反馈①）：BE 已在服务端滤掉 JSON 中间产物的 token
        //（skip_stream），到这里的都是人话（答疑/解释），打字机逐字渲染。
        thinking.value = false
        if (!typingBubble) {
          typingBubble = reactive<Bubble>({ type: 'bubble', role: 'ai', kind: 'normal', text: '' })
          stream.value.push(typingBubble)
        }
        typingBubble.text += delta
        scrollToBottom()
      },
      onStage: (stage: VariantStage) => {
        // 思路条：同 key 原地更新 status/detail，新 key 追加（保 BE 发出的阶段顺序）
        const idx = rail.stages.findIndex((s) => s.key === stage.key)
        if (idx >= 0) rail.stages[idx] = stage
        else rail.stages.push(stage)
        scrollToBottom()
      },
      // 🔴 PRD-C-100 B6：思考流式 → 本轮可折叠思考块（增量拼接、流式期展开滚动）。
      //   现状 opus 经 aigeek 不吐 reasoning → 多数轮此回调不触发，思考块不渲染（向后兼容）。
      onReasoning: (payload: VariantReasoning) => {
        rail.reasoning += payload.text
        rail.reasoningOpen = true
        scrollToBottom()
      },
      onArtifact: (a: VariantArtifact) => {
        // 🔴 修1：整帧替换【前】先按 stem 作废受影响 index 的旧配图（防旧图串到新题）。
        invalidateStaleFigures(a)
        // 快照全量语义：整帧替换（assemble 每轮收尾 + persist 成功后各发一帧）。
        // PRD-C-012 P2：增量帧（partial=true，items=已完成题全量快照）同样整量替换 ——
        // partial / expectedTotal 随帧存进同一响应式 artifact，ArtifactPanel 据此渲染
        // 「生成中」占位骨架卡；定稿帧无 partial 键 → 占位卡自然消失。
        artifact.value = a
        // 🔴 修2：拿到一组题后自动出第一张图（母题切图 + 第一道变式造图，每组各一次）。
        maybeAutoFirstFigures(a)
      },
      // 🔴 PRD-C-017 B3·① 母题年级章确认面（AC1/G1）：母题每次必停 → 弹确认面。
      //   toolkit 停在 awaiting_mother_confirm（clarify→END resume），老师确认后宿主
      //   发续聊回合带 confirmed_chapter_id（onConfirmGradeChapter）。
      onNeedConfirm: (payload: VariantNeedConfirm) => {
        thinking.value = false
        needConfirmPayload.value = payload
        confirmDialogVisible.value = true
        // 本轮 toolkit 已 END（停等确认）→ onClose 会把 sending 收掉；这里不抢先动 sending。
        scrollToBottom()
      },
      // 🔴 PRD-C-017 B3·⑤ 带图打回（G13）：直接出提示，流程结束（不弹确认/不渲染母题卡/不出变式）。
      onReject: (payload: VariantReject) => {
        thinking.value = false
        settleStages()
        onRejectMother(payload)
        scrollToBottom()
      },
      onMessage: (msg: ToolkitChatMessage) => {
        thinking.value = false
        // 整块消息是该 LLM 输出的终稿 → 替换打字机半成品气泡（避免同文重复两个气泡）
        if (typingBubble) {
          const i = stream.value.indexOf(typingBubble)
          if (i >= 0) stream.value.splice(i, 1)
          typingBubble = null
        }
        stream.value.push({
          type: 'bubble',
          role: 'ai',
          kind: 'normal',
          text: String(msg.content || ''),
        })
        scrollToBottom()
        // 下一节点若继续跑会再来 token → 重新进思考态
        thinking.value = true
      },
      onServerError: (m) => {
        thinking.value = false
        settleStages() // 思路条与错误气泡一致收口（running → warn·已中断）
        // 🔴 PRD-C-100 B6：今日额度用尽 → 顶部友好横幅（文案用后端原文，含已用/上限 ¥），
        //   不只塞进错误气泡里被忽略。仍同时落一条气泡保留上下文。
        if (isBudgetError(m)) {
          budgetExceeded.value = true
          budgetMessage.value = m
        }
        stream.value.push({ type: 'bubble', role: 'ai', kind: 'error', text: m })
        scrollToBottom()
      },
      onError: (err) => {
        console.error('[variant] 流异常:', err)
        thinking.value = false
        sending.value = false
        settleStages()
        stream.value.push({
          type: 'bubble',
          role: 'ai',
          kind: 'error',
          text: '网络或 AI 服务异常，未能完成本次请求。请确认举一反三服务（toolkit :8093）已启动后重试。',
        })
        scrollToBottom()
      },
      onClose: () => {
        sending.value = false
        thinking.value = false
        typingBubble = null // 半成品打字气泡留在原地（极少见：流断在 token 中途）
        settleStages() // 正常完成时无 running 条目 = no-op；异常断流时兜底收口
        // PRD-C-100 B6：本轮结束自动折叠思考块（有思考内容时；空则无块、无影响）
        rail.reasoningOpen = false
        scrollToBottom()
      },
    }
  )
}

/** 输入框发送（首轮把 OSS URL 拼进文本，agent 端从 human 文本抠 URL） */
function send() {
  commitUrlInput() // 先把 URL 输入框里没回车的地址并入待发附件
  const text = input.value.trim()
  const imgs = [...pendingImages.value]
  // 首轮必须有图；后续轮纯指令即可（text 非空）
  if (imgs.length === 0 && !text) return
  if (sending.value) return

  // agent 端从 human 文本抠 URL（_extract_image_url），故图 URL 仍内联进 message 文本
  const parts: string[] = []
  if (imgs.length) parts.push(imgs.join('\n'))
  if (text) parts.push(text)
  const message = parts.join('\n')

  if (imgs.length) {
    // 首图作母题：顶部小徽章常驻（守恒锚）；「换一批」重发这条初始出题 utterance
    if (!motherImg.value) motherImg.value = imgs[0]
    firstComposeMessage = message
  }

  // 气泡文案：图随气泡进流（缩略图），文本同气泡。无需再把 URL 替成「🖼 母题图」占位文字。
  const shown = text || (imgs.length ? '（开始举一反三）' : '')
  input.value = ''
  pendingImages.value = []
  dispatch(message, shown, imgs)
}

/** 卡片快捷键（换数字/换场景/答疑，需要 LLM）：预设句走 chat 通道，用户气泡照常显示（铁律 1） */
function sendUtterance(text: string) {
  if (sending.value) return
  dispatch(text)
}

/**
 * 全部入库（2026-06-11 用户拍板）：确定性动作直连 BE /variant/persist，不绕 LLM
 * 分类器（省一次 LLM + 零误判）。回执作为 AI 气泡进对话（BE 已同步写回 checkpointer
 * 历史，刷新恢复也能看到），artifact 整量替换刷新「已收录」徽章。
 */
async function persistAll() {
  if (sending.value) return
  stream.value.push({ type: 'bubble', role: 'user', text: '📥 全部入库' })
  touchSession('全部入库')
  sending.value = true
  scrollToBottom()
  try {
    // 🔴 BC2：全部入库前，逐题把已生成的配图 base64 传 OSS + 回写 state.figure_url（无图的题空跑）。
    //   串行（OSS 写 + state 回写有先后），任一失败抛错落 catch（不静默丢图）。
    for (const k of Object.keys(variantFigures)) {
      await flushFigureToOss(Number(k))
    }
    const res = await persistVariantGroup(threadId.value, userStore.accessToken)
    if (res.reply) stream.value.push({ type: 'bubble', role: 'ai', kind: 'normal', text: res.reply })
    if (res.artifact) artifact.value = res.artifact
  } catch (e) {
    stream.value.push({
      type: 'bubble',
      role: 'ai',
      kind: 'error',
      text: `入库失败：${e instanceof Error ? e.message : String(e)}`,
    })
  } finally {
    sending.value = false
    scrollToBottom()
  }
}

// ---------------------------------------------------------------------------
// 🔴 PRD-C-017 B3 — 母题年级章确认 / 带图打回 / 母题入库。
// ---------------------------------------------------------------------------

/**
 * ① 老师确认年级册+章（AC1/G1）：拿到真 chapter_id + grade_book_id（biz_subject 真节点 id）。
 * 经【续聊回合】把 confirmed_chapter_id 放进 agent_config 回传 toolkit ——
 * toolkit route_entry（awaiting_mother_confirm + confirmed_chapter_id）直奔 classify，
 * B2 闸B anchor_to_chapter(chapter_id=…) 据它收窄锚定到确认章。这是 B3↔toolkit 最关键对接点。
 */
function onConfirmGradeChapter(value: {
  chapterId: string
  gradeBookId: string
  chapterName: string
  gradeBookName: string
}) {
  if (sending.value) return
  // 续聊回合：发一句「确认」+ 把确认章经 agent_config 回传（toolkit 取 config.confirmed_chapter_id）。
  // 关弹窗后由左栏 sending/思路条接管反馈，confirmSubmitting 仅作弹窗内提交锁（这里关窗即解锁）。
  const shown = `已确认：${value.gradeBookName} / ${value.chapterName}`
  // 🔴 B4-polish：记下老师确认的章人话名（母题卡「锚定章」直接显示它，不依赖 toolkit 回灌 id）
  confirmedChapterName.value = value.chapterName || value.gradeBookName || ''
  // 🔴 B5：记下年级册人话名（chip 年级显示 + 回传 toolkit 同步年级）
  confirmedGradeBookName.value = value.gradeBookName || ''
  confirmDialogVisible.value = false
  confirmSubmitting.value = false
  dispatch('确认，按此年级册与章继续举一反三', shown, undefined, {
    confirmedChapterId: value.chapterId,
    confirmedGradeBookId: value.gradeBookId,
    gradeBookName: value.gradeBookName,
  })
}

/**
 * 🔴 PRD-C-017 B5：母题卡「开始举一反三」（母题硬停 resume）。
 * 母题卡出来后 toolkit 停在 awaiting_mother_review；老师点此按钮 → 续聊回合经 agent_config
 * 回传 start_variants=true，toolkit 直奔生成变式（不重跑 opus 解题）。生成中按钮 loading 由
 * sending 驱动（dispatch 置 sending=true）。
 */
function onStartVariants() {
  if (sending.value) return
  dispatch('开始举一反三，按确认的年级册与章生成变式', '▶ 开始举一反三', undefined, {
    startVariants: true,
    // 顺带回传确认章/年级册名（toolkit resume 时不丢锚定上下文）
    gradeBookName: confirmedGradeBookName.value || undefined,
  })
}

/**
 * ⑤ 带图打回（G13）：toolkit 判母题含图 → reject 事件。直接出错误气泡，流程结束
 *（不弹确认面、不渲染母题卡、不出变式）。reject 已带「举一反三暂不支持带图题」文案。
 */
function onRejectMother(payload: VariantReject) {
  // 确认面若误开则关掉（带图打回优先级最高，且 toolkit 不会同时发 needConfirm+reject）
  confirmDialogVisible.value = false
  needConfirmPayload.value = null
  stream.value.push({
    type: 'bubble',
    role: 'ai',
    kind: 'error',
    text: payload.message || '举一反三暂不支持带图题',
  })
}

/** 把题型文本映射成库值（1选择/4填空/5解答）。母题题型缺省按解答(5)。 */
function qtypeToCode(qt: string | null | undefined): number {
  const s = qt || ''
  if (/选择|单选|多选/.test(s)) return 1
  if (/填空/.test(s)) return 4
  return 5 // 解答 / 简答 / 证明 默认 5
}

/**
 * ⑥ 母题入库（G12/§1⑧/§10 母题落库）：把母题打标产出映射 CreateQuestionBo →
 * POST /teacher/question/create（走 /api → :8090 misikt 拦截器，code===1 判成功）。
 *   - 字段事实源 = CreateQuestionBo.java：stem/answer/analyze + dim1KpId/secondaryKpIds/
 *     dim2Qtype/dim4Difficulty/dim5Structure + skeleton/scene/examType/hardPoints + tags +
 *     anchorId/needAnchorReview/reasoning + labelStatus=1/labeledBy(=opus 模型名)。
 *   - 服务端强制 createBy/status/id（别传）；hardPointCount BE 算 size（别传）。
 *   - stemImg = 整图 URL（母题原图；cropped 归 C-016）。
 * 零新 BE 接口（复用 C-014/C-015 已建的 create path）。
 */
async function onPersistMother() {
  if (motherPersisting.value || sending.value) return
  const mc = motherCard.value
  if (!mc || motherPersisted.value) return
  // 母题题面事实源：toolkit 母题专帧 mc.stem；兜底路径无母题题面 → 用首个变式题面不合适，
  // 拒绝入库并提示（避免把变式当母题落库）。
  const stem = mc.stem?.trim()
  if (!stem) {
    ElMessage.warning('母题题面尚未产出（toolkit 暂未透传母题专帧），暂不能入库；待母题卡先出专帧后可入库')
    return
  }
  motherPersisting.value = true
  try {
    const dna = mc.dna
    const qcode = qtypeToCode(mc.qtype)
    const bo: CreateQuestionWithDnaBo = {
      questionType: qcode,
      stem,
      // 🔴 PRD-C-017 B5：标准答案 answer 优先，回退 solvedAnswer
      answer: mc.answer || mc.solvedAnswer || undefined,
      // 🔴 PRD-C-017 minor-1：analyze = opus 完整解析富文本（mc.analysis），不再拿解法骨架顶替；
      //   analysis 缺/空 → 回退骨架兜底（别让入库报错），但优先 analysis。skeleton 字段各归各位（见下）。
      analyze: mc.analysis || mc.solutionSkeleton || undefined,
      // subjectId 走主考点 id（dim1KpId）优先（题归属知识点叶子），缺则确认章 id
      subjectId: dna.mainKpId || mc.anchorChapterId || undefined,
      stemImg: motherImg.value || undefined,
      // 5 维打标
      dim1KpId: dna.mainKpId || undefined,
      dim2Qtype: qcode,
      dim4Difficulty: mc.difficulty || undefined,
      dim5Structure: dna.scene || undefined,
      labelStatus: 1, // AI 已标
      labeledBy: 'claude-opus-4-8', // 母题 opus 打标（决策表）
      labelConfidence: undefined,
      // DNA 全维
      secondaryKpIds: mc.secondaryKpIds.length ? mc.secondaryKpIds : undefined,
      tags: dna.tags.length ? dna.tags : undefined,
      skeleton: mc.solutionSkeleton || undefined,
      scene: dna.scene || undefined,
      examType: dna.examType || undefined,
      hardPoints: dna.hardPoints.length ? dna.hardPoints : undefined,
      anchorId: mc.anchorChapterId || undefined,
      needAnchorReview: mc.needAnchorReview || undefined,
      reasoning: 'PRD-C-017 母题 opus 解题打标',
    }
    const res = await createQuestionWithDna(bo)
    motherQuestionId.value = res?.id ? String(res.id) : ''
    motherPersisted.value = true
    ElMessage.success('母题已入库（label_status=1，可组卷·可再举一反三）')
  } catch (e) {
    // 失败 toast 由 http 拦截器已弹（code!==1）；这里只补一条具体反馈
    ElMessage.error(`母题入库失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    motherPersisting.value = false
  }
}

// ---------------------------------------------------------------------------
// 题组编辑器（拖动排序 / 内容编辑 / 重新验算）—— 全部走 BE 直连端点落 toolkit 会话 state，
// 返回 artifact 整量替换刷新右栏。这些是确定性/单题动作，不进对话流、不绕 LLM 分类器。
// ---------------------------------------------------------------------------

/** 拖动排序：order = 1-based 全排列。ArtifactPanel 已乐观更新；失败回滚（拉回 BE 快照）。 */
async function onReorder(order: number[]) {
  if (sending.value) return
  try {
    const a = await reorderVariant(threadId.value, order)
    if (a) artifact.value = a // 以 BE 重排后快照为准（seq/字段跟题不错位）
  } catch (e) {
    ElMessage.error(`排序失败：${e instanceof Error ? e.message : String(e)}`)
    // 回滚：拉回 BE 当前真实快照，撤销乐观重排
    try {
      const a = await fetchVariantArtifact(threadId.value)
      if (a) artifact.value = a
    } catch {
      /* 拉取也失败则保持现状，老师可刷新 */
    }
  }
}

/** 内容编辑保存：只 patch 改过的字段。BE 净化 + 标 manual + 置 tier='manual'，返回新快照。 */
async function onEditItem(payload: {
  index: number
  stem?: string
  answer?: string
  solution?: string
}) {
  if (sending.value) return
  try {
    const { index, ...patch } = payload
    const a = await editVariantItem(threadId.value, index, patch)
    if (a) artifact.value = a
    ElMessage.success('已保存修改（验算待重跑，可点「重新验算」）')
  } catch (e) {
    ElMessage.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

/** 单题重新验算：跑闸B（LLM+sympy，几秒），徽章变真实验算结果。loading 落本题。 */
async function onReverify(index: number) {
  if (sending.value || reverifyingIndex.value !== null) return
  reverifyingIndex.value = index
  try {
    const a = await reverifyVariantItem(threadId.value, index)
    if (a) artifact.value = a
  } catch (e) {
    ElMessage.error(`重新验算失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    reverifyingIndex.value = null
  }
}

// ---------------------------------------------------------------------------
// PRD-C-014 T3/T4 — DNA 逐维编辑。
//   T3 列表选编辑（零 LLM）：edit-dna，整量替换右栏（被改卡置 manual_edited 徽章）。
//   T4 点击-说话（生成维 / 整卡重做）：revise（跑 LLM，几秒），同样整量替换。
// 都是确定性/单题动作，不进对话流。失败报错气泡不静默（ElMessage.error）。
// ---------------------------------------------------------------------------

/** T3：DNA 列表选编辑（知识点树 / 枚举 / 标签 / 点星）。 */
async function onEditDna(payload: {
  index: number
  // 🔴 PRD-C-017 B5：scene / skeleton 点击直改也走 edit-dna
  field:
    | 'main_kp'
    | 'secondary_kps'
    | 'qtype'
    | 'exam_type'
    | 'tags'
    | 'difficulty'
    | 'scene'
    | 'skeleton'
  value: DnaEditValue
}) {
  if (sending.value) return
  try {
    const a = await editVariantDna(threadId.value, payload.index, payload.field, payload.value)
    if (a) artifact.value = a
    ElMessage.success('已更新（你说了算）')
  } catch (e) {
    ElMessage.error(`更新失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

// 🔴 PRD-C-017 B5：原 onRevise（T4 点击-说话 skeleton/scene/whole 自然语言重生）已下线 ——
//   场景 / 解法骨架改为变式卡上「点击直改」（走 onEditDna 结构化字段 + 「重生这道」按钮）。

// ---------------------------------------------------------------------------
// PRD-C-015 批5 — DNA 改→重生 / 撤销重生 / models 改 / 母题守恒维改 / 换图。
//   重生：调 regenVariant（软重生维 _regen_once / 重写解析维只重写 solution，过闸B 重验，
//         保留手改 manual 维——后端语义，FE 只发请求 + 整量替换右栏）。
//   撤销：调 undoRegenVariant 回上一版快照。
//   models 改：走 editVariantDna(field='models')（rewrite_solve 档，置 dirty）。
//   母题守恒维改：走 editVariantDna(index=1, field) → 落 mother_dna.dna（组级共享）。
// 都是确定性/单题动作，不进对话流。失败报错气泡不静默。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 🔴 PRD-C-100 BC3 (c) 定稿态 — 手动排版 + 重生前二次确认 + 清脏 block。
//   手动排版 = 老师对【已入库】变式/母题点入口 → 标 manual_block 印记 → 跳 A-015 网格编辑器
//     （/question/editor/:questionId，按 questionId round-trip blockJson 编辑 → /update-block 存）。
//   重生定稿闸 = 重生待重生题里若有 manual_edited（含手动排版）题 → 弹二次确认「会覆盖手改」；
//     确认 → 对每道手动排版题清脏 block（delete-block，避免详情/卷库按旧布局渲染新题面）+ 清印记
//     → 再走正常重生。
// ---------------------------------------------------------------------------

/** 已入库变式「手动排版」：标印记 → 跳 A-015 网格编辑器全页（按 questionId round-trip blockJson）。 */
async function onManualLayout(index: number) {
  if (sending.value || regeneratingIndexes.value.length > 0) return
  const item = findItem(index)
  if (!item) return
  if (!item.persisted || !item.questionId) {
    ElMessage.info('请先「收录入库」再手动排版（编辑器按已入库题载入排版）')
    return
  }
  try {
    // 标 manual_block 印记（重生前据此弹二次确认；编辑器存盘是另一全页路由，回来后印记已在）。
    const a = await markVariantManualBlock(threadId.value, index, true)
    if (a) artifact.value = a
  } catch (e) {
    // 标印记失败不阻断进编辑器（编辑器存盘仍生效）；仅提示，不静默
    ElMessage.warning(`手动排版印记登记失败（仍可编辑）：${e instanceof Error ? e.message : String(e)}`)
  }
  router.push(`/question/editor/${item.questionId}`)
}

/** 已入库母题「手动排版」：跳 A-015 网格编辑器全页（母题印记走 BE update-block，不经 toolkit 会话）。 */
function onManualLayoutMother() {
  if (sending.value) return
  if (!motherPersisted.value || !motherQuestionId.value) {
    ElMessage.info('请先「母题入库」再手动排版（编辑器按已入库题载入排版）')
    return
  }
  router.push(`/question/editor/${motherQuestionId.value}`)
}

/**
 * 重生定稿闸：targets 里命中「老师手改过」(manual_edited，含手动排版 manual_block) 的题 → 弹二次确认。
 * 返回 true=放行（已对手动排版题清脏 block + 清印记），false=老师取消。无手改题直接放行。
 */
async function confirmRegenIfManual(targets: number[]): Promise<boolean> {
  const manualItems = (artifact.value?.items ?? []).filter(
    (it) => targets.includes(it.index) && (it.manualEdited || it.manualBlock)
  )
  if (manualItems.length === 0) return true
  const ns = manualItems.map((it) => it.index).join('、')
  try {
    await ElMessageBox.confirm(
      `第 ${ns} 题你手动排版/改过，重生会按新题面重出、覆盖你的手动排版。确定重生？`,
      '确认重生',
      { type: 'warning', confirmButtonText: '覆盖并重生', cancelButtonText: '取消' }
    )
  } catch {
    return false // 老师取消
  }
  // 确认 → 对手动排版（manual_block）且已入库的题清脏 block + 清印记（内容编辑 manual_edited 无 block，跳过 delete）。
  for (const it of manualItems) {
    if (it.manualBlock && it.persisted && it.questionId) {
      try {
        await deleteQuestionBlock(it.questionId)
      } catch (e) {
        // 清 block 失败仅警告（重生仍继续；旧 block 可能残留，老师可再手动排版）
        ElMessage.warning(`第 ${it.index} 题清排版失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    try {
      const a = await markVariantManualBlock(threadId.value, it.index, false)
      if (a) artifact.value = a
    } catch {
      /* 清印记失败不阻断重生 */
    }
  }
  return true
}

/** 重生：indexes 省略 = 全待重生集合（D-merge8）；命中题驱动 loading。 */
async function runRegen(indexes?: number[]) {
  if (sending.value || regeneratingIndexes.value.length > 0) return
  // loading 目标：指定 indexes，否则取当前 header.regen_pending（含母题脏波及）
  const targets =
    indexes && indexes.length ? indexes : (artifact.value?.header.regenPending ?? [])
  // 🔴 BC3 (c) 定稿态：手改/手动排版题重生前二次确认 + 清脏 block（取消则不重生）
  if (!(await confirmRegenIfManual(targets))) return
  regeneratingIndexes.value = targets.length ? [...targets] : [-1] // -1 占位让按钮转圈
  try {
    const res = await regenVariant(threadId.value, indexes)
    if (res.artifact) artifact.value = res.artifact
    if (res.failed.length) {
      const ns = res.failed.map((f) => f.index).join('、')
      ElMessage.warning(`第 ${ns} 题重生未成功（已保留原题，可再试或撤销）`)
    } else if (res.regenerated.length) {
      ElMessage.success(`已重生第 ${res.regenerated.join('、')} 题（过闸B 重验）`)
    } else {
      ElMessage.info('没有待重生的题')
    }
  } catch (e) {
    ElMessage.error(`重生失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    regeneratingIndexes.value = []
  }
}

/** 单题重生（变式卡「重生」按钮） */
function onRegenOne(index: number) {
  void runRegen([index])
}
/** 全待重生集合重生（右栏头「重生 N 题」按钮） */
function onRegenAll() {
  void runRegen()
}

/** 撤销重生：回上一版快照（缺口12）。 */
async function onUndoRegen(index: number) {
  if (sending.value || regeneratingIndexes.value.length > 0) return
  try {
    const a = await undoRegenVariant(threadId.value, index)
    if (a) artifact.value = a
    ElMessage.success(`已撤销第 ${index} 题的重生，回到上一版`)
  } catch (e) {
    ElMessage.error(`撤销重生失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

/** models 维改（rewrite_solve 档，走 edit-dna field='models'）。 */
async function onEditModels(payload: {
  index: number
  value: Array<{ id: string; name: string }>
}) {
  if (sending.value) return
  try {
    const a = await editVariantDna(threadId.value, payload.index, 'models', payload.value)
    if (a) artifact.value = a
    ElMessage.success('已更新模型（改了模型=换解法，点「重生」重写解析）')
  } catch (e) {
    ElMessage.error(`更新模型失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * 🔴 PRD-C-017 B3.6 母题守恒维改（AC6/G6，复用 C-015 通路）：副考点/考察类型/骨架/难点
 * → 落 mother_dna.dna（组级共享）。走 editVariantDna(index=1, field)——BE 守恒维路由把这些维
 * 写进 mother_dna，下游变式回流 dirty（artifact.header.motherDirty 置位 → MotherCard 亮「重生」）。
 * B3 收窄移位后由收窄后的 MotherCard 内联编辑触发（原 C-015 MotherBar 通路重接，重生机制不新造）。
 * 守恒维改后须有变式在场才有「下游回流」意义（无变式时 BE 仅记 mother_dna，无回流）。
 */
async function onEditMotherDna(payload: { field: DnaField; value: DnaEditValue }) {
  if (sending.value || !artifact.value) return
  try {
    const a = await editVariantDna(threadId.value, 1, payload.field, payload.value)
    if (a) artifact.value = a
    ElMessage.success('已更新母题守恒维（下游变式已标待重生，点「重生下游变式」按新基准重出）')
  } catch (e) {
    ElMessage.error(`更新母题守恒维失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

// 🔴 PRD-C-017 B3.6：onConfirmMother / onSwapMotherImage（C-015 MotherBar 的「过确认面」/
//   「换母题图」handler）随 B3 收窄移位 MotherBar 下线而移除——确认面已由 GradeChapterConfirmDialog
//   （needConfirm 弹窗）承接，换图走左栏贴图重置流程。母题 DNA 编辑→重生能力（onEditMotherDna +
//   onRegenAll/runRegen）已重接到收窄后的 MotherCard（AC6/G6，见上方 MotherCard 用法）。

// ---------------------------------------------------------------------------
// PRD-C-014 §3.1 — 单题入库（T1）+ 试题篮透明入库（T2）。
//   T1 收录入库：调 persist-one → 该卡 persisted=true（artifact 整量替换后保持）。
//   T2 加入试题篮：始终可点；未入库先 persist-one 拿 id 再加篮，已入库直接加篮。
//   入库/加篮都是确定性单题动作，不进对话流、不绕 LLM 分类器（与「全部入库」直连同一模式）。
// ---------------------------------------------------------------------------

/** 取当前 artifact 里某题（1-based index） */
function findItem(index: number): VariantArtifactItem | undefined {
  return artifact.value?.items.find((it) => it.index === index)
}

/** 把变式题映射成试题篮所需的最小 QuestionItem（qtype 文本 → questionType 数值） */
function toBasketItem(id: string, item: VariantArtifactItem): QuestionItem {
  const qt = item.qtype || ''
  const questionType = /选择|单选|多选/.test(qt) ? 1 : /填空/.test(qt) ? 4 : 5
  const d = Math.round(item.difficulty)
  return {
    id,
    questionType,
    difficult: d > 0 ? d : null,
    stemImg: null,
    stemText: item.stem || `题目 ID: ${id}`,
  }
}

/** T1：单题「收录入库」。已收录卡重复点不重复发（按钮已禁用 + 这里再守一道）。 */
async function onPersistOne(index: number) {
  if (persistingIndex.value !== null || basketingIndex.value !== null || sending.value) return
  const item = findItem(index)
  if (!item || item.persisted) return
  persistingIndex.value = index
  try {
    // 🔴 BC2：入库前先把本题配图 base64 传 OSS + 回写 state.figure_url（无图则空跑）。
    await flushFigureToOss(index)
    const res = await persistVariantOne(threadId.value, index, userStore.accessToken)
    if (res.artifact) artifact.value = res.artifact // 整量替换 → 该卡 persisted=true 持久
    if (res.ok) ElMessage.success('已收录入库')
    else ElMessage.warning('入库未确认成功，请稍后在「我的题库」核对')
  } catch (e) {
    ElMessage.error(`收录入库失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    persistingIndex.value = null
  }
}

/**
 * T2：单题「加入试题篮」（透明入库）。
 *   未入库 → 先 persist-one 拿题 id → 加篮 → toast「已收录并加入试题篮」+ 计数+1。
 *   已入库 → 直接加篮 → toast「已加入试题篮」。
 *   任一步失败 → 篮不计数（add silent 模式 await BE，失败 throw）+ 报错气泡，不静默、不弹确认框。
 */
async function onAddToBasket(index: number) {
  if (basketingIndex.value !== null || persistingIndex.value !== null || sending.value) return
  const item = findItem(index)
  if (!item) return
  basketingIndex.value = index
  try {
    let id = ''
    let firstPersist = false
    if (item.persisted) {
      // 已入库：直接拿当前会话该题在库 id —— persist-one 幂等（防重簿记），直接复用它取 id。
      const res = await persistVariantOne(threadId.value, index, userStore.accessToken)
      if (res.artifact) artifact.value = res.artifact
      id = res.id
    } else {
      // 🔴 BC2：首次入库前先把本题配图传 OSS + 回写 state.figure_url（无图则空跑）。
      await flushFigureToOss(index)
      const res = await persistVariantOne(threadId.value, index, userStore.accessToken)
      if (res.artifact) artifact.value = res.artifact
      id = res.id
      firstPersist = true
    }
    if (!id) throw new Error('入库未返回题目 ID')
    // silent 模式：await BE 加篮，成功才本地计数；失败 throw → 落到 catch（篮不计数 + 报错）
    await basket.add(toBasketItem(id, item), { silent: true })
    ElMessage.success(firstPersist ? '已收录并加入试题篮' : '已加入试题篮')
  } catch (e) {
    ElMessage.error(`加入试题篮失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    basketingIndex.value = null
  }
}

/**
 * G13 ⑤：头部「主考点 / 年级」可改 —— 这是【组级守恒锚】（影响整组），非单题维。
 * T3/T4 的 edit-dna/revise 都是单题端点，无组级头部端点契约 → 走【既有 chat 通道】发一句
 * 受约束指令（同 thread_id，agent 据此整组重锚定/重出）。这是组级改动唯一已落地的安全路径。
 * 🔴 联调点：若后续 BE 提供组级 set-header 直连端点，这两处可改直连（零 LLM）。
 */
function onEditHeaderKp(kp: { id: string; name: string }) {
  if (sending.value) return
  // 🔴 修1/修2：改主考点 = 整组按新考点重出 → 是「新的一组」。先清旧配图缓存 + 复位首图 guard，
  //   新题来时按自己题面重画、第一张重新自动出（onArtifact 会再兜底，这里提前清免重出期残留旧图）。
  resetFigureCachesForNewGroup()
  dispatch(`把整组主考点改成「${kp.name}」，按新主考点重新出这组变式`, `主考点 → ${kp.name}`)
}
function onEditHeaderGrade(grade: string) {
  if (sending.value || !grade) return
  // 🔴 修1/修2：改年级 = 整组重出，同上复位配图缓存 + 首图 guard。
  resetFigureCachesForNewGroup()
  dispatch(`把整组年级改成「${grade}」，按新年级重新出这组变式`, `年级 → ${grade}`)
}

/**
 * 复位「变式」配图缓存 + 首张变式图 guard（用于「换一批」/改主考点·年级重出 = 新的一组）。
 * 母题切图（autoCropMotherDone / motherFigurePng）不在此复位 —— 换一批/改范围母题原图不变，
 * 母题图形也不变，无需重切（避免无谓花费/闪烁）；母题图仅随会话或换母题图重置（clearCanvas）。
 */
function resetFigureCachesForNewGroup() {
  for (const k of Object.keys(variantFigures)) delete variantFigures[Number(k)]
  for (const k of Object.keys(figureStemAtIndex)) delete figureStemAtIndex[Number(k)]
  autoComposeFirstDone = false
}

/** 换一批：重发初始出题 utterance（整组重新出，agent 重新分析母题） */
function regenerate() {
  if (sending.value || !firstComposeMessage) return
  // PRD-C-011 line 102 方案 b =「清空当前卡 + 重发初始出题 utterance」：先清画布，
  // 骨架卡接管重出期（约数十秒），避免老师把滞留的旧卡当成结果抄题
  artifact.value = null
  // 🔴 修1/修2：换一批 = 新的一组 → 清旧配图缓存 + 复位首图 guard（防旧图串到新题、首张图重新直出）。
  resetFigureCachesForNewGroup()
  dispatch(firstComposeMessage, '🔁 换一批（按原母题重新出一组）')
}

/** 清空画布到「空会话」视觉态（新建 / 切换会话共用） */
function clearCanvas() {
  handle?.abort()
  stream.value = []
  currentRail.value = null
  artifact.value = null
  motherImg.value = ''
  imageUrl.value = ''
  pendingImages.value = []
  previewUrl.value = ''
  input.value = ''
  sending.value = false
  thinking.value = false
  typingBubble = null
  firstComposeMessage = null
  // PRD-C-017 B3：母题确认 / 入库态随会话重置
  needConfirmPayload.value = null
  confirmDialogVisible.value = false
  confirmSubmitting.value = false
  // PRD-C-017 B5：确认面记下的章/年级册人话名随会话重置（chip 不残留上轮）
  confirmedChapterName.value = ''
  confirmedGradeBookName.value = ''
  motherPersisting.value = false
  motherPersisted.value = false
  motherQuestionId.value = ''
  // PRD-C-100 B6：带图态随会话重置
  motherFigurePng.value = null
  motherFigureLoading.value = false
  motherFigureNeeds.value = false
  motherFigureReason.value = null
  for (const k of Object.keys(variantFigures)) delete variantFigures[Number(k)]
  // 🔴 修1/修2：stem 作废表 + 首图自动 guard 随会话重置（新会话/切会话从零开始自动出第一张）
  for (const k of Object.keys(figureStemAtIndex)) delete figureStemAtIndex[Number(k)]
  autoCropMotherDone = false
  autoComposeFirstDone = false
}

/** 新会话（原「新母题」）：换新 thread；首条消息发出时才登记进会话列表 */
function resetSession() {
  clearCanvas()
  threadId.value = crypto.randomUUID()
  try {
    localStorage.setItem(ACTIVE_KEY, '')
  } catch {
    /* noop */
  }
}

const URL_IN_TEXT_RE_G = /https?:\/\/[^\s)>'"]+/g

/** 恢复 / 切换到历史会话：/history 回放气泡 + /variant/artifact 重建右栏卡片 */
async function restoreSession(id: string) {
  clearCanvas()
  threadId.value = id
  try {
    localStorage.setItem(ACTIVE_KEY, id)
  } catch {
    /* noop */
  }
  restoring.value = true
  try {
    const [msgs, art] = await Promise.all([
      fetchVariantHistory(id),
      fetchVariantArtifact(id).catch(() => null),
    ])
    // P10：per-message 图注册表（按用户气泡发送序）；旧会话（P10 前）无此记录 → 回退用文本里的 URL
    const msgImgs = getThreadMsgImgs(id)
    let humanIdx = 0
    for (const m of msgs) {
      const text = String(m.content || '').trim()
      if (!text) continue
      if (m.type === 'human') {
        // 优先用注册表；缺失则从文本抠出内联 URL（向后兼容旧会话）
        const fromReg = msgImgs[humanIdx]
        const imgs =
          Array.isArray(fromReg) && fromReg.length
            ? fromReg
            : text.match(URL_IN_TEXT_RE_G) ?? []
        humanIdx++
        if (imgs.length) {
          // 第一条带图 human = 母题轮：回填顶部小徽章 +「换一批」基准
          if (!motherImg.value) motherImg.value = imgs[0]
          firstComposeMessage = firstComposeMessage ?? text
        }
        // 展示文本剥掉内联 URL（图改由气泡缩略图承载）
        const shownText = text.replace(URL_IN_TEXT_RE_G, '').replace(/\s+/g, ' ').trim()
        stream.value.push({
          type: 'bubble',
          role: 'user',
          text: shownText,
          images: imgs.length ? imgs : undefined,
        })
      } else if (m.type === 'ai') {
        stream.value.push({ type: 'bubble', role: 'ai', kind: 'normal', text })
      }
      // tool/custom 帧不回放（stage 思路条是过程态，历史会话无需重演）
    }
    if (art) artifact.value = art
    const meta = sessions.value.find((s) => s.id === id)
    if (meta?.img && !motherImg.value) motherImg.value = meta.img
  } catch (e) {
    console.warn('[variant] 历史会话恢复失败:', e)
    ElMessage.warning('历史会话拉取失败（举一反三服务 :8093 未启动？），已开新会话')
    threadId.value = crypto.randomUUID()
  } finally {
    restoring.value = false
  }
  scrollToBottom()
}

/** 删除会话（只删本地索引，BE checkpoint 不动）；删的是当前会话则顺手开新会话 */
function deleteSession(id: string) {
  sessions.value = sessions.value.filter((s) => s.id !== id)
  saveSessions()
  dropThreadMsgImgs(id) // P10：连带清理本会话的 per-message 图注册
  if (id === threadId.value) resetSession()
}

function sessionTime(at: number): string {
  const d = new Date(at)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

// 刷新恢复上次活跃会话（用户反馈③：聊天记录持久化的 FE 半边）
onMounted(() => {
  const active = (() => {
    try {
      return localStorage.getItem(ACTIVE_KEY) || ''
    } catch {
      return ''
    }
  })()
  if (active && sessions.value.some((s) => s.id === active)) {
    void restoreSession(active)
  }
})

onBeforeUnmount(() => {
  handle?.abort()
  document.removeEventListener('paste', onPaste)
})
</script>

<template>
  <div class="variant-page">
    <!-- PRD-C-017 B3·AC7 收窄移位：母题区从 C-015 全宽大横条 → 紧凑卡，移到「变式题组」标题区
         下方（ArtifactPanel mother-card 插槽）。下方仍双栏：左聊天 / 右变式题组 -->

    <!-- 母题年级册+章确认面（AC1/G1）：母题每次必停，收到 SSE needConfirm 弹出 -->
    <GradeChapterConfirmDialog
      v-model="confirmDialogVisible"
      :payload="needConfirmPayload"
      :submitting="confirmSubmitting"
      @confirm="onConfirmGradeChapter"
    />

    <!-- 🔴 PRD-C-100 B6·成本相关 UI：今日 AI 额度用尽横幅（文案用后端原文，含已用/上限 ¥） -->
    <el-alert
      v-if="budgetExceeded"
      class="budget-banner"
      type="warning"
      show-icon
      :closable="true"
      title="今日 AI 额度已用尽"
      :description="budgetMessage || '今日 AI 调用额度已用完，请明日再试或联系管理员调整额度。'"
      @close="budgetExceeded = false"
    />

    <!-- 下方双栏：左聊天 / 右变式题组 -->
    <div class="variant-main">
    <!-- 左栏：AI 命题搭子（对话 + 思路条 + 输入） -->
    <section class="variant-chat" data-testid="variant-chat-panel">
      <header class="chat-head">
        <span class="head-spark">✦</span>
        <span class="chat-title">AI 命题搭子</span>
        <span class="chat-sub">举一反三 · 图片变式</span>
        <!-- 会话管理（用户反馈④）：历史会话列表（切换/删除）+ 新会话 -->
        <el-popover placement="bottom-end" :width="300" trigger="click">
          <template #reference>
            <el-button text size="small" class="sessions-btn" :disabled="sending">
              历史会话<span v-if="sessions.length"> · {{ sessions.length }}</span>
            </el-button>
          </template>
          <div class="session-list">
            <p v-if="sessions.length === 0" class="session-empty">
              还没有历史会话，发出第一条消息后会自动记录
            </p>
            <div
              v-for="s in sessions"
              :key="s.id"
              class="session-item"
              :class="{ 'is-active': s.id === threadId }"
              @click="s.id !== threadId && !sending && restoreSession(s.id)"
            >
              <img v-if="s.img" :src="s.img" class="session-thumb" referrerpolicy="no-referrer" />
              <span v-else class="session-thumb session-thumb-empty">🧮</span>
              <span class="session-title">{{ s.title }}</span>
              <span class="session-time">{{ sessionTime(s.at) }}</span>
              <el-button
                text
                size="small"
                class="session-del"
                :disabled="sending"
                @click.stop="deleteSession(s.id)"
              >
                ✕
              </el-button>
            </div>
          </div>
        </el-popover>
        <el-button text size="small" class="reset-btn" :disabled="sending" @click="resetSession">
          ＋新会话
        </el-button>
      </header>

      <!-- 顶部：母题锚位（守恒锚小徽章）+ 图入口（Ctrl+V 粘贴截图 / 贴 URL） -->
      <div class="mother-bar">
        <!-- P10：母题不再是唯一展示位，顶部保留为当前母题小徽章（守恒锚视觉提示） -->
        <div v-if="motherImg" class="mother-badge" title="当前母题（守恒锚）" @click="previewUrl = motherImg">
          <img :src="motherImg" alt="母题" referrerpolicy="no-referrer" />
          <span class="badge-tag">母题</span>
        </div>
        <div class="mother-input">
          <el-input
            v-model="imageUrl"
            size="default"
            placeholder="可直接 Ctrl+V 粘贴截图，或贴 OSS / 公网图片地址（http…）后回车加入附件"
            :disabled="sending || uploading"
            clearable
            @keyup.enter.prevent="commitUrlInput"
            @blur="commitUrlInput"
          >
            <template #prepend>🖼 母题图</template>
          </el-input>
          <!-- P10：待发附件缩略图（可删除），发送时随用户气泡进流 -->
          <div v-if="pendingImages.length" class="pending-imgs">
            <div v-for="(u, k) in pendingImages" :key="k" class="pending-thumb">
              <img :src="u" referrerpolicy="no-referrer" @click="previewUrl = u" />
              <button type="button" class="pending-del" :disabled="sending" @click="removePending(u)">
                ✕
              </button>
            </div>
          </div>
          <p v-if="uploading" class="uploading-hint">截图上传中…</p>
          <p class="default-hint">
            默认配方：守考点 + 年级 + 难度，换数字 / 情境，出 3 道（2 普通 1 难）。
            出题后可直接点右侧卡片上的「换数字 / 换场景 / 答疑」，或在这里说
            「删第2」「难一点」「补2道同第3」，最后说「可以了」入库。
          </p>
        </div>
      </div>

      <div ref="streamRef" class="chat-stream">
        <div v-if="restoring" class="chat-empty">
          <div class="empty-emoji">⏳</div>
          <p class="empty-title">正在恢复上次会话…</p>
        </div>
        <div v-else-if="stream.length === 0" class="chat-empty">
          <div class="empty-emoji">🧮</div>
          <p class="empty-title">贴一张题目图，开始举一反三</p>
          <p class="empty-tip">
            AI 会先分析这道母题的年级 / 考点 / 题型，再出 3 道考点一致、只换数字情境的变式题。
            题组会以卡片形式出现在右侧画布，左侧保留 AI 的分析与解释。
          </p>
        </div>

        <template v-for="(item, i) in stream" :key="i">
          <!-- 气泡（用户 / AI 叙述 / 错误） -->
          <div
            v-if="item.type === 'bubble'"
            class="msg-row"
            :class="item.role === 'user' ? 'is-user' : 'is-ai'"
          >
            <div class="bubble" :class="item.role === 'ai' ? `ai-${item.kind}` : ''">
              <!-- P10：图随气泡进流（~120px 缩略图，点开看大图）；同气泡可带文字 -->
              <div v-if="item.images && item.images.length" class="bubble-imgs">
                <img
                  v-for="(u, k) in item.images"
                  :key="k"
                  :src="u"
                  class="bubble-img"
                  referrerpolicy="no-referrer"
                  @click="previewUrl = u"
                />
              </div>
              <!-- AI 气泡走富文本（markdown + LaTeX）；用户气泡纯文本 -->
              <MarkdownMath
                v-if="item.role === 'ai' && item.kind !== 'error'"
                :content="item.text"
              />
              <span v-else-if="item.text" class="bubble-text">{{ item.text }}</span>
            </div>
          </div>

          <!-- 本轮思路条锚点（钉在该轮用户气泡之后、AI 产出之前；历史轮留存） -->
          <template v-else>
            <!-- PRD-C-100 B6：AI 思考流可折叠块（有 reasoning 才渲染；流式期展开滚动，结束自动折叠） -->
            <div v-if="item.reasoning" class="msg-row is-ai">
              <div class="reasoning-block">
                <button
                  type="button"
                  class="reasoning-head"
                  @click="item.reasoningOpen = !item.reasoningOpen"
                >
                  <span class="reasoning-spark">🤔</span>
                  <span class="reasoning-title">AI 思考中…</span>
                  <span class="reasoning-toggle">{{ item.reasoningOpen ? '收起' : '展开' }}</span>
                </button>
                <pre v-show="item.reasoningOpen" class="reasoning-body">{{ item.reasoning }}</pre>
              </div>
            </div>
            <div v-if="item.stages.length > 0" class="msg-row is-ai">
              <AiStageRail class="stage-rail-wrap" :stages="item.stages" />
            </div>
          </template>
        </template>

        <!-- 思考中动效（token 流期）：仅作本轮首条 stage 到来前的兜底 -->
        <div v-if="thinking && currentRailEmpty" class="msg-row is-ai">
          <div class="bubble ai-normal thinking">
            <span class="dot-pulse" /><span class="dot-pulse" /><span class="dot-pulse" />
            <span class="thinking-text">AI 正在分析 / 出题…（出 3 道含解析，稍候）</span>
          </div>
        </div>
      </div>

      <footer class="chat-input">
        <el-input
          v-model="input"
          type="textarea"
          :rows="2"
          resize="none"
          placeholder="贴好图后回车「出3道」，或直接说编辑指令（删第2 / 难一点 / 补2道 / 可以了）…"
          :disabled="sending"
          @keyup.enter.exact.prevent="send"
        />
        <el-button
          type="primary"
          class="send-btn"
          :loading="sending"
          :disabled="!input.trim() && !imageUrl.trim() && pendingImages.length === 0"
          @click="send"
        >
          发送
        </el-button>
      </footer>
    </section>

    <!-- 右栏：变式题组画布（artifact 快照帧驱动；动作全部冒泡回左栏 chat 通道） -->
    <ArtifactPanel
      class="variant-artifact"
      :artifact="displayArtifact"
      :sending="sending"
      :can-regenerate="!!firstComposeMessage || !!motherImg"
      :reverifying-index="reverifyingIndex"
      :persisting-index="persistingIndex"
      :basketing-index="basketingIndex"
      :regenerating-indexes="regeneratingIndexes"
      :variant-figures="variantFigures"
      @utterance="sendUtterance"
      @regenerate="regenerate"
      @persist="persistAll"
      @reorder="onReorder"
      @edit="onEditItem"
      @reverify="onReverify"
      @persist-one="onPersistOne"
      @add-to-basket="onAddToBasket"
      @edit-dna="onEditDna"
      @edit-header-kp="onEditHeaderKp"
      @edit-header-grade="onEditHeaderGrade"
      @regen="onRegenOne"
      @undo-regen="onUndoRegen"
      @edit-models="onEditModels"
      @regen-all="onRegenAll"
      @compose-figure="onComposeVariantFigure"
      @preview="(u: string) => (previewUrl = u)"
      @manual-layout="onManualLayout"
    >
      <!-- AC7 收窄移位 + AC4 母题卡先出（全 10 维）+ M8 难点空文案 + G12 母题入库 -->
      <template #mother-card>
        <MotherCard
          :mother-card="motherCard"
          :confirmed-chapter-name="confirmedChapterName"
          :confirmed-grade-book-name="confirmedGradeBookName"
          :mother-img="motherImg"
          :persisted="motherPersisted"
          :persisting="motherPersisting"
          :mother-dirty="!!artifact?.header.motherDirty"
          :has-variants="!!artifact?.items.length"
          :regenerating="regeneratingIndexes.length > 0"
          :sending="sending"
          :figure-png="motherFigurePng"
          :figure-loading="motherFigureLoading"
          :figure-needs-figure="motherFigureNeeds"
          :figure-reason="motherFigureReason"
          @persist-mother="onPersistMother"
          @edit-mother-dna="onEditMotherDna"
          @regen-mother="onRegenAll"
          @start-variants="onStartVariants"
          @preview="(u: string) => (previewUrl = u)"
          @crop-figure="onCropMotherFigure"
          @manual-layout-mother="onManualLayoutMother"
        />
      </template>
    </ArtifactPanel>
    </div>

    <!-- P10：点开看大图（简易遮罩，点遮罩关闭；不引新依赖） -->
    <div v-if="previewUrl" class="img-preview-mask" @click="previewUrl = ''">
      <img :src="previewUrl" class="img-preview" referrerpolicy="no-referrer" @click.stop />
      <button type="button" class="img-preview-close" @click="previewUrl = ''">✕</button>
    </div>
  </div>
</template>

<style scoped>
/* DESIGN token：bg-50 #F5F8F8 / card #FFF / border #E3E9E9 / ink-900 #1D2A2E
   violet-600 #7B6CF0（AI 在场）/ teal-600 #1E8A8A（老师拍板） */
/* G13 ① v3 设计语言：深青 #0F6E6E + 暖纸白 #FBFAF6 + 暖琥珀 #B8741A（还原语言非逐像素） */
/* PRD-C-015 批5·D-merge4：外层改纵向（顶部母题横条 + 下方双栏），双栏在 .variant-main */
.variant-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 600px;
  background: #fbfaf6; /* 暖纸白 paper */
  padding: 16px;
  box-sizing: border-box;
}
/* PRD-C-100 B6：额度横幅（双栏上方，占满宽度） */
.budget-banner {
  margin-bottom: 12px;
  flex-shrink: 0;
}
/* 下方双栏容器：左聊天 / 右变式题组（占满母题横条以下剩余高度） */
.variant-main {
  display: flex;
  gap: 22px;
  flex: 1;
  min-height: 0;
}

/* G13 ⑥：左命题搭子 ~380px / 右变式 flex */
.variant-chat {
  flex: 0 0 380px;
  min-width: 340px;
  display: flex;
  flex-direction: column;
  background: #fff;
  border: 1px solid #e7e3da; /* line */
  border-radius: 16px;
  overflow: hidden;
}
.variant-artifact {
  flex: 1;
  min-width: 0;
  border: 1px solid #e7e3da;
  border-radius: 16px;
}

/* 小屏（<1024px）上下堆叠，各自内部滚动 */
@media (max-width: 1024px) {
  .variant-page {
    height: auto;
  }
  .variant-main {
    flex-direction: column;
    flex: none;
  }
  .variant-chat {
    flex: none;
    min-width: 0;
    height: 70vh;
  }
  .variant-artifact {
    flex: none;
    height: 60vh;
  }
}

.chat-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 18px;
  border-bottom: 1px solid #e3e9e9;
  flex-shrink: 0;
}
.head-spark {
  color: #7b6cf0; /* violet-600：AI 在场 */
  font-size: 15px;
}
.chat-title {
  font-size: 15px;
  font-weight: 700;
  color: #1d2a2e; /* ink-900 */
}
.chat-sub {
  font-size: 12px;
  color: #86909c;
}
.sessions-btn {
  margin-left: auto;
}
.reset-btn {
  margin-left: 0;
}

/* 母题图入口 */
.mother-bar {
  display: flex;
  gap: 12px;
  padding: 12px 18px;
  border-bottom: 1px solid #f5f5f5;
  background: #fafbfc;
  flex-shrink: 0;
}
/* P10：母题小徽章（守恒锚视觉提示，比原 72px 缩略图更克制） */
.mother-badge {
  position: relative;
  width: 48px;
  height: 48px;
  flex-shrink: 0;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid #7b6cf0; /* violet-600：守恒锚 */
  cursor: zoom-in;
}
.mother-badge img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.badge-tag {
  position: absolute;
  left: 0;
  bottom: 0;
  right: 0;
  font-size: 9px;
  color: #fff;
  text-align: center;
  background: rgba(123, 108, 240, 0.78);
  padding: 0 2px;
}
.mother-input {
  flex: 1;
  min-width: 0;
}

/* P10：待发附件缩略图行 */
.pending-imgs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.pending-thumb {
  position: relative;
  width: 56px;
  height: 56px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid #e5e6eb;
}
.pending-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  cursor: zoom-in;
}
.pending-del {
  position: absolute;
  top: 1px;
  right: 1px;
  width: 16px;
  height: 16px;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.pending-del:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.uploading-hint {
  margin: 6px 2px 0;
  font-size: 12px;
  color: #7b6cf0;
}
.default-hint {
  margin: 8px 2px 0;
  font-size: 12px;
  line-height: 1.6;
  color: #86909c;
}

.chat-stream {
  flex: 1;
  overflow-y: auto;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.chat-empty {
  margin: auto;
  text-align: center;
  color: #86909c;
}
.empty-emoji {
  font-size: 36px;
}
.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: #4e5969;
  margin: 8px 0 4px;
}
.empty-tip {
  font-size: 12px;
  color: #a0a8b3;
  max-width: 420px;
  line-height: 1.7;
}

.msg-row {
  display: flex;
}
.is-user {
  justify-content: flex-end;
}
.is-ai {
  justify-content: flex-start;
}
.bubble {
  max-width: 86%;
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}
.is-user .bubble {
  background: #4080ff;
  color: #fff;
  border-bottom-right-radius: 4px;
}

/* P10：气泡内图片缩略图（~120px），点开看大图 */
.bubble-imgs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
/* 图后若紧跟文本/富文本，补间距 */
.bubble-imgs:has(+ *) {
  margin-bottom: 6px;
}
.bubble-img {
  width: 120px;
  max-width: 100%;
  height: auto;
  max-height: 160px;
  object-fit: cover;
  border-radius: 8px;
  cursor: zoom-in;
  display: block;
}
.ai-normal {
  background: #f2f3f5;
  color: #1d2129;
  border-bottom-left-radius: 4px;
}
.ai-error {
  background: #fff1f0;
  border: 1px solid #ffccc7;
  color: #cf1322;
  border-bottom-left-radius: 4px;
}

/* 思路条在消息流里的占宽（视觉本体在 AiStageRail 组件内） */
.stage-rail-wrap {
  max-width: 86%;
  min-width: 300px;
}

/* PRD-C-100 B6：AI 思考流可折叠块（淡紫底，区别于正式气泡 / 思路条） */
.reasoning-block {
  max-width: 86%;
  min-width: 280px;
  border: 1px dashed #d6cffb;
  border-radius: 10px;
  background: #faf9ff;
  overflow: hidden;
}
.reasoning-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 12px;
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
}
.reasoning-spark {
  font-size: 13px;
}
.reasoning-title {
  font-size: 12px;
  font-weight: 600;
  color: #7b6cf0;
}
.reasoning-toggle {
  margin-left: auto;
  font-size: 11px;
  color: #a59bf0;
}
.reasoning-body {
  margin: 0;
  padding: 0 12px 10px;
  max-height: 220px;
  overflow-y: auto;
  font-size: 12px;
  line-height: 1.6;
  color: #8478b8;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
}

/* 思考中动效 */
.thinking {
  display: flex;
  align-items: center;
  gap: 6px;
}
.dot-pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #7b6cf0; /* violet-600：AI 在场 */
  animation: dot-pulse 1.2s infinite ease-in-out;
}
.dot-pulse:nth-child(2) {
  animation-delay: 0.2s;
}
.dot-pulse:nth-child(3) {
  animation-delay: 0.4s;
}
@keyframes dot-pulse {
  0%,
  80%,
  100% {
    transform: scale(0.6);
    opacity: 0.4;
  }
  40% {
    transform: scale(1);
    opacity: 1;
  }
}
.thinking-text {
  font-size: 12px;
  color: #86909c;
  margin-left: 4px;
}

.chat-input {
  flex-shrink: 0;
  padding: 12px 14px;
  border-top: 1px solid #e3e9e9;
  display: flex;
  gap: 10px;
  align-items: flex-end;
}
.chat-input :deep(.el-textarea) {
  flex: 1;
}
.send-btn {
  height: 56px;
  padding: 0 22px;
}

/* 会话列表（popover 内容由本组件模板渲染，scoped 样式可达） */
.session-list {
  max-height: 320px;
  overflow-y: auto;
}
.session-empty {
  font-size: 12px;
  color: #a0a8b3;
  text-align: center;
  padding: 12px 0;
  margin: 0;
}
.session-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 8px;
  cursor: pointer;
}
.session-item:hover {
  background: #f5f8f8;
}
.session-item.is-active {
  background: #f1eeff; /* violet 浅底：当前会话 */
  cursor: default;
}
.session-thumb {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  border-radius: 6px;
  object-fit: cover;
  border: 1px solid #e5e6eb;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
}
.session-thumb-empty {
  background: #f2f3f5;
}
.session-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: #1d2a2e;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-time {
  font-size: 11px;
  color: #a0a8b3;
  flex-shrink: 0;
}
.session-del {
  padding: 2px 4px;
  color: #c0c6cf;
}
.session-del:hover {
  color: #cf1322;
}

/* P10：大图预览遮罩 */
.img-preview-mask {
  position: fixed;
  inset: 0;
  z-index: 3000;
  background: rgba(0, 0, 0, 0.75);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: zoom-out;
}
.img-preview {
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
  border-radius: 8px;
  cursor: default;
}
.img-preview-close {
  position: fixed;
  top: 20px;
  right: 24px;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.18);
  color: #fff;
  font-size: 18px;
  cursor: pointer;
}
.img-preview-close:hover {
  background: rgba(255, 255, 255, 0.32);
}
</style>
