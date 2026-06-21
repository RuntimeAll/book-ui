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
  verifyVariantOne,
} from '@/api/variant'
import type { DnaEditValue, DnaField, MotherFigureItem } from '@/api/variant'
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
import { createQuestionWithDna, deleteQuestionBlock, lazyTree } from '@/api/question/index'
import type { CreateQuestionWithDnaBo, QuestionItem, SubjectNode } from '@/api/question/index'
import MarkdownMath from '@/components/MarkdownMath.vue'
import PhasedStatusRail from './PhasedStatusRail.vue'
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

// ---------------------------------------------------------------------------
// 改点③（PRD-A-017 批2d）：AI 气泡语义高亮分类。
//   数据现状：Bubble 只有 kind:'normal'|'error'（无结构化语义标记），确认走独立 dialog。
//   故 normal 气泡按【内容朴素归类】（不硬造数据结构，不改 Bubble 类型）：
//     error            → t-error   （红左条 ⚠）—— 来自 kind，确定。
//     含「确认/请核对/开始举一反三」  → t-confirm （紫左条·待确认+行动）。
//     含「就绪/入库/可以了/完成/通过」 → t-done    （青左条 ✓ 完成通知）。
//     含「变式」且含「验算/平行度」   → t-summary （题组摘要，卡片化）。
//     其余                          → t-normal  （朴素灰答疑）。
//   类名映射到 scoped 左边条样式（见 <style>），全用 var(--xxx)。
// ---------------------------------------------------------------------------
function bubbleSemantic(b: Bubble): string {
  if (b.kind === 'error') return 't-error'
  const t = b.text || ''
  if (/确认|请核对|请核实|开始举一反三|是否继续|帮我确认/.test(t)) return 't-confirm'
  if (/已就绪|可以了|已入库|收录成功|入库成功|完成|通过|搞定/.test(t)) return 't-done'
  if (/变式/.test(t) && /(验算|平行度|题组|这组)/.test(t)) return 't-summary'
  return 't-normal'
}

const stream = ref<StreamItem[]>([])
const input = ref('')
const imageUrl = ref('') // URL 输入框：手贴公网图地址（回车/发送时并入 pendingImages）
// 🔴 PRD-A-017 composer 对齐设计稿：URL 输入框默认收起，点「🔗 链接」内联展开（纯 UI 开合，逻辑零改）
const showUrlInput = ref(false)
// PRD-C-013 P10：待发附件缩略图（粘贴上传 / 贴 URL 都进这里）。发送时随用户气泡进流后清空。
const pendingImages = ref<string[]>([])
const motherImg = ref('') // 已发出的母题图，顶部小徽章常驻（守恒锚视觉提示）
const previewUrl = ref('') // 点开看大图（el-image-viewer / 简易遮罩）
const sending = ref(false)
const thinking = ref(false) // LLM token 流期的「思考中」动效
// 🔴 思考过程开关（老师手动开/关思考链）：开 → 本轮经 agent_config(thinking_stream=true)
//   回传 toolkit，BE 路由到支持 extended-thinking 的中转站(aigeek) + bind reasoning_effort，
//   reasoning 帧流式外显（点亮已就绪的可折叠「思考中」块）；走付费站、reasoning 按输出计费。
//   关（默认）→ 维持现状（走主站、不带 thinking、便宜）。开了但成交站不支持 → 参数静默忽略，
//   思考块不显示，绝不报错（graceful，见 streamVariant onReasoning 向后兼容）。
const thinkingStream = ref(false)
// 当前轮 rail 锚点（onStage 只更新它；新一轮 send 换新锚点，旧轮 rail 冻结留存）
const currentRail = ref<RailItem | null>(null)
// 🔴 PRD-A-018 G10-5：最后一轮有内容的 rail 快照（sticky）。编辑/结构化指令轮不发阶段帧 →
//   currentRail 空，但题组在场时不该显「待机·0/2」（进度条像被结束）→ 回落显示它。
const lastRailStages = ref<VariantStage[]>([])
// PRD-C-011：右栏卡片栅数据源 = artifact 快照帧（snapshot 全量，整量替换）
const artifact = ref<VariantArtifact | null>(null)
// 🔴 PRD-A-018 G10-5：题组在场时的「出题完成」合成 rail——恢复会话/编辑轮拿不到上一轮 rail 时，
//   用它兜底，避免状态条显「待机·0/2」（进度条像被结束）。配图节点无 figure 帧 + 核心 done → 自动跳过done。
const SETTLED_RAIL: VariantStage[] = [
  { key: 'generate', title: '生成变式', status: 'done', detail: '已生成' },
  { key: 'gene_gate', title: '考点一致比对', status: 'done', detail: '逐道与母题对照考点' },
  { key: 'verify', title: '程序验算', status: 'await', detail: '可选 · 待老师自选验算' },
  { key: 'persist', title: '题组就绪', status: 'done', detail: '题组就绪 · 可换数字 / 换场景 / 重生这道 / 入库' },
]
// 🔴 PRD-A-018 G10-5：状态条展示用阶段——当前轮有帧用当前轮；新发送中留空（starting 兜「启动中」）；
//   否则题组在场时：优先回落上一轮 rail，无则用「出题完成」合成 rail，绝不显「待机」（进度条像被结束）。
const railStages = computed<VariantStage[]>(() => {
  const cur = currentRail.value?.stages ?? []
  if (cur.length) return cur
  if (sending.value) return cur
  if ((artifact.value?.items?.length ?? 0) > 0) {
    return lastRailStages.value.length ? lastRailStages.value : SETTLED_RAIL
  }
  return cur
})

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
// 🔴 PRD-A-017 批2b 合并头 chip：年级·章文案（传 ArtifactPanel 合并头）。
//   与母题卡共用同一真值——年级 = 老师确认册名优先 → 母题卡 anchorGrade 兜底；
//   章 = 老师确认章名优先 → 母题卡 anchorChapterId 兜底。母题未就绪（无 motherCard）→ null（不显 chip/caret）。
const anchorChip = computed<string | null>(() => {
  if (!motherCard.value) return null
  const grade = confirmedGradeBookName.value.trim() || motherCard.value.anchorGrade?.trim() || ''
  // 🔴 BUG-08：章 = 老师确认章名 → 后端 anchor.chapter_name（新增章名）→ chapter_id 兜底
  const chapter =
    confirmedChapterName.value.trim() ||
    motherCard.value.anchorChapterName?.trim() ||
    motherCard.value.anchorChapterId?.trim() ||
    ''
  if (grade && chapter) return `${grade} · ${chapter}`
  return grade || chapter || null
})
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
// 🔴 PRD-C-100 bug-002 单元3：母题多图。motherFigures = 全部成功切图（按检出顺序，v-for 渲染）。
//   motherFigurePng（首图 computed）保留供老路径/兜底引用，不再是真相源。
const motherFigures = ref<MotherFigureItem[]>([])
const motherFigurePng = computed<string | null>(() =>
  motherFigures.value.length ? motherFigures.value[0].pngBase64 : null
)
const motherFigureLoading = ref(false)
const motherFigureNeeds = ref(false)
const motherFigureReason = ref<string | null>(null)

// 变式图态：按题 index（1-based）存。{png, loading, needs, reason, ossUrl, commands}
interface VariantFigureState {
  png: string | null
  loading: boolean
  needs: boolean
  reason: string | null
  /** PRD-C-100 BC2：本图已传 OSS 后的 https url（base64→OSS 只传一次，防重复入库重传） */
  ossUrl?: string | null
  /**
   * 🔴 PRD-C-100 C：本图上一版 GeoGebra commands（compose 成功时存住）。图片重生（带 correctionPrompt）
   * 时透传给后端 → BE 在上一版命令基础上增量改图，而非从零重画（继承上一版骨架）。
   */
  commands?: string[]
  /**
   * 🔴 配图主动引导（BE 信号回填）：画不准/画不出时 BE 标 needUserDesc → FE 在⚠待补图区显眼提示
   * 「补一句图形描述」并把老师引到 figCorrection 修正框（补完发 → 走既有 composeVariantFigure 重画）。
   */
  needUserDesc?: boolean
  /** 🔴 方向待确认（BE 信号回填）：含方向元素（旋转/箭头/镜像/平移）→ FE 加「⚠ 方向待确认」徽章。 */
  directionReview?: boolean
}

// 🔴 PRD-C-100 C：把 compose 返回的 commands（unknown）规整成 string[]（每条命令字符串）；非数组/空 → []。
function normalizeCommands(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const c of raw) {
    if (typeof c === 'string' && c.trim()) out.push(c)
  }
  return out
}
const variantFigures = reactive<Record<number, VariantFigureState>>({})

// 🔴 修1（图串台 root cause）：variantFigures 按「裸 1-based index」缓存，而 index 在「换一批」/
//   改年级重出 / 重生 / onArtifact 整量替换后会被新一组题复用 —— 旧 index 的图直接套到新题上。
//   这里记下「该 index 当前缓存的图是为哪条题面（stem）生成的」，onArtifact 收到新快照时逐 index 比对，
//   凡题面变了的 index 一律作废它的旧图（删 variantFigures[index]），让新题用自己的题面重画，不复用旧图。
//   选 (a)「按 stem 比对作废」而非 (b)「换 key」：因为「换一批」是新的一组题、seq 仍从 1 重排，
//   seq/index 都不足以区分新旧题，唯有题面 stem 是真正的内容信号；且所有变更路径都汇流到 onArtifact，
//   在此一处兜底最稳、partial 增量帧也天然覆盖（某题 stem 跨帧变化只作废它自己）。
const figureStemAtIndex = reactive<Record<number, string>>({})

// 🔴 修2（首轮配图全覆盖，B 家族）：母题切图每组一次性 guard 不变；变式造图改为
//   「逐题已自动触发集合」（autoComposedIndexes）—— 第一轮定稿后，对该组所有「还没图且不在 loading」
//   的题各自动触发一次造图（不再只第一道），并发限流（AUTO_FIGURE_CONCURRENCY）防一次性 N 个把中转打挂。
//   换一批 / 改范围 = 新的一组 → 集合清空后重新全量自动出图；clearCanvas 也清空。
let autoCropMotherDone = false
// 已自动触发过造图的题 index（1-based）集合；按 index 逐题去重，避免一道触发后整组被单布尔挡住。
const autoComposedIndexes = new Set<number>()
// 🔴 首轮自动造图并发上限：sui-xiang 中转稳定性随机，一次性 N 并发易打挂 → 分批 3 张。
const AUTO_FIGURE_CONCURRENCY = 3

/**
 * 修1 核心：onArtifact 整量替换前，按 stem 作废受影响 index 的旧配图。
 *   - 新快照里某 index 的 stem ≠ 该 index 已缓存图对应的 stem → 删 variantFigures[index]（旧图作废）。
 *   - 当前快照里不存在的 index（题被删 / 组变小）→ 连带清掉残留图，免下一组复用。
 *   - 首题（index 最小，通常 1）题面变了 = 这是「新的一组」→ 清空 autoComposedIndexes，让首轮配图全量重出。
 *   - 题面变了的某 index：除作废旧图外，还从 autoComposedIndexes 摘除，使该题重新进入「自动出图」候选。
 *   纯 partial 增量帧（同组逐题上屏）里 stem 不变 → 不误删已生成的图（只新增 index 登记）。
 */
function invalidateStaleFigures(next: VariantArtifact | null) {
  const items = next?.items ?? []
  const nextStems = new Map<number, string>()
  for (const it of items) nextStems.set(it.index, it.stem || '')

  // 1) 当前快照已不含的 index：清残留图 + 登记 + 摘除自动触发记录
  for (const k of Object.keys(variantFigures)) {
    const idx = Number(k)
    if (!nextStems.has(idx)) {
      delete variantFigures[idx]
      delete figureStemAtIndex[idx]
      autoComposedIndexes.delete(idx)
    }
  }
  // 2) 题面变了的 index：作废旧图（让新题用自己的题面重画）+ 摘除自动触发记录（该题待重新自动出图）
  let firstItemChanged = false
  const minIndex = items.length ? Math.min(...items.map((it) => it.index)) : 0
  for (const [idx, stem] of nextStems) {
    const prev = figureStemAtIndex[idx]
    if (prev !== undefined && prev !== stem) {
      delete variantFigures[idx] // 旧图作废，绝不串到新题
      autoComposedIndexes.delete(idx) // 题面已变 → 允许该题重新自动造图
      if (idx === minIndex) firstItemChanged = true
    }
    figureStemAtIndex[idx] = stem
  }
  // 3) 首题题面变了 = 新的一组 → 清空自动触发集合（换一批 / 改范围重出后首轮配图全量重出）
  if (firstItemChanged) autoComposedIndexes.clear()
}

function ensureVariantFigure(index: number): VariantFigureState {
  if (!variantFigures[index]) {
    variantFigures[index] = { png: null, loading: false, needs: false, reason: null, ossUrl: null }
  }
  return variantFigures[index]
}

/**
 * 修2（B 家族·首轮配图全覆盖）：拿到一组题后，对**所有**还没图的变式题自动出图（不再只第一道）。
 *   - 母题「切图形」：母题确有原图（motherImg 非空）且本组未自动切过 → 触发一次 cropMotherFigure。
 *   - 变式造图：仅**定稿帧**（`!a.partial`）触发；遍历该组所有 items，对「未自动触发过（不在
 *     autoComposedIndexes）且还没图（!st.png）且不在 loading」的题各触发一次造图。
 *   并发限流（AUTO_FIGURE_CONCURRENCY=3）：分批 await，避免一次性 N 个并发把中转打挂。
 *   逐题去重靠 autoComposedIndexes（Set），一道触发不挡其余；换一批/改范围 = invalidateStaleFigures 清集合后全量重出。
 *   partial 增量帧不触发变式造图（题面还在变，避免造废图）；母题切图便宜不 gate partial。
 *   needs_figure 降级：某题画不出由 onComposeVariantFigure 内部落 ⚠待补图，自动触发集合仍记其 index（已尝试过），
 *     不卡其余题（老师可手动重切单题）。
 */
function maybeAutoFirstFigures(a: VariantArtifact | null) {
  // 母题切图（裁图便宜，没理由 gate；母题原图在即可，partial/定稿都可）
  if (!autoCropMotherDone && motherImg.value && !motherFigurePng.value && !motherFigureLoading.value) {
    autoCropMotherDone = true
    void onCropMotherFigure()
  }
  // 变式造图：仅定稿帧（无 partial）才自动造，避免对还在变的增量题面造废图
  if (a && !a.partial && a.items.length) {
    // 候选 = 未自动触发过 + 还没图 + 不在 loading，按 index 升序（首题优先出）
    const pending = a.items
      .filter((it) => {
        if (autoComposedIndexes.has(it.index)) return false
        const st = variantFigures[it.index]
        return !(st && st.png) && !(st && st.loading)
      })
      .sort((x, y) => x.index - y.index)
    if (pending.length) {
      // 先登记（防 reactivity tick 内重复入队），再分批限流跑
      for (const it of pending) autoComposedIndexes.add(it.index)
      void runAutoFiguresBatched(pending.map((it) => it.index))
    }
  }
}

/**
 * 并发限流跑首轮自动造图：每批 AUTO_FIGURE_CONCURRENCY 个并发，批间 await，控住中转压力。
 *   onComposeVariantFigure 自带 st.loading 单题去重锁 + needs_figure 降级，逐题失败不互相牵连。
 */
async function runAutoFiguresBatched(indexes: number[]) {
  for (let i = 0; i < indexes.length; i += AUTO_FIGURE_CONCURRENCY) {
    const batch = indexes.slice(i, i + AUTO_FIGURE_CONCURRENCY)
    await Promise.allSettled(batch.map((index) => onComposeVariantFigure({ index })))
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
  // 单元1：本地点亮「画图配图」灯（母题切图）
  upsertFigureStage(FIGURE_STAGE_MOTHER, 'running', '母题切图')
  try {
    const res = await cropMotherFigure(threadId.value, userStore.accessToken, motherImg.value)
    // 🔴 PRD-C-100 P7 + 单元3：重切成功（切出 ≥1 张）才覆盖；失败（needs_figure/无图）保留上一版好图，
    //   只更原因，不让一次失败的重切把已切好的母题图清成 ⚠待补图（UX 退步）。
    if (res.figures.length) {
      motherFigures.value = res.figures // 多图整组替换（v-for 渲染全部）
      motherFigureNeeds.value = false
      // 单元3：成功数 < 检出数（部分降级）→ 灯标 done 但 detail 外显「成功 N/M 张」（reason 已含文案）
      const partial = res.nFigures > res.figures.length
      upsertFigureStage(
        FIGURE_STAGE_MOTHER,
        partial ? 'warn' : 'done',
        partial ? `母题切图 ${res.figures.length}/${res.nFigures} 张` : `母题切图 ${res.figures.length} 张`
      )
    } else {
      motherFigureNeeds.value = res.needsFigure && !motherFigures.value.length
      // 🔴 PRD-A-018 C2(A-11)：纯文本/纯公式母题(needs_figure=false)= 本就无图可切 → 跳过(done)，
      //   不标 ⚠待补图(warn)，避免母题切图节点对无图母题误显「异常」。仅「本应有图却没切出」才 warn。
      const skipNoFigure = !motherFigures.value.length && !res.needsFigure
      // 无图：有旧图→done(沿用)；本就无图可切→done(跳过)；本应有图却缺→warn(待补图)
      upsertFigureStage(
        FIGURE_STAGE_MOTHER,
        motherFigures.value.length ? 'done' : skipNoFigure ? 'done' : 'warn',
        res.reason ||
          (motherFigures.value.length
            ? '沿用上一版图'
            : skipNoFigure
              ? '无图可切（纯文本/公式题）'
              : '未切出图形')
      )
    }
    motherFigureReason.value = res.reason
  } catch (e) {
    motherFigureReason.value = `切图失败：${e instanceof Error ? e.message : String(e)}`
    upsertFigureStage(FIGURE_STAGE_MOTHER, 'warn', '切图失败')
  } finally {
    motherFigureLoading.value = false
  }
}

/**
 * 🔴 AC-TOKEN：母题卡上老师手点的「切图形 / 重新切图」走这里——切图调中转造图（耗 token）→ 先过确认闸。
 *   首轮自动切图（maybeAutoFirstFigures → onCropMotherFigure 直调）不经此包装、不弹闸（系统自动行为）。
 */
async function onCropMotherFigureFromUser() {
  if (motherFigureLoading.value || !motherImg.value) return
  if (!(await confirmTokenSpend('切图会调用 AI 处理母题图形、消耗 token。'))) return
  await onCropMotherFigure()
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
  // 单元1：本地点亮「画图配图」灯（变式造图，按 index 区分防多图并发串台）
  const stageKey = figureStageKey(payload.index)
  upsertFigureStage(stageKey, 'running', `第 ${payload.index} 题`)
  try {
    const res = await composeVariantFigure(threadId.value, userStore.accessToken, {
      stem: item.stem,
      answer: item.answer || undefined,
      itemId: item.seq || item.index,
      correctionPrompt: payload.correctionPrompt,
      // 🔴 PRD-C-100 C：图片重生（带 correctionPrompt）时把上一版命令透传 → BE 在其基础上增量改图。
      //   首次造图（无 correctionPrompt）或没存到上一版（st.commands 空）则不传，BE 退原行为。
      prevCommands: payload.correctionPrompt ? st.commands : undefined,
    })
    // 🔴 PRD-C-100 P7：成功（有 png）才覆盖图；失败（needs_figure/无 png）只更原因，保留上一版好图，
    //   不让一次失败的重造把已有好图清成 ⚠待补图（UX 退步）。
    if (res.pngBase64) {
      st.png = res.pngBase64
      st.needs = false
      st.needUserDesc = false // 成功出图 → 不再催补描述
      // 🔴 方向待确认：成功出图但含方向元素 → 标徽章（图照常展示，引导确认方向）。
      st.directionReview = res.directionReview
      // 成功时存住本版命令（供下次图片重生作增量基准）；BE 没回命令则保留上一版 commands。
      const cmds = normalizeCommands(res.commands)
      if (cmds.length) st.commands = cmds
      // 单元1：成功 → 灯 done
      upsertFigureStage(stageKey, 'done', `第 ${payload.index} 题`)
    } else {
      // 失败/降级：旧图（若有）保留，仅当本来就没图时才标 ⚠待补图。
      st.needs = res.needsFigure && !st.png
      // 🔴 主动引导：BE 标 needUserDesc（画不准/画不出且本应有图）→ FE 提示补描述（无旧图时才催，避免对已有好图误催）。
      st.needUserDesc = res.needUserDesc && !st.png
      st.directionReview = false
      // 🔴 PRD-A-018 C2(A-11)：区分「本就无需配图(needs_figure=false，纯文本/纯代数变式)」与「本应有图却没产出」。
      //   前者 = 跳过(done)，不让纯文本变式把配图节点污染成「异常·待补图」、不挂住题组就绪；
      //   后者(本应有图却没产出且无旧图)才 ⚠待补图(warn)。
      const skipNoFigure = !st.png && !res.needsFigure
      // 单元1：有旧图→done(沿用)；本就无需图→done(跳过)；本应有图却缺→warn(待补图)
      upsertFigureStage(
        stageKey,
        st.png ? 'done' : skipNoFigure ? 'done' : 'warn',
        st.png
          ? `第 ${payload.index} 题·沿用上一版图`
          : skipNoFigure
            ? `第 ${payload.index} 题·无需配图`
            : `第 ${payload.index} 题·待补图`
      )
    }
    st.reason = res.reason
  } catch (e) {
    // 🔴 PRD-C-100 B3-配图：失败时错误可读（API 已把 422 结构化 detail 摊成 message，不再 [object Object]）。
    //   🔴 P7：仅当本来无图时才落「⚠待补图」徽章；已有好图保留（重造失败不抹旧图）。
    st.needs = !st.png
    st.reason = `配图失败：${e instanceof Error ? e.message : String(e)}`
    // 单元1：异常 → 灯 warn
    upsertFigureStage(stageKey, 'warn', `第 ${payload.index} 题·配图失败`)
  } finally {
    st.loading = false
  }
}

/**
 * 🔴 AC-TOKEN：变式卡上老师手点的「配图 / 重新配图 / 图歪了重新生成」走这里——配图调中转造图（耗 token）
 *   → 先过确认闸，确认才真造图。首轮自动出图（maybeAutoFirstFigures → onComposeVariantFigure 直调）
 *   不经此包装、不弹闸（系统自动行为，非老师按钮触发）。模板 @compose-figure 绑此包装。
 */
async function onComposeFigureFromUser(payload: { index: number; correctionPrompt?: string }) {
  const st = variantFigures[payload.index]
  if (st?.loading) return
  if (!(await confirmTokenSpend('配图会调用 AI 生成图形、消耗 token。'))) return
  await onComposeVariantFigure(payload)
}

/**
 * 🔴 PRD-A-018：方向待确认——老师点「方向没问题」→ 清该题 directionReview，消徽章。
 *   方向徽章原只有「补一句说明重画」一条出口，方向本就对时无法消除→一直待确认。这里给确认出口。
 */
function onConfirmDirection(index: number) {
  const st = variantFigures[index]
  if (st) st.directionReview = false
}
// 题组编辑器：正在重新验算的题 index（1-based），驱动该卡 loading 态
const reverifyingIndex = ref<number | null>(null)
// 🔴 BUG-09 手动验算：正在「验算」的题 index（1-based）+ 验算结果表（按 index 持有 verify-one 回填）。
//   生成后不自动验算（item.verifyStatus='pending'），老师点「验算」/「全部验算」主动触发。
const verifyingIndex = ref<number | null>(null)
// 🔴 PRD-A-018 A-3 根治串台：验算结果改按【题面 stem】持有（不再按裸 1-based index）。
//   原因：换一批/改年级/重生后 index/seq 会复用，按 index 持有 → 旧「✓验算通过」盖到新题（串台假徽章）。
//   stem 是跨重批最稳定的题身份；新题 stem 不同 → 自然不命中旧结果。配套生命周期清理：
//   整组路径（clearCanvas[含切会话/新会话] / 换一批 / 改年级）清空；单题路径（编辑/重验/重生/撤销重生/改DNA）
//   按操作前捕获的旧 stem delete。
const verifyResults = reactive<
  Record<string, { verdict: 'pass' | 'fail' | 'degrade' | null; detail: string | null; computed: string | null }>
>({})
/** 清空全部验算结果（整组路径：切会话 / 新会话 / 换一批 / 改年级）。 */
function clearAllVerifyResults() {
  for (const k of Object.keys(verifyResults)) delete verifyResults[k]
}
/** 按题面 stem 清单题验算结果（单题路径：编辑 / 重验 / 重生 / 撤销重生 / 改DNA 后旧结果作废）。 */
function clearVerifyResultByStem(stem: string | undefined | null) {
  if (stem && stem in verifyResults) delete verifyResults[stem]
}
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
// 🔴 PRD-A-021 R1 收口：忙态单一事实源（busy）。
//   sending = 聊天/出题 SSE 流在跑（generate / 解析 / 换一批 / 答疑 / 母题确认续聊）。
//   但「重生 / 验算 / 入库 / 加篮 / 重验」走结构化 BE 端点、不置 sending、与 SSE 并发。
//   后端已加 per-thread 并发锁（同 thread 另一轮在跑 → 立即回 {"type":"processing"} 早退），
//   FE 据此把会触发后端写操作的【组级动作按钮】在任一在途态期间禁掉，避免老师在「出题/解析/
//   重生/验算」进行中再点「换一批 / 全部入库 / 重生 N 题 / 全部验算」撞锁早退（白点一次 + 警告）。
//   单题按钮（编辑/配图/单题重生/入库/加篮…）各自带 per-index loading 锁 + sending 守，已覆盖，
//   这里只统一组级跨切动作的「全局忙」信号。busy 不替代 sending（sending 仍驱动生成骨架），是并集。
const busy = computed(
  () =>
    sending.value ||
    regeneratingIndexes.value.length > 0 ||
    reverifyingIndex.value !== null ||
    verifyingIndex.value !== null ||
    persistingIndex.value !== null ||
    basketingIndex.value !== null ||
    motherPersisting.value ||
    motherFigureLoading.value
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

// ── 改点②（PRD-A-017 批2e）：📎 上传图片 = 点按钮弹原生文件选择框 ──
//   原仅支持 Ctrl+V 粘贴 / 贴 URL；补一个隐藏 file input + 📎 按钮 click 触发它，
//   选中文件复用既有 uploadPastedImage handler（同口径校验 + 传 OSS + 进待发附件），上传后处理逻辑不变。
const fileInput = ref<HTMLInputElement | null>(null)
function pickImageFile() {
  if (sending.value || uploading.value) return
  fileInput.value?.click()
}
function onFilePicked(e: Event) {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  if (file) void uploadPastedImage(file)
  target.value = '' // 复位，使同一文件可再次选中触发 change
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

/**
 * 🔴 PRD-A-018 A-7：placeholder 写「拖入图片」必须真能拖——补 drop 监听复用 uploadPastedImage，
 *   避免「写了拖入但拖图没反应/页面跳走」的失信。dragover 须 preventDefault 才能触发 drop。
 */
function onImageDrop(e: DragEvent) {
  if (sending.value) return
  const file = e.dataTransfer?.files?.[0]
  if (file && file.type.startsWith('image/')) {
    void uploadPastedImage(file)
  }
}

onMounted(() => document.addEventListener('paste', onPaste))

// ---------------------------------------------------------------------------
// 🔴 PRD-A-021 B5 — 对话开启前「可选」预设年级/章（省 LLM 钱 + 少一步确认 + 更准）。
//   空态左栏 composer 上方放两级级联（年级册 → 章），数据源复用既有 lazyTree(0)
//   （/teacher/question/lazyTree 整树，顶层=年级册 level1、children=章 level2，字段 id/title/children）——
//   与 GradeChapterConfirmDialog / KpTreeDialog 同一棵 biz_subject 树，禁重造接口。
//   可选：不选不挡流程；首轮发起时若选了，把 preset_grade_book(年级册人话名) + preset_chapter_id
//   （章 id，老师只选到年级册时回退年级册 id）塞进 agent_config.configurable（见 send()）。
//   没选 → 不塞这两键，维持现有 classify 路径（核心红线：不选时行为与现状完全一致）。
// ---------------------------------------------------------------------------
const presetTree = ref<SubjectNode[]>([])
const presetTreeLoading = ref(false)
const presetGradeBookId = ref('') // 选中的年级册（level1）id，可空
const presetChapterId = ref('') // 选中的章（level2）id，可空（只选年级册也行）

// 年级册下拉选项（lazyTree 顶层）
const presetGradeBooks = computed(() => presetTree.value)
// 当前年级册下的章（level2 children）
const presetChapters = computed<SubjectNode[]>(() => {
  const gb = presetTree.value.find((n) => String(n.id) === presetGradeBookId.value)
  return gb?.children ?? []
})
const presetGradeBookName = computed(
  () => presetGradeBooks.value.find((n) => String(n.id) === presetGradeBookId.value)?.title ?? ''
)

/** 懒加载年级册/章树（仅空态首次需要时拉一次；失败不打扰，选择器自然空着、不挡发送）。 */
async function loadPresetTree() {
  if (presetTree.value.length || presetTreeLoading.value) return
  presetTreeLoading.value = true
  try {
    const result = await lazyTree(0)
    if (Array.isArray(result)) presetTree.value = result
    else if (result && typeof result === 'object') presetTree.value = [result as unknown as SubjectNode]
  } catch (e) {
    // 🔴 A-21：技术详情进 console，老师侧静默（预设是可选增强，拉不到不影响主流程）
    console.error('[variant] 预设年级/章树加载失败：', e)
  } finally {
    presetTreeLoading.value = false
  }
}

// 换年级册 → 清掉旧章选择（避免章 id 挂错册）
function onPresetGradeBookChange() {
  presetChapterId.value = ''
}

// 空态出现时拉一次树（对话开始后选择器不再显示，无需提前拉）
onMounted(() => {
  if (stream.value.length === 0) void loadPresetTree()
})

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

// crypto.randomUUID 仅在安全上下文(HTTPS / localhost)可用；prod 走 HTTP(jpjia.cn)
// 时该 API 不存在，会抛 TypeError 把整个页面打白。thread_id 非安全敏感值，
// 非安全上下文回退 getRandomValues / Math.random 生成 RFC4122 v4。
function genUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    let r: number
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      r = crypto.getRandomValues(new Uint8Array(1))[0] % 16
    } else {
      r = (Math.random() * 16) | 0
    }
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

// 会话级 thread_id：同会话所有 send 复用 → agent 记住当前题组。
// 刷新不再换新 —— onMounted 恢复上次活跃会话（用户反馈③）。ref 是为了
// 会话列表里 is-active 高亮能跟着切换走（模板里要响应式）。
const threadId = ref<string>(genUUID())
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

// ---------------------------------------------------------------------------
// 🔴 PRD-A-017 批2e · AC-TOKEN — 耗 token 必经老师确认闸。
//   规则：任何会「调 AI 生成 / 消耗 token」的动作，执行前先弹确认（老师知情同意才烧 token）。
//   豁免：老师自己在对话框打字「发送」（send，打字+发送本身即同意）。
//   实现：统一 confirmTokenSpend()（包 ElMessageBox.confirm，文案点明「消耗 token」，青紫冷浅样式）。
//     取消（reject）→ resolve(false)，调用方据此「不触发 emit / 不调接口」直接 return。
//   挂闸点（见各 handler 入口）：换一批 / 重生(单题·下游·全部) / 换数字·换场景·答疑 / 答疑 /
//     重新验算 / 开始举一反三 / 改年级触发的整组重出（hard_anchor，仍重出耗 token）/
//     变式配图·重新配图·图片重生（compose-figure，调中转造图耗 token）。
//   不挂闸（非耗 token / 本地动作）：入库 / 加篮 / 编辑 / 手动排版 / 撤销重生 / DNA meta 改 / 折叠展开 /
//     🔴 BUG-01 改主考点（now soft_regen：只标待重生不立即重出 → 改时零 token，重生在「重生」按钮自带闸）。
// ---------------------------------------------------------------------------
async function confirmTokenSpend(
  detail = '此操作将调用 AI 生成、消耗 token。',
): Promise<boolean> {
  try {
    await ElMessageBox.confirm(`${detail}确认继续？`, '确认消耗 token', {
      type: 'warning',
      confirmButtonText: '确认继续',
      cancelButtonText: '取消',
      customClass: 'token-confirm-box',
    })
    return true
  } catch {
    return false // 老师取消 → 不触发耗 token 动作
  }
}

/**
 * 思路条终态收口：流中途出错/异常断流时，把【当前轮】还在 running 的条目就地改成 warn
 *（标「已中断」）。历史轮 rail 已冻结不受影响；幂等，可重复调用。
 */
function settleStages() {
  const rail = currentRail.value
  if (!rail) return
  rail.stages = rail.stages.map((s) =>
    // 🔴 PRD-A-018：figure-mother / figure-v* 是宿主独立 POST（母题切图/变式造图）驱动的异步配图灯，
    //   生命周期不绑 SSE 流——crop/compose 常在 SSE 流收口后才完成。SSE 流结束不该把它们误判
    //   「已中断」→ 否则母题切图/配图灯 done→异常(已中断)→done 闪烁（状态条乱跳）。只收 SSE 驱动的阶段灯。
    s.status === 'running' && !s.key.startsWith('figure-')
      ? { ...s, status: 'warn' as const, detail: s.detail ? `${s.detail}·已中断` : '已中断' }
      : s
  )
}

// ---------------------------------------------------------------------------
// 🔴 PRD-C-100 bug-002 单元1 — 进度条补「画图配图」灯（纯 FE 本地灯）。
//   阶段灯走 /variant/stream 的 SSE（onStage），但配图是独立 POST（composeVariantFigure /
//   母题切图）不经 SSE writer → figure 阶段从不发。这里在调配图 POST 时本地往【当前轮 rail】
//   push 一盏「画图配图」灯（running），promise 终态改 done/warn —— 复用 onStage 的「同 key 原地
//   更新、新 key 追加」机制，不另造渲染。
//   🔴 防串台：每张图用独立 key（母题切图 = figure-mother；变式造图 = figure-v<index>），
//     多图并发时各亮各的灯、互不覆盖；落到 onStage 同款 rail.stages，AiStageRail 原样渲染。
// ---------------------------------------------------------------------------

/** 母题切图灯 key */
const FIGURE_STAGE_MOTHER = 'figure-mother'
/** 变式造图灯 key（按 1-based index 区分，防多图并发串台） */
function figureStageKey(index: number): string {
  return `figure-v${index}`
}

/**
 * 往【当前轮 rail】upsert 一盏配图灯（同 onStage:705 机制：同 key 原地更新、新 key 追加）。
 *   - 无当前轮 rail（极少见：手动切图发生在任何对话轮之前）→ 静默不渲染灯，不报错（配图本体照常跑）。
 *   - title 固定「画图配图」；detail 外显具体张/原因，缺省省略。
 */
function upsertFigureStage(
  key: string,
  status: VariantStage['status'],
  detail?: string
) {
  const rail = currentRail.value
  if (!rail) return
  const stage: VariantStage = { key, title: '画图配图', status, detail }
  const idx = rail.stages.findIndex((s) => s.key === key)
  if (idx >= 0) rail.stages[idx] = stage
  else rail.stages.push(stage)
  scrollToBottom()
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
  // 🔴 PRD-A-021 B5：本轮是否「对话开启前的首轮」——预设年级/章只在首轮 classify 时有意义（后续轮
  //   走编辑指令、agent 已锚定）。空态选择器对话开始后即隐藏，故以「push 前 stream 为空」判首轮。
  const isFirstTurn = stream.value.length === 0
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
      // 🔴 思考过程开关：开 → BE 路由 aigeek + 开 extended-thinking，reasoning 流式外显（付费）。
      thinkingStream: thinkingStream.value,
      // 🔴 PRD-A-021 B5：仅首轮 + 老师选了才透传预设年级/章（任一非空即生效）；没选则两键皆 undefined →
      //   streamVariant 不塞进 agent_config，维持现有 classify 路径（核心红线：不选时行为与现状完全一致）。
      //   章 id 优先（更精确，4/7/完整位 toolkit 自解）；只选到年级册时回退年级册 id 作 preset_chapter_id。
      presetGradeBook: isFirstTurn ? presetGradeBookName.value || undefined : undefined,
      presetChapterId: isFirstTurn
        ? presetChapterId.value || presetGradeBookId.value || undefined
        : undefined,
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
        // 🔴 PRD-A-018 G10-5：记下「最后一轮有内容的 rail」快照——编辑/结构化指令轮不发阶段帧时
        //   回落显示它，避免进度条被收成「待机·0/2」（题组明明在场）。
        lastRailStages.value = rail.stages.map((s) => ({ ...s }))
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
      // 🔴 PRD-A-021 R1b S0：并发锁早退帧 —— 同一会话另一轮正在出题/解析，后端立即回此帧 + [DONE]。
      //   本轮没真跑（不渲染产出/不动思路条），仅提示老师「出题中，请稍候」；忙态由 sending 统管，
      //   紧跟的 [DONE]→onClose 会把本轮 sending 收掉，真正在跑的那轮维持自己的忙态（按钮持续禁用）。
      onProcessing: () => {
        thinking.value = false
        ElMessage.warning('出题中，请稍候')
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
        // 🔴 A-21：技术详情（含端口/服务名）只进 console，给老师人话
        console.error('[variant] 流异常（AI 服务连接，toolkit :8093 ？）:', err)
        thinking.value = false
        sending.value = false
        settleStages()
        stream.value.push({
          type: 'bubble',
          role: 'ai',
          kind: 'error',
          text: 'AI 服务暂时连不上，本次请求没能完成。请稍后重试，或联系管理员。',
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
  // 🔴 PRD-A-018 A-6：上传未完成即拦发送——否则在途图未并入 pendingImages，message 不带图，
  //   首轮无图触发 ask→END 静默丢图（老师以为带图了）。📎/🔗 已带闸，唯主发送/回车漏。
  if (uploading.value) {
    ElMessage.warning('图片上传中，请稍候')
    return
  }
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

/** 卡片快捷键（换数字/换场景/答疑，需要 LLM）：预设句走 chat 通道，用户气泡照常显示（铁律 1）。
 *  🔴 AC-TOKEN：这些动作均调 AI 生成 → 先过确认闸（老师知情同意才烧 token）。 */
async function sendUtterance(text: string) {
  if (sending.value) return
  if (!(await confirmTokenSpend())) return
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
 * 🔴 PRD-A-018 A-4：老师取消年级章确认面（点取消 / X / ESC / 遮罩）→ 收口待确认态 + 给回路，
 *   绝不能取消=死路。原先弹窗只 emit false、宿主无 @cancel → BE 停 awaiting_mother_confirm、
 *   FE 无母题卡/无重试、状态条永久「需人工」。
 *   回路：① 清待确认载荷（confirmDialogVisible 已由 v-model 收掉）；② push 一条 AI 提示，告诉
 *   老师可「重新贴图」或「直接回复年级章」继续——needConfirmPayload 留存的话保留以便重开，但本轮
 *   BE 已 END（needConfirm = clarify→END 后停等），故清掉旧载荷避免下次误用陈旧候选。
 */
function onCancelGradeChapter() {
  // 已确认/已在发送中 → 不当作取消（避免确认成功后 v-model 关窗误触）
  if (confirmSubmitting.value || sending.value) return
  // 没有待确认载荷（非真处于确认态）→ 不打扰
  if (!needConfirmPayload.value) return
  needConfirmPayload.value = null
  confirmDialogVisible.value = false
  stream.value.push({
    type: 'bubble',
    role: 'ai',
    kind: 'normal',
    text: '母题确认已暂停。你可以重新贴一张题目图，或直接在下方输入框回复母题所属的「年级册 + 章」（如「七年级上 第二章」），我会据此继续举一反三。',
  })
  scrollToBottom()
}

/**
 * 🔴 PRD-C-017 B5：母题卡「开始举一反三」（母题硬停 resume）。
 * 母题卡出来后 toolkit 停在 awaiting_mother_review；老师点此按钮 → 续聊回合经 agent_config
 * 回传 start_variants=true，toolkit 直奔生成变式（不重跑 opus 解题）。生成中按钮 loading 由
 * sending 驱动（dispatch 置 sending=true）。
 */
async function onStartVariants() {
  if (sending.value) return
  // 🔴 AC-TOKEN：开始举一反三 = generate 起跑（耗 token）→ 先过确认闸。
  if (!(await confirmTokenSpend('「开始举一反三」会调用 AI 生成整组变式、消耗 token。'))) return
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
  // 🔴 PRD-A-018 A-5：编辑前捕获旧 stem——保存成功后据此清掉旧验算结果，
  //   否则 BE 已置 tier=manual，但残留的 verifyResult（verifyResultBadge）会压过 manual 徽章，
  //   卡仍显旧「✓通过」=误导（改了答案的题挂旧背书）。
  const prevStem = findItem(payload.index)?.stem
  try {
    const { index, ...patch } = payload
    const a = await editVariantItem(threadId.value, index, patch)
    if (a) artifact.value = a
    // 🔴 A-5：清旧验算结果（让 tier=manual「✎ 手动编辑·验算待重跑」徽章不被旧 ✓ 压过）
    clearVerifyResultByStem(prevStem)
    ElMessage.success('已保存修改（验算待重跑，可点「重新验算」）')
  } catch (e) {
    ElMessage.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

/** 单题重新验算：跑闸B（LLM+sympy，几秒），徽章变真实验算结果。loading 落本题。 */
async function onReverify(index: number) {
  if (sending.value || reverifyingIndex.value !== null) return
  // 🔴 AC-TOKEN：重新验算触发 LLM 重解（耗 token）→ 先过确认闸。
  if (!(await confirmTokenSpend('「重新验算」会调用 AI 重新解题验算、消耗 token。'))) return
  reverifyingIndex.value = index
  // 🔴 PRD-A-018 A-5：重验前捕获旧 stem——重验后 BE 重新置 tier，旧的手动 verifyResult 须清，
  //   否则新的程序验算结果被旧徽章压过白点（看不到重验的真结果）。
  const prevStem = findItem(index)?.stem
  try {
    const a = await reverifyVariantItem(threadId.value, index)
    if (a) artifact.value = a
    // 🔴 A-5：清旧验算结果，让重验后的真实 tier 徽章生效
    clearVerifyResultByStem(prevStem)
  } catch (e) {
    ElMessage.error(`重新验算失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    reverifyingIndex.value = null
  }
}

// ---------------------------------------------------------------------------
// 🔴 BUG-09 配合 — 手动验算（生成后不自动验算，老师主动点「验算」/「全部验算」）。
//   调 verifyVariantOne({stem, answer}) → 用 verdict/detail/computed 更新该卡徽章 + 证据面板。
//   🔴 验算耗 token，但点按钮即老师主动触发=已同意，不再弹确认框（按钮本身就是同意动作）。
// ---------------------------------------------------------------------------

/** 取某 1-based index 的题（从当前 artifact，用于拿 stem/answer 发 verify-one）。 */
function itemByIndex(index: number): VariantArtifactItem | undefined {
  return artifact.value?.items.find((i) => i.index === index)
}

/** 单题「验算」：调 verify-one，回填 verifyResults[index]（徽章 + 证据更新）。 */
async function onVerifyOne(index: number) {
  if (sending.value || verifyingIndex.value !== null) return
  const it = itemByIndex(index)
  if (!it) return
  verifyingIndex.value = index
  try {
    const res = await verifyVariantOne(it.stem || '', it.answer || '')
    // 🔴 A-3：按 stem 持有（防 index 复用串台）
    verifyResults[it.stem || ''] = { verdict: res.verdict, detail: res.detail, computed: res.computed }
  } catch (e) {
    ElMessage.error(`验算失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    verifyingIndex.value = null
  }
}

/** 「全部验算」：遍历所有待验算（pending 且无结果）卡，逐个调 verify-one。 */
async function onVerifyAll() {
  if (sending.value || verifyingIndex.value !== null) return
  const pending = (artifact.value?.items ?? [])
    // 🔴 A-3：按 stem 判「是否已有结果」（与持有键一致）
    .filter((i) => i.verifyStatus === 'pending' && !verifyResults[i.stem || ''])
    .map((i) => i.index)
  for (const idx of pending) {
    const it = itemByIndex(idx)
    if (!it) continue
    verifyingIndex.value = idx
    try {
      const res = await verifyVariantOne(it.stem || '', it.answer || '')
      // 🔴 A-3：按 stem 持有（防 index 复用串台）
      verifyResults[it.stem || ''] = { verdict: res.verdict, detail: res.detail, computed: res.computed }
    } catch (e) {
      ElMessage.error(`第 ${idx} 题验算失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  verifyingIndex.value = null
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
  // 🔴 PRD-A-018 A-3：改 DNA（考点/题型/难度等）→ 该题被标待重生、特征已变，旧验算结果失效，
  //   清掉防其串到后续重生题。
  const prevStem = findItem(payload.index)?.stem
  try {
    const a = await editVariantDna(threadId.value, payload.index, payload.field, payload.value)
    if (a) artifact.value = a
    clearVerifyResultByStem(prevStem)
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
  // 🔴 AC-TOKEN：重生（单题 / 下游变式 / 全部待重生）= 调 AI 重出（耗 token）→ 先过确认闸。
  //   覆盖单题「重生这道」(onRegenOne)、母题守恒维改后的「重生下游变式」/「重生 N 题」(onRegenAll)、
  //   DNA 改触发的 soft_regen / hard_anchor 重出（均汇流到此）。在 confirmRegenIfManual 覆盖警告之前先征同意。
  if (!(await confirmTokenSpend('「重生」会调用 AI 重新出题、消耗 token。'))) return
  // loading 目标：指定 indexes，否则取当前 header.regen_pending（含母题脏波及）
  const targets =
    indexes && indexes.length ? indexes : (artifact.value?.header.regenPending ?? [])
  // 🔴 BC3 (c) 定稿态：手改/手动排版题重生前二次确认 + 清脏 block（取消则不重生）
  if (!(await confirmRegenIfManual(targets))) return
  regeneratingIndexes.value = targets.length ? [...targets] : [-1] // -1 占位让按钮转圈
  // 🔴 PRD-A-018 A-3：重生前捕获被重生题的旧 stem——重生后题面变了（新 stem），旧验算结果须作废，
  //   否则旧「✓通过」会因 index/seq 复用串到重生后的新题上（假徽章）。
  const regenStems = (artifact.value?.items ?? [])
    .filter((it) => targets.includes(it.index))
    .map((it) => it.stem)
  // 🔴 PRD-A-018 G10-3：记下重生前有配图的 target——重生改了题面，旧图作废(防串台)后，
  //   带图变式不该图静默消失。重生后给它标「待补图」(needs)，卡显「⚠待补图·重新配图」按钮，
  //   老师一眼知道图要重配（不 auto 重配=不偷烧 token；配图入 graph 治本在 A-020）。
  const regenHadFigure = new Set(
    (artifact.value?.items ?? [])
      .filter((it) => targets.includes(it.index) && variantFigures[it.index]?.png)
      .map((it) => it.index)
  )
  try {
    const res = await regenVariant(threadId.value, indexes)
    if (res.artifact) {
      // runRegen 走结构化端点直设 artifact、不经 SSE onArtifact → 须显式作废旧图(与 SSE 路径一致防串台)
      invalidateStaleFigures(res.artifact)
      artifact.value = res.artifact
      // 重生前有图、现作废了 → 标待补图(不静默消失)
      for (const idx of regenHadFigure) {
        if (!variantFigures[idx]?.png) {
          variantFigures[idx] = { png: null, loading: false, needs: true, reason: null, ossUrl: null }
        }
      }
    }
    // 🔴 A-3：清掉被重生题的旧验算结果（新题 stem 不同，旧结果不该再展示）
    for (const s of regenStems) clearVerifyResultByStem(s)
    if (res.failed.length) {
      const ns = res.failed.map((f) => f.index).join('、')
      ElMessage.warning(`第 ${ns} 题重生未成功（已保留原题，可再试或撤销）`)
    } else if (res.regenerated.length) {
      ElMessage.success(`已重生第 ${res.regenerated.join('、')} 题（已重新验算）`)
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
  // 🔴 PRD-A-018 A-3：撤销重生 = 题面回退到上一版（stem 又变），当前版的验算结果须作废，
  //   防旧结果串到回退后的题上。
  const prevStem = findItem(index)?.stem
  try {
    const a = await undoRegenVariant(threadId.value, index)
    if (a) artifact.value = a
    clearVerifyResultByStem(prevStem)
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
    // 🔴 BUG-01：改主考点专属提示（不会清 items / 整组重出，仅标待重生，可撤销）。
    if (payload.field === 'main_kp') {
      ElMessage.success('已更新主考点（变式未清空、已标「待重生」；点「重生」按新考点重出，或「撤销改考点」回退）')
    } else {
      ElMessage.success('已更新母题考点（下游变式已标待重生，点「重生下游变式」按新基准重出）')
    }
  } catch (e) {
    ElMessage.error(`更新母题考点失败：${e instanceof Error ? e.message : String(e)}`)
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
 * 🔴 BUG-01（2026-06-19）改主考点 —— 新行为：走 edit-dna(index=1, field=main_kp) 落 mother_dna，
 * BE【不再】清 items / 回母题确认态 / 整组重锚重出（旧行为静默烧 token）。改为：只更新主考点 +
 * items 全保留 + 被影响变式标 dna_dirty + 母题 dirty + 帧顶层带 main_kp_prev（旧考点快照）+ 一条
 * 引导 AIMessage。老师据新考点重出 = 显式点母题卡「重生下游变式」（既有 regen_pending 通路）。
 *
 * 故此处不再：弹「整组重出不可回退」token 闸 / resetFigureCachesForNewGroup（清配图）/ chat 重出
 * dispatch。改为零 LLM 直连 edit-dna（与改副考点等守恒维一致），返回的 artifact 整量替换即生效；
 * 重生在老师显式点「重生」时才走（runRegen 自带 token 闸）。复用既有 onEditMotherDna 通路。
 */
function onEditHeaderKp(kp: { id: string; name: string }) {
  if (sending.value) return
  void onEditMotherDna({ field: 'main_kp', value: { id: kp.id, name: kp.name } })
}
async function onEditHeaderGrade(grade: string) {
  if (sending.value || !grade) return
  // 🔴 AC-TOKEN：改年级 = 整组重出（耗 token）→ 先过确认闸。
  if (!(await confirmTokenSpend('改年级会按新年级重新生成整组变式、消耗 token。'))) return
  // 🔴 修1/修2：改年级 = 整组重出，同上复位配图缓存 + 首图 guard。
  resetFigureCachesForNewGroup()
  // 🔴 PRD-A-018 A-3：改年级 = 整组重出 → 清验算结果（防旧徽章串到新出的整组变式）
  clearAllVerifyResults()
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
  autoComposedIndexes.clear()
}

/** 换一批：重发初始出题 utterance（整组重新出，agent 重新分析母题）。
 *  🔴 AC-TOKEN：整组重出 = 调 AI 生成（耗 token）→ 先过确认闸。 */
async function regenerate() {
  if (sending.value || !firstComposeMessage) return
  if (!(await confirmTokenSpend('「换一批」会调用 AI 重新生成整组变式、消耗 token。'))) return
  // PRD-C-011 line 102 方案 b =「清空当前卡 + 重发初始出题 utterance」：先清画布，
  // 骨架卡接管重出期（约数十秒），避免老师把滞留的旧卡当成结果抄题
  artifact.value = null
  // 🔴 修1/修2：换一批 = 新的一组 → 清旧配图缓存 + 复位首图 guard（防旧图串到新题、首张图重新直出）。
  resetFigureCachesForNewGroup()
  // 🔴 PRD-A-018 A-3：换一批 = 整组重出 → 清验算结果（防旧「✓通过」盖到新题=串台假徽章）
  clearAllVerifyResults()
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
  // PRD-C-100 B6：带图态随会话重置（单元3：清母题多图数组，motherFigurePng 为派生 computed 随之归零）
  motherFigures.value = []
  motherFigureLoading.value = false
  motherFigureNeeds.value = false
  motherFigureReason.value = null
  for (const k of Object.keys(variantFigures)) delete variantFigures[Number(k)]
  // 🔴 修1/修2：stem 作废表 + 自动造图集合随会话重置（新会话/切会话从零开始首轮配图全量重出）
  for (const k of Object.keys(figureStemAtIndex)) delete figureStemAtIndex[Number(k)]
  autoCropMotherDone = false
  autoComposedIndexes.clear()
  // 🔴 PRD-A-018 A-3：验算结果随会话重置（切会话/新会话从零开始，旧徽章不串到新会话）
  clearAllVerifyResults()
}

/** 新会话（原「新母题」）：换新 thread；首条消息发出时才登记进会话列表 */
function resetSession() {
  clearCanvas()
  threadId.value = genUUID()
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
      if (m.type === 'human') {
        // 🔴 PRD-A-018 bug#1（2026-06-20）：human 分支**先于** humanIdx++ 不能被「空文本 continue」截断——
        //   纯图人类消息（文本为图链/或注册表带图）若先 `if(!text) continue` 跳过，会①漏 humanIdx++ 致后续
        //   人类气泡读错注册表下标（图错位）、②整条纯图气泡（含图）被丢 → 恢复后空白，老师以为「点了没反应」。
        //   故：human 一律先取图 + 推进 humanIdx，再判要不要出气泡（文本空但有图照常出）。
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
        if (!shownText && !imgs.length) continue // 真·空消息（无文字也无图）才跳过
        stream.value.push({
          type: 'bubble',
          role: 'user',
          text: shownText,
          images: imgs.length ? imgs : undefined,
        })
      } else if (m.type === 'ai') {
        if (!text) continue // AI 空内容帧跳过
        stream.value.push({ type: 'bubble', role: 'ai', kind: 'normal', text })
      }
      // tool/custom 帧不回放（stage 思路条是过程态，历史会话无需重演）
    }
    if (art) {
      artifact.value = art
      // 🔴 PRD-A-018 bug#2（2026-06-20）：从 artifact 的 figure_url 重建变式配图显示态——配图原仅存
      //   FE 内存 base64（variantFigures[idx].png），切 tab/恢复会话 clearCanvas 后清空且从不重建，
      //   致已入库变式配图全消失（状态条也回落「无需配图」）。已入库的图 BE 透传了持久 url，这里回填
      //   variantFigures[idx].ossUrl，VariantCard 无 base64 时回退显 ossUrl → 切 tab 不再丢图。
      for (const it of art.items) {
        if (it.figureUrl) {
          variantFigures[it.index] = {
            png: null,
            loading: false,
            needs: false,
            reason: null,
            ossUrl: it.figureUrl,
          }
        }
      }
      // 🔴 PRD-A-018 A-22：恢复历史会话后重建母题 FE 态——否则已入库母题显「未入库」（可重复入库）、
      //   锚定章退化成 id/代码、「手动排版」入口失效。从 artifact 母题卡回填：
      //   ① 年级册/章人话名（chip 显「七年级上 / 第二章」而非代码 / 未定）；
      //   ② 母题入库态（motherPersisted/motherQuestionId，BE 透传 mother_question_id 时生效）。
      const restoredMc = pickMotherCard(art)
      if (restoredMc) {
        if (!confirmedGradeBookName.value && restoredMc.anchorGrade) {
          confirmedGradeBookName.value = restoredMc.anchorGrade
        }
        if (!confirmedChapterName.value && restoredMc.anchorChapterName) {
          confirmedChapterName.value = restoredMc.anchorChapterName
        }
        if (restoredMc.persisted && restoredMc.motherQuestionId) {
          motherPersisted.value = true
          motherQuestionId.value = restoredMc.motherQuestionId
        }
      }
    }
    const meta = sessions.value.find((s) => s.id === id)
    if (meta?.img && !motherImg.value) motherImg.value = meta.img
    // 🔴 2026-06-21（用户终审「配图刷新也消失」）：母题切图（右栏「图形」）按需切、不随会话持久化，
    //   恢复时若不重切则母题卡回来了但「图形」区空白。这里补一次自动切图（与 maybeAutoFirstFigures
    //   的母题切图分支同条件/同去重）。变式配图已由上方 figure_url 回填 ossUrl，不在此重造。
    //   纯文本母题（无图形区）crop 自返 needs_figure，无害。
    if (!autoCropMotherDone && motherImg.value && !motherFigurePng.value && !motherFigureLoading.value) {
      autoCropMotherDone = true
      void onCropMotherFigure()
    }
  } catch (e) {
    console.warn('[variant] 历史会话恢复失败（举一反三服务 :8093 未启动？）:', e)
    ElMessage.warning('历史会话暂时拉取不到，已为你开一个新会话。稍后可重试，或联系管理员。')
    threadId.value = genUUID()
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

// ── 改点②：双栏比例可拖拽（纯前端样式态，不碰数据流）──
// 左栏宽 px，clamp 320~620，localStorage 持久；中间 .variant-splitter 竖向 handle 拖动改它。
const CHAT_W_KEY = 'variant-chat-w'
const CHAT_W_MIN = 320
const CHAT_W_MAX = 620
const chatW = ref(
  (() => {
    try {
      const v = Number(localStorage.getItem(CHAT_W_KEY))
      if (v && v >= CHAT_W_MIN && v <= CHAT_W_MAX) return v
    } catch {
      /* ignore */
    }
    return 440
  })(),
)
let dragStartX = 0
let dragStartW = 440
function onSplitterMove(e: MouseEvent) {
  const next = dragStartW + (e.clientX - dragStartX)
  chatW.value = Math.min(CHAT_W_MAX, Math.max(CHAT_W_MIN, next))
}
function onSplitterUp() {
  document.removeEventListener('mousemove', onSplitterMove)
  document.removeEventListener('mouseup', onSplitterUp)
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
  try {
    localStorage.setItem(CHAT_W_KEY, String(chatW.value))
  } catch {
    /* ignore */
  }
}
function onSplitterDown(e: MouseEvent) {
  dragStartX = e.clientX
  dragStartW = chatW.value
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'col-resize'
  document.addEventListener('mousemove', onSplitterMove)
  document.addEventListener('mouseup', onSplitterUp)
}

onBeforeUnmount(() => {
  handle?.abort()
  document.removeEventListener('paste', onPaste)
  document.removeEventListener('mousemove', onSplitterMove)
  document.removeEventListener('mouseup', onSplitterUp)
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
      @cancel="onCancelGradeChapter"
    />

    <!-- 🔴 PRD-C-100 B6·成本相关 UI：今日 AI 额度用尽横幅。
         A-21（PRD-A-018 去黑话）：老师人话兜底 + 后端原文（含已用/上限 ¥）折叠进「技术详情」，
         不把内部原文直接抛在面上。 -->
    <el-alert
      v-if="budgetExceeded"
      class="budget-banner"
      type="warning"
      show-icon
      :closable="true"
      title="今日 AI 额度已用尽"
      @close="budgetExceeded = false"
    >
      <template #default>
        <p class="budget-friendly">今日 AI 调用额度已用完，请明日再试，或联系管理员调整额度。</p>
        <details v-if="budgetMessage" class="budget-detail">
          <summary>技术详情</summary>
          <span>{{ budgetMessage }}</span>
        </details>
      </template>
    </el-alert>

    <!-- 下方双栏：左聊天 / 右变式题组 -->
    <div class="variant-main">
    <!-- 左栏：AI 命题搭子（对话 + 思路条 + 输入） -->
    <section
      class="variant-chat"
      data-testid="variant-chat-panel"
      :style="{ flex: '0 0 ' + chatW + 'px' }"
    >
      <header class="chat-head">
        <span class="head-spark">✦</span>
        <!-- 🔴 验收纠偏：标题+副标题竖叠成块（对齐设计稿 chat-head），避免「AI 命题搭子」在窄栏折行 -->
        <div class="chat-title-block">
          <span class="chat-title">AI 命题搭子</span>
          <span class="chat-sub">举一反三 · 图片变式</span>
        </div>
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
              <!-- 🔴 PRD-A-018 bug#1（2026-06-20）：纯图（无输入文字）会话原来标题落空→渲染成空白行，
                   老师以为「不能点」。① 有母题图则显缩略图（视觉锚，明确可点）；② 标题永不空白
                   （兜底「图片举一反三」），整行可点不变。 -->
              <img
                v-if="s.img"
                :src="s.img"
                class="session-thumb"
                referrerpolicy="no-referrer"
                alt=""
              />
              <span class="session-title">{{ s.title || '图片举一反三' }}</span>
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

      <!-- 🔴 PRD-A-017 验收纠偏（用户「全局统一状态进度不见了」）：状态条 = chat-head 下方
           【常驻顶栏】，始终显示当前阶段（空态待机 → 定题中 → 出题中），不再「开聊就消失」。
           绑当前活跃轮 stages（currentRail，onStage 实时更新）；对话流内不再逐轮各放一条
           （对齐设计稿 design-ref-02/03 = 单条常驻顶栏）。恢复会话时不显（避免闪）。 -->
      <div v-if="!restoring" class="idle-rail-wrap">
        <!-- 🔴 PRD-A-018 C3(A-24)：点开始→首帧的过渡窗口，sending=true 但 currentRail.stages 仍空，
             传 :starting 让状态条显「启动中」而非「待机」（消除「系统在跑却显待机」瞬态矛盾）。 -->
        <PhasedStatusRail :stages="railStages" :starting="sending" :mother-has-img="!!motherImg" />
      </div>

      <div ref="streamRef" class="chat-stream">
        <div v-if="restoring" class="chat-empty">
          <div class="empty-emoji">⏳</div>
          <p class="empty-title">正在恢复上次会话…</p>
        </div>
        <!-- 🔴 PRD-A-017 空态高保真（restyle.html 空态左栏 .empty-chat）：
             几何罗盘插画 .geo（逐行照搬 SVG）+ 标题「拍一道题丢进来，我帮你出 3 道变式」+ 副文。 -->
        <div v-else-if="stream.length === 0" class="empty-chat">
          <svg class="geo" viewBox="0 0 168 148" fill="none" stroke-linecap="round">
            <circle cx="84" cy="72" r="44" stroke="#9FD0CC" stroke-width="1.4" />
            <path d="M30 72H138M84 18V126" stroke="#C7DAD8" stroke-width="1.1" />
            <path d="M44 106L124 38" stroke="#B6A8F2" stroke-width="1.4" />
            <path d="M48 40L120 106" stroke="#7FC6C2" stroke-width="1.4" />
            <circle cx="84" cy="72" r="3" fill="#1E8A8A" />
            <path d="M94 72A10 10 0 0090 63" stroke="#7B6CF0" stroke-width="1.3" />
          </svg>
          <!-- 🔴 PRD-A-018 A-19：空态承诺改诚实——出题是多步（贴图→确认年级章→点开始→出 3 道），
               不暗示「丢图就自动出」。数量承诺（出 3 道）本身正确，保留。 -->
          <h3>拍一道题丢进来，我帮你出 3 道变式</h3>
          <p>贴上母题图 → 确认年级和章节 → 点「开始举一反三」，就会出 3 道考点一致、只换数字情境的变式。</p>
        </div>

        <template v-for="(item, i) in stream" :key="i">
          <!-- 气泡（用户 / AI 叙述 / 错误） -->
          <div
            v-if="item.type === 'bubble'"
            class="msg-row"
            :class="item.role === 'user' ? 'is-user' : 'is-ai'"
          >
            <div
              class="bubble"
              :class="
                item.role === 'ai'
                  ? [`ai-${item.kind}`, bubbleSemantic(item)]
                  : ''
              "
            >
              <!-- 改点③：AI 气泡语义高亮领标（确认请求显「待确认」紫标，完成通知显 ✓ 青标） -->
              <span
                v-if="item.role === 'ai' && bubbleSemantic(item) === 't-confirm'"
                class="bubble-tag tag-confirm"
              >
                ◇ 待确认
              </span>
              <span
                v-else-if="item.role === 'ai' && bubbleSemantic(item) === 't-done'"
                class="bubble-tag tag-done"
              >
                ✓ 已完成
              </span>
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
            <!-- 🔴 PRD-A-017 验收纠偏：状态进度移到 chat-head 下常驻顶栏（绑 currentRail.stages），
                 对话流内不再逐轮重复渲染状态条（避免「全局统一进度」散落多条 + 沉底找不到）。 -->
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
        <!-- 🔴 PRD-A-017 composer 对齐设计稿（restyle.html .cbox/.cbar）：统一一个框 —— 上半=主输入
             textarea，下半=按钮条 [📎 上传图片][🔗 链接] …右对齐… [思考过程开关][发送 ➤]。
             逻辑零改：paste（document 级监听）/ URL 贴图 / 文件上传 / 发送 / 思考开关 五条链路全部保留，
             仅 URL 输入框默认收起、点「🔗 链接」内联展开（showUrlInput，纯 UI 开合）。 -->
        <div class="composer-box" @drop.prevent="onImageDrop" @dragover.prevent>
          <!-- 🔴 PRD-A-021 B5：对话开启前「可选」预设年级/章（省 LLM 钱 + 少一步确认 + 更准）。
               仅空态显示（对话开始即隐藏，锚定已由首轮定）；不选不挡流程，选了首轮透传 agent_config。
               数据源复用 lazyTree（同 biz_subject 树），样式跟空态控件一致、克制。 -->
          <div v-if="stream.length === 0" class="preset-scope">
            <span class="preset-hint">可选：先限定年级 / 章节，更准更省</span>
            <div class="preset-selects">
              <el-select
                v-model="presetGradeBookId"
                size="small"
                filterable
                clearable
                placeholder="年级册（不选也行）"
                class="preset-select"
                :loading="presetTreeLoading"
                :disabled="sending"
                @change="onPresetGradeBookChange"
              >
                <el-option
                  v-for="gb in presetGradeBooks"
                  :key="gb.id"
                  :label="gb.title"
                  :value="String(gb.id)"
                />
              </el-select>
              <el-select
                v-model="presetChapterId"
                size="small"
                filterable
                clearable
                placeholder="章节（可不选）"
                class="preset-select"
                :disabled="sending || !presetGradeBookId"
                no-data-text="该年级册下无章节"
              >
                <el-option
                  v-for="ch in presetChapters"
                  :key="ch.id"
                  :label="ch.title"
                  :value="String(ch.id)"
                />
              </el-select>
            </div>
          </div>
          <!-- P10：待发附件缩略图（可删除），置于主输入上方一行 -->
          <div v-if="pendingImages.length" class="pending-imgs">
            <div v-for="(u, k) in pendingImages" :key="k" class="pending-thumb">
              <img :src="u" referrerpolicy="no-referrer" @click="previewUrl = u" />
              <button type="button" class="pending-del" :disabled="sending" @click="removePending(u)">
                ✕
              </button>
            </div>
          </div>
          <p v-if="uploading" class="uploading-hint">截图上传中…</p>

          <!-- 内联 URL 输入：点「🔗 链接」才出（默认收起，贴近设计稿干净版式） -->
          <el-input
            v-if="showUrlInput"
            v-model="imageUrl"
            size="default"
            class="url-inline"
            placeholder="贴 OSS / 公网图片地址（http…）后回车加入附件"
            :disabled="sending || uploading"
            clearable
            @keyup.enter.prevent="commitUrlInput"
            @blur="commitUrlInput"
          >
            <template #prepend>🔗 图片链接</template>
          </el-input>

          <!-- 主输入：textarea（粘贴截图 / 编辑指令） -->
          <el-input
            v-model="input"
            type="textarea"
            class="composer-textarea"
            :rows="2"
            resize="none"
            placeholder="粘贴截图 / 拖入图片 / 贴图片链接，回车「出3道」，或说编辑指令（删第2 / 难一点 / 可以了）…"
            :disabled="sending"
            @keyup.enter.exact.prevent="send"
          />

          <!-- 隐藏 file input：pickImageFile 触发其 click，选中走 onFilePicked → uploadPastedImage -->
          <input
            ref="fileInput"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            style="display: none"
            @change="onFilePicked"
          />

          <!-- 按钮条 .cbar -->
          <div class="composer-bar">
            <button
              type="button"
              class="inbtn key"
              :disabled="sending || uploading"
              title="选择本地图片上传"
              @click="pickImageFile"
            >
              📎 上传图片
            </button>
            <button
              type="button"
              class="inbtn"
              :class="{ active: showUrlInput }"
              :disabled="sending || uploading"
              title="贴图片链接"
              @click="showUrlInput = !showUrlInput"
            >
              🔗 链接
            </button>

            <!-- 思考过程开关（挪进按钮条，靠右对齐前，功能保留） -->
            <div class="composer-thinking">
              <el-switch
                v-model="thinkingStream"
                size="small"
                :disabled="sending"
                data-testid="thinking-stream-switch"
              />
              <span class="thinking-toggle-label">思考过程</span>
              <el-tooltip
                placement="top"
                content="开启后展示 AI 的思考过程（可折叠），会走支持思考链的通道，稍慢且按思考输出额外计费；关闭则更快更省，不展示思考。"
              >
                <span class="thinking-toggle-hint">ⓘ</span>
              </el-tooltip>
            </div>

            <el-button
              type="primary"
              class="send-btn"
              :loading="sending"
              :disabled="
                uploading || (!input.trim() && !imageUrl.trim() && pendingImages.length === 0)
              "
              @click="send"
            >
              发送 ➤
            </el-button>
          </div>
        </div>
      </footer>
    </section>

    <!-- 改点②：竖向可拖拽分隔条，拖动改左栏宽（纯样式态，小屏隐藏） -->
    <div
      class="variant-splitter"
      title="拖动调整左右栏宽度"
      @mousedown.prevent="onSplitterDown"
    >
      <span class="splitter-grip" />
    </div>

    <!-- 右栏：变式题组画布（artifact 快照帧驱动；动作全部冒泡回左栏 chat 通道） -->
    <ArtifactPanel
      class="variant-artifact"
      :artifact="displayArtifact"
      :sending="sending"
      :busy="busy"
      :can-regenerate="!!firstComposeMessage || !!motherImg"
      :reverifying-index="reverifyingIndex"
      :verifying-index="verifyingIndex"
      :verify-results="verifyResults"
      :persisting-index="persistingIndex"
      :basketing-index="basketingIndex"
      :regenerating-indexes="regeneratingIndexes"
      :variant-figures="variantFigures"
      :anchor-chip="anchorChip"
      :has-pending-upload="pendingImages.length > 0"
      :pending-upload-count="pendingImages.length"
      @utterance="sendUtterance"
      @regenerate="regenerate"
      @persist="persistAll"
      @reorder="onReorder"
      @edit="onEditItem"
      @reverify="onReverify"
      @verify-one="onVerifyOne"
      @verify-all="onVerifyAll"
      @persist-one="onPersistOne"
      @add-to-basket="onAddToBasket"
      @edit-dna="onEditDna"
      @edit-header-kp="onEditHeaderKp"
      @edit-header-grade="onEditHeaderGrade"
      @regen="onRegenOne"
      @undo-regen="onUndoRegen"
      @edit-models="onEditModels"
      @regen-all="onRegenAll"
      @compose-figure="onComposeFigureFromUser"
      @confirm-direction="onConfirmDirection"
      @preview="(u: string) => (previewUrl = u)"
      @manual-layout="onManualLayout"
    >
      <!-- AC7 收窄移位 + AC4 母题卡先出（全 10 维）+ M8 难点空文案 + G12 母题入库
           🔴 PRD-A-017 批2b：折叠态由 ArtifactPanel 合并头 caret 控（作用域插槽 collapsed → MotherCard） -->
      <template #mother-card="{ collapsed }">
        <MotherCard
          :collapsed="collapsed"
          :mother-card="motherCard"
          :confirmed-chapter-name="confirmedChapterName"
          :confirmed-grade-book-name="confirmedGradeBookName"
          :mother-img="motherImg"
          :persisted="motherPersisted"
          :persisting="motherPersisting"
          :mother-dirty="!!artifact?.header.motherDirty"
          :main-kp-prev="artifact?.mainKpPrev ?? null"
          :has-variants="!!artifact?.items.length"
          :regenerating="regeneratingIndexes.length > 0"
          :sending="sending"
          :busy="busy"
          :figure-png="motherFigurePng"
          :figures="motherFigures"
          :figure-loading="motherFigureLoading"
          :figure-needs-figure="motherFigureNeeds"
          :figure-reason="motherFigureReason"
          @persist-mother="onPersistMother"
          @edit-mother-dna="onEditMotherDna"
          @regen-mother="onRegenAll"
          @start-variants="onStartVariants"
          @preview="(u: string) => (previewUrl = u)"
          @crop-figure="onCropMotherFigureFromUser"
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
/* PRD-A-017 换皮：青紫数学理性。颜色一律取 .variant-page 上的 token（variant-theme.css），
   禁硬编码 hex。青 var(--teal)=老师/主操作/可拍板结果；紫 var(--violet)=AI/思路/进行中；
   冷浅底 var(--bg-soft)；纸白 var(--paper)。绿=验算通过 / 琥珀=待审 / 红=错误。 */
/* PRD-C-015 批5·D-merge4：外层改纵向（顶部母题横条 + 下方双栏），双栏在 .variant-main */
.variant-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 600px;
  background: var(--bg-soft); /* 冷浅底 */
  padding: 16px;
  box-sizing: border-box;
}
/* PRD-C-100 B6：额度横幅（双栏上方，占满宽度） */
.budget-banner {
  margin-bottom: 12px;
  flex-shrink: 0;
}
/* A-21：额度横幅老师人话 + 折叠技术详情 */
.budget-friendly {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
}
.budget-detail {
  margin-top: 6px;
  font-size: 12px;
}
.budget-detail > summary {
  cursor: pointer;
  color: #8a6d3b;
  user-select: none;
}
.budget-detail > span {
  display: block;
  margin-top: 4px;
  color: #9a7b4f;
  word-break: break-all;
}
/* 下方双栏容器：左聊天 / 右变式题组（占满母题横条以下剩余高度） */
.variant-main {
  display: flex;
  gap: 22px;
  flex: 1;
  min-height: 0;
}

/* 左命题搭子（宽由 :style chatW 控，clamp 320~620）/ 右变式 flex */
.variant-chat {
  /* flex 由模板 :style 绑定 chatW；这里给布局兜底 */
  flex: 0 0 380px;
  min-width: 320px;
  display: flex;
  flex-direction: column;
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: var(--r);
  overflow: hidden;
}
.variant-artifact {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: var(--r);
}

/* 改点②：竖向可拖拽分隔条 */
.variant-splitter {
  flex: 0 0 6px;
  align-self: stretch;
  margin: 0 -8px; /* 抵消 gap，热区更宽但视觉细 */
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: col-resize;
  position: relative;
  z-index: 2;
}
.variant-splitter .splitter-grip {
  width: 2px;
  height: 38px;
  border-radius: 2px;
  background: var(--line);
  transition: background 0.15s, height 0.15s;
}
.variant-splitter:hover .splitter-grip {
  background: var(--teal);
  height: 56px;
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
    flex: none !important; /* 覆盖 :style 的固定宽，小屏上下堆叠 */
    min-width: 0;
    width: 100%;
    height: 70vh;
  }
  .variant-splitter {
    display: none; /* 小屏隐藏拖拽条 */
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
  border-bottom: 1px solid var(--line-soft);
  flex-shrink: 0;
}
.head-spark {
  color: var(--violet); /* AI 在场 */
  font-size: 15px;
  flex-shrink: 0;
}
/* 🔴 验收纠偏：标题块竖叠（标题在上、副标题在下），整块不收缩、标题不折行 */
.chat-title-block {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex-shrink: 0;
}
.chat-title {
  font-size: 14.5px;
  font-weight: 700;
  color: var(--ink);
  white-space: nowrap;
  letter-spacing: -0.01em;
}
.chat-sub {
  font-size: 11.5px;
  color: var(--faint);
  white-space: nowrap;
}
.sessions-btn {
  margin-left: auto;
}
.reset-btn {
  margin-left: 0;
}

/* 母题图入口（改点③：去母题缩略徽章后，仅余 URL/上传入口）。
   🔴 PRD-A-017：移入底部 composer 后去掉独立 border/底色，融入输入区（贴设计稿 cbar）。 */
.mother-bar {
  display: flex;
  gap: 12px;
  flex-shrink: 0;
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
  border: 1px solid var(--line);
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
  color: var(--violet);
}

/* 🔴 PRD-A-017 空态：chat-head 下方「待机」状态条容器（与 mother-bar 同左右内边距对齐） */
.idle-rail-wrap {
  padding: 12px 18px 0;
  flex-shrink: 0;
}

/* 思考过程开关条 */
.thinking-toggle-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 2px 0;
}
.thinking-toggle-label {
  font-size: 12px;
  color: var(--ink-2);
}
.thinking-toggle-hint {
  font-size: 12px;
  color: var(--faint);
  cursor: help;
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
  color: var(--faint);
}
.empty-emoji {
  font-size: 36px;
}
.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink-2);
  margin: 8px 0 4px;
}
.empty-tip {
  font-size: 12px;
  color: var(--faint);
  max-width: 420px;
  line-height: 1.7;
}

/* 🔴 PRD-A-017 空态高保真（restyle.html 空态左栏 .empty-chat / .geo）：
   居中几何罗盘插画 + 标题副文。 */
.empty-chat {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 20px;
  gap: 6px;
}
.empty-chat .geo {
  width: 168px;
  height: 148px;
  margin-bottom: 8px;
}
.empty-chat h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--ink);
}
.empty-chat p {
  font-size: 12.5px;
  color: var(--faint);
  max-width: 236px;
  line-height: 1.6;
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
  background: var(--teal-50);
  color: var(--ink);
  border: 1px solid var(--teal-line);
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
  background: var(--paper);
  border: 1px solid var(--line);
  color: var(--ink-2);
  border-bottom-left-radius: 4px;
}
.ai-error {
  background: var(--red-50);
  border: 1px solid var(--red-line);
  color: var(--red);
  border-bottom-left-radius: 4px;
}

/* ── 改点③：AI 气泡语义高亮（左边条 + 领标），全 var(--xxx） ── */
/* 普通答疑：朴素灰（沿用 ai-normal，无额外左条） */
.is-ai .bubble.t-confirm {
  background: var(--violet-50);
  border-color: var(--violet-line);
  border-left: 3px solid var(--violet);
}
.is-ai .bubble.t-done {
  background: var(--teal-50);
  border-color: var(--teal-line);
  border-left: 3px solid var(--teal);
}
.is-ai .bubble.t-summary {
  background: var(--paper);
  border-color: var(--teal-line);
  border-left: 3px solid var(--teal);
}
.is-ai .bubble.t-error {
  background: var(--red-50);
  border-color: var(--red-line);
  border-left: 3px solid var(--red);
}
/* 语义领标 */
.bubble-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10.5px;
  font-weight: 700;
  border-radius: 5px;
  padding: 1px 7px;
  margin-bottom: 6px;
}
.bubble-tag.tag-confirm {
  color: var(--violet-700);
  background: #fff;
  border: 1px solid var(--violet-line);
}
.bubble-tag.tag-done {
  color: var(--teal-700);
  background: #fff;
  border: 1px solid var(--teal-line);
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
  border: 1px dashed var(--violet-line);
  border-radius: var(--r-sm);
  background: var(--violet-50);
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
  color: var(--violet);
}
.reasoning-toggle {
  margin-left: auto;
  font-size: 11px;
  color: var(--violet-700);
}
.reasoning-body {
  margin: 0;
  padding: 0 12px 10px;
  max-height: 220px;
  overflow-y: auto;
  font-size: 12px;
  line-height: 1.6;
  color: var(--violet-700);
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
  background: var(--violet); /* AI 在场 */
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
  color: var(--faint);
  margin-left: 4px;
}

.chat-input {
  flex-shrink: 0;
  padding: 12px;
  border-top: 1px solid var(--line-soft);
  background: linear-gradient(0deg, var(--bg-soft), transparent);
}

/* 🔴 PRD-A-021 B5：空态预设年级/章选择器（青紫数学理性，克制·不抢主输入）。 */
.preset-scope {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding-bottom: 8px;
  margin-bottom: 2px;
  border-bottom: 1px dashed var(--line-soft);
}
.preset-hint {
  font-size: 12px;
  color: var(--faint);
  flex: 0 0 auto;
}
.preset-selects {
  display: flex;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
}
.preset-select {
  flex: 1 1 0;
  min-width: 0;
}
/* 🔴 PRD-A-017 统一 composer 框（对齐 restyle.html .cbox） */
.composer-box {
  border: 1px solid var(--line);
  border-radius: 11px;
  background: var(--paper);
  padding: 9px 11px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.composer-box:focus-within {
  border-color: var(--teal-line);
  box-shadow: 0 0 0 3px var(--teal-50);
}
/* 主输入 textarea：去边框，融进 cbox（边框由 .composer-box 提供） */
.composer-textarea :deep(.el-textarea__inner) {
  border: none;
  box-shadow: none;
  padding: 2px 2px;
  font-size: 13px;
  resize: none;
}
.url-inline {
  margin-bottom: 2px;
}
/* 按钮条 .cbar */
.composer-bar {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 1px;
}
/* 描边小按钮 .inbtn */
.inbtn {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 500;
  color: var(--ink-2);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 5px 10px;
  background: var(--paper);
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s;
}
.inbtn:hover:not(:disabled) {
  border-color: var(--teal-line);
}
.inbtn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.inbtn.key {
  border-color: var(--teal-line);
  color: var(--teal-700);
}
.inbtn.active {
  border-color: var(--teal-line);
  background: var(--teal-50);
  color: var(--teal-700);
}
/* 思考开关：在按钮条内，发送按钮前靠右 */
.composer-thinking {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 5px;
}
.send-btn {
  height: 32px;
  padding: 0 18px;
  border-radius: 9px;
  font-weight: 600;
}

/* 会话列表（popover 内容由本组件模板渲染，scoped 样式可达） */
.session-list {
  max-height: 320px;
  overflow-y: auto;
}
.session-empty {
  font-size: 12px;
  color: var(--faint);
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
  background: var(--bg-soft);
}
.session-item.is-active {
  background: var(--violet-50); /* 当前会话 */
  cursor: default;
}
.session-thumb {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  object-fit: cover;
  border-radius: 5px;
  border: 1px solid var(--line);
  background: var(--bg-soft);
}
.session-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-time {
  font-size: 11px;
  color: var(--faint);
  flex-shrink: 0;
}
.session-del {
  padding: 2px 4px;
  color: var(--faint);
}
.session-del:hover {
  color: var(--red);
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

<!-- 🔴 AC-TOKEN 确认闸样式（非 scoped）：ElMessageBox teleport 到 body，取不到 .variant-page 上的
     token 变量，故此处用 DESIGN.md 青紫冷浅 hex 直写，仅命中 .token-confirm-box 不污染其它弹窗。 -->
<style>
.token-confirm-box {
  border-radius: 14px;
}
.token-confirm-box .el-message-box__title {
  color: #176e6e; /* teal-700 老师拍板色 */
  font-weight: 700;
}
.token-confirm-box .el-message-box__content {
  color: #3c5654; /* ink-2 */
}
.token-confirm-box .el-message-box__btns .el-button--primary {
  --el-button-bg-color: #1e8a8a; /* teal 主操作 */
  --el-button-border-color: #1e8a8a;
  --el-button-hover-bg-color: #176e6e;
  --el-button-hover-border-color: #176e6e;
  --el-button-active-bg-color: #176e6e;
  --el-button-active-border-color: #176e6e;
}
</style>
