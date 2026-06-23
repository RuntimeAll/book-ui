<script setup lang="ts">
// ---------------------------------------------------------------------------
// PRD-C-011 Bucket3 — 右栏「变式题组」画布（DESIGN.md §14.4）。
//
// 数据源 = artifact 快照帧（snapshot 全量，宿主整量替换后传入）；本组件纯展示 +
// 把所有动作冒泡成事件，由宿主处理。
//   - 全部入库 → emit('persist')（2026-06-11 用户拍板：确定性动作直连 BE
//     /variant/persist，不再绕 LLM 分类器；宿主直调接口 + 回执进对话）
//   - 换一批   → emit('regenerate')（宿主重发初始出题 utterance，PRD 开放问题方案 b）
//   - 卡片快捷键（换数字/换场景/答疑，需要 LLM 生成）仍走 utterance → chat SSE（铁律 1）
// 旧后端（无 artifact 帧）→ 空态引导，左栏完全可用（向后兼容兜底）。
// ---------------------------------------------------------------------------
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import Sortable from 'sortablejs'
import type { VariantArtifact, VariantArtifactItem } from '@/api/variant'
import VariantCard from './VariantCard.vue'

// 🔴 PRD-C-100 B6：单卡配图态（按题 index 1-based）。宿主 variantFigures 透传，缺省 = 未配图。
interface VariantFigureState {
  png: string | null
  /** 🔴 PRD-A-018 bug#2：已入库配图的持久 OSS url（恢复会话/切 tab 时回填，无 base64 时回退显示） */
  ossUrl?: string | null
  loading: boolean
  needs: boolean
  reason: string | null
  /** 🔴 配图主动引导：BE 标 needUserDesc → ⚠待补图区提示「补一句图形描述」并引到修正框 */
  needUserDesc?: boolean
  /** 🔴 方向待确认：含方向元素（旋转/箭头/镜像/平移）→ 配图下方「⚠ 方向待确认」徽章 */
  directionReview?: boolean
}

const props = defineProps<{
  artifact: VariantArtifact | null
  /** 发送中：禁用画布级按钮 + 无快照时显示骨架卡 */
  sending: boolean
  /**
   * 🔴 PRD-A-021 R1：全局忙态（sending ∪ 重生/验算/入库/加篮/重验等任一结构化在途）。
   *   仅用于禁用【组级跨切动作按钮】（换一批 / 全部入库 / 重生 N 题 / 全部验算），避免出题/解析/
   *   重生进行中再触发并发写撞后端 per-thread 锁。不驱动骨架（骨架仍看 sending）。缺省回退 sending。
   */
  busy?: boolean
  /** 是否已有初始出题 utterance（决定「换一批」可用性） */
  canRegenerate: boolean
  /** 正在重新验算的题 index（1-based）；该卡显示 loading 态 */
  reverifyingIndex?: number | null
  /** 🔴 BUG-09：正在手动「验算」的题 index（1-based）；该卡验算徽章 loading */
  verifyingIndex?: number | null
  /**
   * 🔴 BUG-09 / PRD-A-018 A-3：手动验算结果表，**按题面 stem 持有**（不再按 1-based index）。
   *   原因：换一批/改年级/重生后 index/seq 复用 → 按 index 持有会让旧「✓通过」串到新题（假徽章）。
   *   命中的卡按 verdict 显徽章 + 证据面板；缺省按 item.verifyStatus（pending→灰待验算）。
   */
  verifyResults?: Record<string, { verdict: 'pass' | 'fail' | 'degrade' | null; detail: string | null; computed: string | null }>

  /** PRD-C-014 T1：正在「收录入库」的题 index（1-based）；该卡入库按钮 loading */
  persistingIndex?: number | null
  /** PRD-C-014 T2：正在「加入试题篮」的题 index（1-based）；该卡加篮按钮 loading */
  basketingIndex?: number | null
  /** PRD-C-015 批5：正在重生的题号集合（1-based）；命中的卡 loading + 重生按钮转圈。null/[]=无 */
  regeneratingIndexes?: number[] | null
  /** 🔴 PRD-C-100 B6：单卡配图态（按题 index 1-based）；宿主透传，缺省 = 未配图 */
  variantFigures?: Record<number, VariantFigureState>
  /**
   * 🔴 PRD-A-017 批2b 合并头：年级·章 chip 文案（如「七年级上册 · 第 6 章 图形的初步知识」）。
   *   章名只有母题卡侧（confirmedChapterName）知道，故由宿主 index.vue 算好传入——合并头与
   *   母题卡共用同一真值，避免两份。为空则 chip 不渲染（母题未就绪时）。
   */
  anchorChip?: string | null
  /**
   * 🔴 PRD-A-018 A-8：待发态——左栏已贴图但还没回车发送（pendingImages>0）。此态右栏不应再显
   *   「上传一道题」完整 4 步引导（左右栏矛盾：左边明明图已就位）。父组件传入后，右栏切轻提示
   *   「图已就位，回车即可出题」。
   */
  hasPendingUpload?: boolean
  /** 待发图张数（轻提示文案用） */
  pendingUploadCount?: number
  /**
   * 🔴 PRD-A-021 R5：母题原图 URL（老师上传的图）。解题/打标阶段（sending 且结构化母题卡还没出）
   *   右栏画布显这张原图占位 + 「解题中…」字幕——不再干等空白；待结构化母题卡到达（hasMother）即切走。
   */
  motherImg?: string
}>()

const emit = defineEmits<{
  (e: 'utterance', text: string): void
  (e: 'regenerate'): void
  (e: 'persist'): void
  /** 拖动排序：order = 1-based 全排列（按当前渲染序的 index 序列）；宿主调 reorderVariant */
  (e: 'reorder', order: number[]): void
  /** 内容编辑：宿主调 editVariantItem */
  (e: 'edit', payload: { index: number; stem?: string; answer?: string; solution?: string }): void
  /** 重新验算：宿主调 reverifyVariantItem */
  (e: 'reverify', index: number): void
  /** 🔴 BUG-09：手动验算单题（宿主调 verifyVariantOne） */
  (e: 'verify-one', index: number): void
  /** 🔴 BUG-09：「全部验算」—— 遍历所有待验算卡逐个验算（宿主实现） */
  (e: 'verify-all'): void
  /** PRD-C-014 T1：单题收录入库（宿主调 persistVariantOne） */
  (e: 'persist-one', index: number): void
  /** PRD-C-014 T2：单题加入试题篮（宿主透明入库） */
  (e: 'add-to-basket', index: number): void
  /** PRD-C-014 T3：DNA 列表选编辑（宿主调 editVariantDna） */
  (
    e: 'edit-dna',
    payload: {
      index: number
      // 🔴 PRD-C-017 B5：scene / skeleton 点击直改也走 edit-dna，扩入 field 集
      field:
        | 'main_kp'
        | 'secondary_kps'
        | 'qtype'
        | 'exam_type'
        | 'tags'
        | 'difficulty'
        | 'scene'
        | 'skeleton'
      value: { id: string; name: string } | Array<{ id: string; name: string }> | string | string[] | number
    }
  ): void
  /** PRD-C-014 G13 ⑤：头部主考点可改（组级守恒锚，宿主走 chat 通道重锚定） */
  (e: 'edit-header-kp', value: { id: string; name: string }): void
  /** PRD-C-014 G13 ⑤：头部年级可改 */
  (e: 'edit-header-grade', value: string): void
  /** PRD-C-015 批5：重生本题（宿主调 regenVariant([index])） */
  (e: 'regen', index: number): void
  /** PRD-C-015 批5：撤销本题重生（宿主调 undoRegenVariant） */
  (e: 'undo-regen', index: number): void
  /** PRD-C-015 批5：models 维改（宿主调 editVariantDna(field='models')） */
  (e: 'edit-models', payload: { index: number; value: Array<{ id: string; name: string }> }): void
  /** PRD-C-015 批5：一键重生全待重生集合（宿主调 regenVariant()，indexes 省略） */
  (e: 'regen-all'): void
  /** 🔴 PRD-C-100 B6：单卡配图 / 图片重生（宿主调 composeVariantFigure） */
  (e: 'compose-figure', payload: { index: number; correctionPrompt?: string }): void
  /** 🔴 PRD-A-018：方向待确认——老师确认方向没问题 → 宿主清该题 directionReview */
  (e: 'confirm-direction', index: number): void
  /** 🔴 PRD-C-100 B6：点开看大图（含切图 / 配图 data URL；宿主弹大图遮罩） */
  (e: 'preview', url: string): void
  /** 🔴 PRD-C-100 BC3：已入库变式「手动排版」（宿主标印记 + 跳 A-015 网格编辑器） */
  (e: 'manual-layout', index: number): void
}>()

// ---------------------------------------------------------------------------
// PRD-C-013 P2b 逐题上屏 — 按 seq 原位 merge（不再整组重渲）。
//
// 旧语义（一期）：每帧 = 全量快照，整数组替换 → 任一字段变化触发整列重渲（首题内容稳定
// 后，徽章后到仍会让整列闪/重排）。新语义：
//   ① 维护本地 mergedItems（按到达顺序的 VariantArtifactItem[]），收到新 artifact 帧时对
//      帧内每个 item 按 seq 做 upsert（已存在的 seq 原位替换该卡数据，新 seq 追加），而不是
//      整数组替换 —— 首题内容可见后，徽章后到只更新该卡，不闪烁、不换位。
//   ② item._dropped===true → 触发可见退场过渡（dropping 集合标记 → CSS 收起 → 计时移除）。
//   ③ 定稿帧 / 入库帧 / 会话恢复帧（partial 不为 true）= 权威全量 → 直接 reconcile 成帧内集合
//      （剔除帧里已消失的 seq），不残留增量期的脏卡。
//   ④ 渲染顺序：按 seq 升序（BE 题序），merge upsert 不打乱既有卡位置。
// 守恒：mergedItems 是渲染唯一来源；header/partial/expectedTotal 仍直接读 props.artifact。
// ---------------------------------------------------------------------------
// 🔴 PRD-A-017 批2b 合并头：母题卡折叠态由本组件持有，caret 点击 toggle，经作用域插槽
//   暴露给 #mother-card（宿主 MotherCard :collapsed）。母题就绪（有 anchorChip）才显 caret + chip。
const motherCollapsed = ref(false)
const hasMother = computed(() => !!props.anchorChip)
function toggleMother() {
  motherCollapsed.value = !motherCollapsed.value
}

const mergedItems = ref<VariantArtifactItem[]>([])
const dropping = ref<Set<number>>(new Set())

function reconcileFinal(incoming: VariantArtifactItem[]) {
  // 权威全量帧：直接以帧内集合为准（按 seq 升序），清掉退场标记
  dropping.value = new Set()
  mergedItems.value = [...incoming].sort((a, b) => a.seq - b.seq)
}

function upsertIncremental(incoming: VariantArtifactItem[]) {
  const bySeq = new Map<number, VariantArtifactItem>(
    mergedItems.value.map((i) => [i.seq, i] as [number, VariantArtifactItem])
  )
  // 🔴 退场标记集合就地变更不触发 :class 重算（Vue 不追踪 Set 内部突变）——攒到本次
  //   merge 末尾整体重建引用，确保 dropping.has(seq) 的 :class 绑定重新求值、退场动画起播。
  const nextDropping = new Set(dropping.value)
  for (const it of incoming) {
    if (it._dropped) {
      // 剔除题：标记退场过渡，由 scheduleDropRemoval 计时移除（与 CSS 过渡时长对齐）。
      // 幂等：同一 _dropped 哨兵每帧重发（BE 累计帧会带）→ 已在退场中的 seq 不重复排计时。
      if (bySeq.has(it.seq) && !nextDropping.has(it.seq)) {
        nextDropping.add(it.seq)
        bySeq.set(it.seq, { ...bySeq.get(it.seq)!, _dropped: true })
        scheduleDropRemoval(it.seq)
      }
      continue
    }
    bySeq.set(it.seq, it) // upsert：新 seq 追加 / 已存在原位替换
    nextDropping.delete(it.seq)
  }
  dropping.value = nextDropping // 重建引用 → :class 重算
  mergedItems.value = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

// 退场兜底计时（CSS transitionend 不触发时也保证移除），与 .card-leave 过渡时长对齐
function scheduleDropRemoval(seq: number) {
  window.setTimeout(() => {
    mergedItems.value = mergedItems.value.filter((i) => i.seq !== seq)
    // 重建引用（同 upsertIncremental）：就地 delete 不触发依赖 dropping 的 computed/:class
    const next = new Set(dropping.value)
    next.delete(seq)
    dropping.value = next
  }, 320)
}

watch(
  () => props.artifact,
  (a) => {
    if (!a) {
      mergedItems.value = []
      dropping.value = new Set()
      return
    }
    if (a.partial === true) upsertIncremental(a.items)
    else reconcileFinal(a.items)
  },
  { immediate: true, deep: true }
)

const items = computed(() => mergedItems.value)
const allPersisted = computed(
  () => items.value.length > 0 && items.value.every((i) => i.persisted)
)

// 🔴 PRD-A-017 polish Fix-A：有没有变式（含增量上屏期占位）。母题就绪但还没出变式时（母题态）=false，
//   此态画布头只显「变式 母题就绪」干净标题，不显 ⟶N道变式 / 换一批 / 全部入库 / 重生N题
//   （设计稿 design-ref-02：母题态画布头无变式组控件，「0 道变式」很尴尬）。出变式后（变式态）=true，
//   恢复合并头全貌（caret + chip + ⟶ N 道变式 + 换一批 + 全部入库）。
const hasVariants = computed(() => items.value.length > 0 || pendingCount.value > 0)

// 🔴 PRD-A-017 空态高保真：纯空态 = 无题卡、无占位、非发送中、母题未就绪。
//   此态下 ① 画布头去掉「换一批 / 全部入库 / 重生」按钮（设计稿空态画布头只剩「变式」标题）；
//   ② 画布体渲染设计稿 hero 三叠卡 + 4 步 stepper + recipe-note 引导（restyle.html 空态右栏）。
const isPureEmpty = computed(
  () =>
    items.value.length === 0 &&
    pendingCount.value === 0 &&
    !props.sending &&
    !hasMother.value &&
    // 🔴 PRD-A-018 A-8：待发态（左栏已贴图待回车）不算纯空态——不显「上传一道题」完整引导（左右栏矛盾）
    !props.hasPendingUpload
)

// PRD-C-015 批5：待重生集合（致命①入库拦截 + 「重生全部」按钮）。
// 优先读 header.regen_pending（BE 权威）；缺失则从 item.dnaDirty / dirtyDims / motherDirtyDims 兜算。
const regenPendingIndexes = computed<number[]>(() => {
  const fromHeader = props.artifact?.header.regenPending ?? []
  if (fromHeader.length) return fromHeader
  return items.value
    .filter(
      (i) =>
        i.dnaDirty || i.dirtyDims.length > 0 || i.motherDirtyDims.length > 0
    )
    .map((i) => i.index)
})
// 任一题脏 或 母题脏 → 整组入库被拦（与单卡 dirty 禁用同口径，前端先拦给体验）
const hasDirty = computed(
  () => regenPendingIndexes.value.length > 0 || props.artifact?.header.motherDirty === true
)
// 本组仍在增量上屏期 → 传给 VariantCard，使其把「无 tier」解读为验算中过渡态
const checking = computed(() => props.artifact?.partial === true)

// 🔴 PRD-A-021 R1：组级跨切动作的「忙」判据 = busy（宿主算的并集）优先，缺省回退 sending。
//   换一批 / 全部入库 / 重生 N 题 / 全部验算这四个会触发后端写、且彼此/与单题动作并发会撞 per-thread
//   锁的组级按钮统一用它禁用；单题按钮仍各自带 per-index 锁，不受此影响。
const isBusy = computed(() => props.busy ?? props.sending)

// 🔴 BUG-09：待验算题（verify_status==='pending' 且无手动验算结果）→ 「全部验算」按钮可点。
const pendingVerifyIndexes = computed<number[]>(() =>
  items.value
    // 🔴 A-3：按 stem 判「是否已有手动验算结果」（与持有键一致）
    .filter((i) => i.verifyStatus === 'pending' && !props.verifyResults?.[i.stem || ''])
    .map((i) => i.index)
)
const hasVerifying = computed(
  () => props.verifyingIndex !== null && props.verifyingIndex !== undefined
)
function verifyAll() {
  if (isBusy.value || pendingVerifyIndexes.value.length === 0) return
  emit('verify-all')
}

// 🔴 BUG-07 变式数量口径统一：头「⟶ N 道变式」与「N 道」徽章/pendingCount 统一为
//   「存活数」(items.length)，避免剔题后两处打架（头显 2 vs 徽章 3）。若确有题被剔除
//   （定稿后 expectedTotal > 存活数），在头旁注明「（剔除 N 道）」而不是两个数各说各话。
//   - culledCount 仅在【定稿态】(非 partial，增量上屏期占位还在算缺口、不算剔除) 才计；
//     partial 期 expectedTotal>live 是「还没生成完」不是「被剔除」，故此态 culled=0。
const culledCount = computed(() => {
  const a = props.artifact
  if (!a || a.partial === true) return 0
  const total = a.expectedTotal ?? 0
  const live = items.value.length
  return total > live ? total - live : 0
})

// PRD-C-012 P2 渐进渲染：增量帧（partial=true）期间，在已完成题卡后补
// (expectedTotal - items.length) 张「生成中」占位骨架卡。定稿帧无 partial 键 →
// pendingCount 归 0，占位卡消失；expectedTotal 缺失/脏值 → 0（不渲染，绝不为负）。
const pendingCount = computed(() => {
  const a = props.artifact
  if (!a || a.partial !== true) return 0
  const total = a.expectedTotal ?? 0
  // 退场中的卡不占名额（已逻辑剔除），用非退场题数算缺口
  const live = items.value.filter((i) => !dropping.value.has(i.seq)).length
  return total > live ? total - live : 0
})

// ---------------------------------------------------------------------------
// 拖动排序（sortablejs，手柄拖拽，移动端友好）。
//   - 仅在「定稿态」(非 partial、非 sending) 启用；增量上屏期禁用（避免拖到一半被帧重排）。
//   - drop 后按新 DOM 顺序读各卡 data-seq → 映射成「新序对应的原 index 序列」= 1-based
//     全排列；乐观更新本地 mergedItems，调 emit('reorder')，失败由宿主回滚（重发 artifact）。
//   - 已收录(persisted)题也可拖（排序不改收录态）；单题时无意义但不禁用（order=[1] 合法）。
// ---------------------------------------------------------------------------
const listEl = ref<HTMLElement | null>(null)
let sortable: Sortable | null = null

// 可拖拽条件：有题、非发送中、非增量帧期（定稿/恢复才稳定）
const draggable = computed(
  () => items.value.length > 1 && !props.sending && props.artifact?.partial !== true
)

function onDrop() {
  const root = listEl.value
  if (!root) return
  // 读 drop 后的 DOM 顺序：每张卡的 data-seq（= 拖前的 item.seq），映射回当时的 index
  const seqByOrder: number[] = []
  root.querySelectorAll<HTMLElement>('[data-card-seq]').forEach((el) => {
    const s = Number(el.dataset.cardSeq)
    if (Number.isFinite(s)) seqByOrder.push(s)
  })
  const cur = items.value
  // seq → 该题拖前的 1-based index（按拖前 seq 升序 = item.index 顺序）
  const idxBySeq = new Map<number, number>(cur.map((it) => [it.seq, it.index]))
  const order = seqByOrder.map((s) => idxBySeq.get(s)).filter((n): n is number => typeof n === 'number')
  // 校验：长度齐 + 全排列（每个 1..N 恰一次），否则放弃（让 Vue 按既有 items 重渲回原序）
  const n = cur.length
  const valid =
    order.length === n &&
    new Set(order).size === n &&
    order.every((v) => v >= 1 && v <= n)
  if (!valid || order.every((v, i) => v === i + 1)) {
    // 非法或无变化 → 强制按原 items 重渲（撤销 sortable 的 DOM 改动）
    forceRerender()
    return
  }
  // 乐观更新：按新顺序重排本地 items 并重编 index/seq（与 BE _reorder_items 同义：seq 跟新位）
  const reordered = order.map((origIdx, i) => {
    const it = cur.find((c) => c.index === origIdx)!
    return { ...it, index: i + 1, seq: i + 1 }
  })
  mergedItems.value = reordered
  emit('reorder', order)
}

// 撤销 sortable 的就地 DOM 改动：v-for 的 :key 不变时 Vue 不会重排已被 sortable 移动的节点，
// 故清空再 nextTick 重填，强制按 mergedItems 现序重建。
function forceRerender() {
  const snapshot = mergedItems.value
  mergedItems.value = []
  void nextTick(() => {
    mergedItems.value = snapshot
  })
}

function initSortable() {
  if (sortable || !listEl.value) return
  sortable = Sortable.create(listEl.value, {
    handle: '.drag-handle',
    animation: 160,
    ghostClass: 'card-ghost',
    chosenClass: 'card-chosen',
    // 占位卡 / 空态等非题卡不可拖（只认带 data-card-seq 的真实卡）
    draggable: '[data-card-seq]',
    filter: '.pending-card,.skeleton-card',
    onEnd: onDrop,
  })
}

watch(
  draggable,
  (on) => {
    void nextTick(() => {
      if (on) initSortable()
      if (sortable) sortable.option('disabled', !on)
    })
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  sortable?.destroy()
  sortable = null
})

function persistAll() {
  if (isBusy.value || items.value.length === 0 || allPersisted.value) return
  // PRD-C-015 批5 致命①：有脏题 → 前端拦下（后端 persist_to_bank 也会硬拦）
  if (hasDirty.value) {
    const ns = regenPendingIndexes.value.join('、')
    ElMessage.warning(`第 ${ns || '?'} 题改了还没重生，先点「重生待重生集合」或撤销，再全部入库`)
    return
  }
  emit('persist')
}

function regenerate() {
  if (isBusy.value || !props.canRegenerate) return
  emit('regenerate')
}

/** PRD-C-015 批5：一键重生全待重生集合（D-merge8，indexes 省略 = 全集合） */
function regenAll() {
  if (isBusy.value || regenPendingIndexes.value.length === 0) return
  emit('regen-all')
}
</script>

<template>
  <section class="artifact-panel" data-testid="variant-artifact-panel">
    <!-- 🔴 PRD-A-017 批2b 合并头：一条协调头 = [caret 母题卡] [年级·章 chip] [⟶] [举一反三 N 道变式]
         [换一批] [全部入库]。caret 折叠下方母题卡（作用域插槽透传 collapsed）；换一批/全部入库 = 变式组
         动作，留本组件（事件归属不变）。母题未就绪（无 anchorChip）→ 不显 caret/chip/flow，退回原标题。 -->
    <header class="canvas-head" :class="{ 'is-vhead': hasMother }">
      <div class="head-line">
        <!-- 🔴 PRD-A-017 polish Fix-A：合并头分流——
             ① 变式态（母题就绪 + 已出变式）：完整合并头 = caret 母题卡 + chip + ⟶ N 道变式（+ 右侧变式组动作）。
             ② 母题态（母题就绪 + 还没出变式）：只显「变式」标题 + 「母题就绪」青徽章（设计稿 design-ref-02），
                保留 caret + chip 让母题卡可折叠，但去掉「⟶ 0 道变式」尴尬文案与变式组动作（下方按钮区隐藏）。
             ③ 兜底（母题未就绪）：原「变式题组 · N 道」标题。 -->
        <!-- ① 变式态：完整合并头 -->
        <template v-if="hasMother && hasVariants">
          <button
            type="button"
            class="mc-caret"
            :title="motherCollapsed ? '展开母题卡' : '收起母题卡'"
            @click="toggleMother"
          >
            <span class="mc-caret-ic">{{ motherCollapsed ? '▸' : '▾' }}</span> 母题卡
          </button>
          <span class="mc-titlechip" :title="anchorChip || ''">{{ anchorChip }}</span>
          <span class="vh-arrow">⟶</span>
          <span class="vh-flow">
            举一反三 <b>{{ items.length }}</b> 道变式<span
              v-if="culledCount > 0"
              class="vh-culled"
              :title="`原请求 ${items.length + culledCount} 道，有 ${culledCount} 道未通过闸链被剔除`"
            >（剔除 {{ culledCount }} 道）</span>
          </span>
        </template>
        <!-- ② 母题态：「变式」标题 + 「母题就绪」徽章（干净，无变式组控件） + 可折叠 caret/chip -->
        <template v-else-if="hasMother">
          <h2 class="canvas-title">变式</h2>
          <span class="ready-badge">母题就绪</span>
          <button
            type="button"
            class="mc-caret mc-caret-sub"
            :title="motherCollapsed ? '展开母题卡' : '收起母题卡'"
            @click="toggleMother"
          >
            <span class="mc-caret-ic">{{ motherCollapsed ? '▸' : '▾' }}</span> 母题卡
          </button>
          <span class="mc-titlechip" :title="anchorChip || ''">{{ anchorChip }}</span>
        </template>
        <!-- ③ 兜底：母题未就绪 → 原「变式题组 · N 道」标题 -->
        <h2 v-else class="canvas-title">变式<template v-if="items.length">题组 · {{ items.length }} 道<span v-if="culledCount > 0" class="vh-culled">（剔除 {{ culledCount }} 道）</span></template></h2>
        <span class="head-spacer" />
        <!-- 🔴 PRD-A-017 Fix-A：变式组动作（重生 / 换一批 / 全部入库）仅「变式态」(hasVariants) 显；
             空态 / 母题态都收起（设计稿母题态、空态画布头都无变式组控件）。 -->
        <template v-if="hasVariants && !isPureEmpty">
          <!-- PRD-C-015 批5：待重生集合非空 → 「重生 N 题」按钮（D-merge8 一键重出全集合） -->
          <el-button
            v-if="regenPendingIndexes.length > 0"
            size="small"
            class="regen-all-btn"
            :loading="!!(regeneratingIndexes && regeneratingIndexes.length)"
            :disabled="isBusy"
            @click="regenAll"
          >
            🔄 重生 {{ regenPendingIndexes.length }} 题
          </el-button>
          <!-- 🔴 BUG-09：「全部验算」（遍历待验算卡逐个验算；点即触发，已同意不弹框） -->
          <el-button
            v-if="pendingVerifyIndexes.length > 0"
            size="small"
            class="verify-all-btn"
            :loading="hasVerifying"
            :disabled="isBusy"
            title="对所有待验算的变式逐个调用 AI 验算（消耗 token）"
            @click="verifyAll"
          >
            ✓ 全部验算 {{ pendingVerifyIndexes.length }} 题
          </el-button>
          <el-button
            size="small"
            :disabled="isBusy || !canRegenerate"
            @click="regenerate"
          >
            换一批
          </el-button>
          <el-button
            size="small"
            class="persist-btn"
            :disabled="isBusy || items.length === 0 || allPersisted || hasDirty"
            :title="hasDirty ? '有题改了还没重生，先点「重生」或撤销' : ''"
            @click="persistAll"
          >
            {{ allPersisted ? '已全部收录' : '全部入库' }}
          </el-button>
        </template>
      </div>
      <!-- PRD-C-015 批5：母题脏 / 待重生提示条（致命①入库拦截原因外显） -->
      <div v-if="hasDirty" class="dirty-banner">
        <template v-if="artifact?.header.motherDirty">
          母题考点改过，下游变式已标「待重生」——点上方「重生」按新基准重出，重生前不可入库。
        </template>
        <template v-else>
          第 {{ regenPendingIndexes.join('、') }} 题改了还没重生，点「重生」按新特征重出后才能入库。
        </template>
      </div>
      <!-- PRD-A-017 改点④：去掉头部「主考点 / 年级」重复 badge（锚定 chip 由母题卡 MotherCard 承载，
           此处与之重复）。仅保留配方提示（母题卡不含配方信息）。 -->
      <div v-if="artifact && artifact.header.recipe" class="head-badges">
        <span class="recipe-badge">{{ artifact.header.recipe }}</span>
      </div>
    </header>

    <!-- 卡片列 -->
    <div ref="listEl" class="canvas-body">
      <!-- 🔴 PRD-A-023 B5（2026-06-22 二改·方案 A：母题卡悬浮浮层盖在变式之上）：
           母题卡区 = 独立 position:absolute 浮层（定位上下文 = .canvas-body 设 position:relative），
           top/left/right:0 + z-index 高于变式卡 → 浮在变式之上盖住顶部变式，立体阴影显「浮起」。
           变式列在 .canvas-body 内从顶部正常铺、可滚；展开/收起母题卡时变式【不重排不移动】
           （浮层 opacity/transform 过渡浮出/浮回，绝不挤动变式文档流）。收起即露出被盖的顶部变式。
           上一轮 position:sticky（在文档流内吸顶）会把变式推上推下=同级——已废弃改为 absolute overlay。
           布局闸（治「解析超长」）保留：本浮层 max-height 视口比例 + overflow:auto，母题卡再长只在浮层内滚。 -->
      <transition name="mother-float">
        <div v-show="!motherCollapsed" class="mother-slot">
          <slot name="mother-card" :collapsed="motherCollapsed" />
        </div>
      </transition>

      <template v-if="items.length > 0 || pendingCount > 0">
        <!-- P2b：按 seq 原位 merge，剔除题（_dropped）走 is-dropping 退场过渡后由计时移除 -->
        <!-- 题组编辑器：每卡包一层拖拽行（data-card-seq = drop 后读新序的键 + .drag-handle 拖手柄） -->
        <div
          v-for="it in items"
          :key="it.seq"
          class="card-wrap"
          :class="{ 'is-dropping': dropping.has(it.seq) }"
          :data-card-seq="it.seq"
        >
          <button
            v-if="draggable"
            type="button"
            class="drag-handle"
            title="拖动调整题序"
            aria-label="拖动调整题序"
          >
            ⠿
          </button>
          <VariantCard
            class="card-body"
            :item="it"
            :sending="sending"
            :busy="isBusy"
            :checking="checking"
            :reverifying="reverifyingIndex === it.index"
            :verifying="verifyingIndex === it.index"
            :verify-result="verifyResults?.[it.stem || ''] ?? null"
            :persisting="persistingIndex === it.index"
            :basketing="basketingIndex === it.index"
            :regenerating="!!(regeneratingIndexes && regeneratingIndexes.includes(it.index))"
            :figure-png="variantFigures?.[it.index]?.png ?? null"
            :figure-oss-url="variantFigures?.[it.index]?.ossUrl ?? null"
            :figure-loading="!!variantFigures?.[it.index]?.loading"
            :figure-needs-figure="!!variantFigures?.[it.index]?.needs"
            :figure-reason="variantFigures?.[it.index]?.reason ?? null"
            :figure-need-user-desc="!!variantFigures?.[it.index]?.needUserDesc"
            :figure-direction-review="!!variantFigures?.[it.index]?.directionReview"
            @utterance="(t: string) => emit('utterance', t)"
            @edit="(p) => emit('edit', p)"
            @reverify="(i: number) => emit('reverify', i)"
            @verify-one="(i: number) => emit('verify-one', i)"
            @persist-one="(i: number) => emit('persist-one', i)"
            @add-to-basket="(i: number) => emit('add-to-basket', i)"
            @edit-dna="(p) => emit('edit-dna', p)"
            @regen="(i: number) => emit('regen', i)"
            @undo-regen="(i: number) => emit('undo-regen', i)"
            @edit-models="(p) => emit('edit-models', p)"
            @compose-figure="(p) => emit('compose-figure', p)"
            @confirm-direction="(i: number) => emit('confirm-direction', i)"
            @preview="(u: string) => emit('preview', u)"
            @manual-layout="(i: number) => emit('manual-layout', i)"
          />
        </div>
        <!-- PRD-C-012 P2：增量帧期的「生成中」占位卡（题号顺延已完成题，定稿帧到达即消失） -->
        <div
          v-for="n in pendingCount"
          :key="`pending-${items.length + n}`"
          class="pending-card"
          data-testid="variant-pending-card"
        >
          <header class="pending-head">
            <span class="pending-seq">{{ items.length + n }}</span>
            <span class="pending-text">生成中…</span>
          </header>
          <div class="sk-line" />
          <div class="sk-line sk-w70" />
        </div>
      </template>

      <!-- 🔴 PRD-A-018 A-9：读图/定题阶段（连母题/题数都没定，pendingCount=0）不写死 3 张变式骨架
           （误导「已定 3 道」，且与缺陷2「可能 1 道」打架）。改显「读图定题中…」占位——真正的
           变式骨架在进 generate（partial 帧带 expectedTotal → pendingCount>0）后按真实题数渲染。 -->
      <!-- 🔴 PRD-A-021 R5：处理中变式区轻提示。母题原图占位已移进母题卡内（MotherCard 占位态·浮动），
           本处只在「无原图」（旧后端/纯文本）时显文案；有原图时母题卡占位即处理指示，此处不重复。 -->
      <div v-else-if="sending && !motherImg" class="define-loading">
        <span class="dl-dot" />
        读图定题中…
      </div>
      <div v-else-if="sending" class="define-loading">
        <span class="dl-dot" />
        变式稍后在此出现…
      </div>

      <!-- 🔴 PRD-A-017 空态高保真重建（restyle.html 空态右栏）：hero 三叠卡 + 标题副文 +
           4 步 stepper + recipe-note 配方引导。逐元素照搬设计稿，颜色用 token。
           🔴 验收纠偏（张校长「成品页底下还压着欢迎插画=状态没切干净」）：完整引导只在
           纯空态（无母题）显；母题已就绪/出题中则不显这条「上传一道题」引导（走下方轻提示）。 -->
      <div v-else-if="isPureEmpty" class="empty-canvas">
        <svg class="hero-ic" viewBox="0 0 108 92" fill="none">
          <rect x="20" y="14" width="64" height="48" rx="7" fill="#fff" stroke="#CBE2DF" stroke-width="1.4" />
          <rect x="30" y="24" width="64" height="48" rx="7" fill="#F5F8F8" stroke="#CBE2DF" stroke-width="1.4" />
          <rect x="40" y="34" width="64" height="48" rx="7" fill="#fff" stroke="#1E8A8A" stroke-width="1.5" />
          <path d="M50 48h30M50 58h44M50 68h22" stroke="#9FD0CC" stroke-width="2" stroke-linecap="round" />
          <circle cx="96" cy="40" r="9" fill="#E4F4ED" stroke="#1F9D6B" stroke-width="1.4" />
          <path d="M92 40l3 3 5-6" stroke="#1F9D6B" stroke-width="1.6" fill="none" stroke-linecap="round" />
        </svg>
        <!-- 🔴 PRD-A-018 A-19：stepper/副文改诚实——出题是多步交互（贴图→确认年级章→点开始→出 3 道），
             不暗示「贴图就自动出」。数量承诺（出 3 道）本身正确，保留。 -->
        <h2>上传一道题，开始举一反三</h2>
        <p class="sub">
          在左侧贴一张母题图，先确认它的年级和章节，点「开始举一反三」，就会出 3 道考点一致、只换数字情境的变式，逐题验算后可一键入库。
        </p>
        <div class="stepper">
          <div class="node"><div class="nd" /><div class="nl">贴母题图</div></div>
          <div class="seg" />
          <div class="node"><div class="nd" /><div class="nl">确认<br />年级·章节</div></div>
          <div class="seg" />
          <div class="node"><div class="nd" /><div class="nl">点开始<br />出 3 道变式</div></div>
          <div class="seg" />
          <div class="node"><div class="nd" /><div class="nl">验算 · 入库</div></div>
        </div>
        <div class="recipe-note">
          <b>默认出 3 道</b>（2 普通 1 难）<span class="sep">·</span> 守考点 · 换数字 / 情境
          <span class="sep">·</span> 想多出 / 调难度，贴图时说「出 5 道」「难一点」即可
        </div>
      </div>

      <!-- 🔴 PRD-A-018 A-8：待发态（左栏已贴图、还没回车）→ 右栏轻提示「图已就位，回车即可出题」，
           不显「上传一道题」完整引导（左右栏不再矛盾）。 -->
      <div v-else-if="hasPendingUpload && !hasMother" class="variant-await-hint">
        <span class="vah-dot" />
        图已就位<template v-if="(pendingUploadCount ?? 0) > 1">（{{ pendingUploadCount }} 张）</template> · 回车即可开始出题
      </div>

      <!-- 🔴 验收纠偏：母题已就绪但还没出变式 → 轻提示占位（不再压「上传一道题」完整引导） -->
      <div v-else class="variant-await-hint">
        <span class="vah-dot" />
        变式会出现在这里 · 点上方「开始举一反三」生成
      </div>
    </div>
  </section>
</template>

<style scoped>
/* PRD-A-017 换皮：青紫数学理性。颜色一律取 .variant-page 上的 token（variant-theme.css）。
   青 var(--teal)=老师/主操作/可拍板；紫 var(--violet)=AI/进行中；琥珀 var(--amber)=待审/重生。 */
.artifact-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  /* 🔴 BUG-05a 吸顶冻结：作为外层 flex 子项必须能收缩到 0，否则内容把面板撑高、
     整面板（含操作头）随父容器一起滚走。min-height:0 让面板严格吃满给定高度，
     内部 .canvas-body 才真正成为唯一滚动容器、.canvas-head 常驻钉顶。 */
  min-height: 0;
  background: var(--bg-soft);
  border-radius: var(--r);
  overflow: hidden;
}
/* 🔴 验收纠偏：母题就绪待出变式的轻提示（替代「上传一道题」完整引导，避免成品页压欢迎插画） */
.variant-await-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px 20px;
  font-size: 12.5px;
  color: var(--faint);
}
.variant-await-hint .vah-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--violet);
  animation: pulse 1.5s infinite ease-in-out;
}
/* 🔴 PRD-A-018 A-9：读图/定题阶段占位（替代写死 3 张变式骨架），紫系呼吸点 + 文案 */
.define-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px 20px;
  font-size: 12.5px;
  color: var(--violet-700);
}
.define-loading .dl-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--violet);
  animation: pulse 1.5s infinite ease-in-out;
}

.canvas-head {
  flex-shrink: 0;
  /* 🔴 PRD-A-017 批2b sticky：合并头在右栏滚动语境内常驻顶。.artifact-panel 是 flex column +
     overflow:hidden，本头 flex-shrink:0 已天然钉顶（mother-slot/canvas-body 各自内滚）；
     再加 position:sticky 兜底（防未来父容器结构变动把头滚走）。 */
  position: sticky;
  top: 0;
  z-index: 5;
  padding: 14px 20px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-bottom: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.5);
  backdrop-filter: blur(6px);
}
.head-line {
  display: flex;
  align-items: center;
  gap: 9px;
}
.canvas-title {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: var(--ink);
}

/* 🔴 PRD-A-017 polish Fix-A：母题态「母题就绪」徽章（restyle.html .canvas-head .ct，青 pill） */
.ready-badge {
  flex: none;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--teal-700);
  background: var(--teal-50);
  border: 1px solid var(--teal-line);
  border-radius: 6px;
  padding: 1px 8px;
}
/* 母题态的 caret 次级化（标题在前，caret 仅为折叠母题卡的辅助入口） */
.mc-caret-sub {
  margin-left: 4px;
}

/* 🔴 PRD-A-017 批2b 合并头元素（restyle.html .vhead / .mc-caret / .mc-titlechip / .vh-arrow / .vh-flow） */
.mc-caret {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  font-weight: 700;
  color: var(--teal-700);
  background: var(--paper);
  border: 1px solid var(--teal-line);
  border-radius: var(--r-sm);
  padding: 3px 11px;
  cursor: pointer;
}
.mc-caret:hover {
  background: var(--teal-50);
}
.mc-caret-ic {
  font-size: 11px;
}
.mc-titlechip {
  flex: none;
  max-width: 280px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
  font-weight: 600;
  color: var(--teal-700);
}
.vh-arrow {
  flex: none;
  color: var(--teal-line);
  font-size: 15px;
}
.vh-flow {
  flex: none;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--muted);
}
.vh-flow b {
  color: var(--teal-700);
  font-family: var(--mono);
  font-weight: 700;
  font-size: 13.5px;
}
/* 🔴 BUG-07：剔除注记（琥珀，低调，不与存活数抢眼） */
.vh-culled {
  margin-left: 2px;
  font-size: 11.5px;
  color: var(--amber);
}
.head-spacer {
  flex: 1;
}
/* 老师拍板动作 = teal（不是紫）：右栏不出现紫色实心按钮 */
.persist-btn {
  background: var(--teal);
  border-color: var(--teal);
  color: #fff;
}
.persist-btn:hover:not(:disabled) {
  background: var(--teal-700);
  border-color: var(--teal-700);
  color: #fff;
}
.persist-btn:disabled {
  background: var(--teal-100);
  border-color: var(--teal-100);
  color: #fff;
}

/* 🔴 BUG-09：「全部验算」按钮（青系 outline，与卡内「验算」同色语） */
.verify-all-btn {
  color: var(--teal-700);
  border-color: var(--teal-line);
}
.verify-all-btn:hover:not(:disabled) {
  background: var(--teal-50);
  color: var(--teal-700);
  border-color: var(--teal-line);
}

/* PRD-C-015 批5：「重生 N 题」按钮（amber 实心，与卡内重生按钮同色语） */
.regen-all-btn {
  background: var(--amber);
  border-color: var(--amber);
  color: #fff;
}
.regen-all-btn:hover:not(:disabled) {
  background: var(--amber);
  border-color: var(--amber);
  color: #fff;
  filter: brightness(0.92);
}
/* PRD-C-015 批5：母题脏 / 待重生入库拦截提示条 */
.dirty-banner {
  font-size: 12px;
  line-height: 1.6;
  color: var(--amber);
  background: var(--amber-50);
  border: 1px solid var(--amber-line);
  border-radius: var(--r-sm);
  padding: 6px 11px;
}

.head-badges {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.recipe-badge {
  font-size: 12px;
  color: var(--teal-700);
  background: var(--teal-50);
  border: 1px solid var(--teal-line);
  border-radius: var(--r-xs);
  padding: 2px 10px;
}

/* 🔴 PRD-A-023 B5（二改·方案 A）：母题卡 = 悬浮浮层，盖在变式之上。
   position:absolute（定位上下文 = .canvas-body 的 position:relative），top/left/right:0 贴住画布顶部，
   z-index:6 压在变式卡（流内 z-index:auto）之上 → 浮层盖住顶部变式。
   不透明白底（变式滚过浮层下不透视）+ 立体阴影（精密悬浮感，青紫设计语言：紫向轻投影呼应 AI 区，克制不重）。
   保留限高内滚（治解析超长）：浮层 max-height 视口比例 + overflow:auto，母题卡再长只在浮层内滚、不撑爆。
   🔴 关键：absolute 脱离文档流 → 母题卡展开/收起【不占位、不挤动变式】，变式始终从 .canvas-body 顶部铺。 */
.mother-slot {
  /* 🔴 Bug 1（2026-06-23）：原 position:absolute; top:0 相对【会滚动的】.canvas-body 定位 →
     absolute 子项的 top:0 钉的是滚动容器【内容原点】而非视口顶，内容上滚时浮层随内容滑走（消失）。
     改 position:sticky; top:0 → 浮层在 .canvas-body 滚动视口内吸顶，变式在其下滚动、母题卡留视口顶。 */
  position: sticky;
  top: 0;
  left: 0;
  right: 0;
  z-index: 6;
  max-height: 42vh;
  overflow-y: auto;
  /* 浮层底 = 实底白纸（不透视下方变式）+ 双层立体阴影（近实远柔，Linear/Notion 那种精密悬浮） */
  background: var(--paper);
  border-bottom: 1px solid var(--line);
  border-radius: 0 0 var(--r) var(--r);
  box-shadow:
    0 2px 4px -1px rgba(30, 138, 138, 0.08),
    0 10px 24px -8px rgba(123, 108, 240, 0.22);
}

/* 浮层展开/收起过渡（浮出/浮回的「浮动」感，呼应用户「打开收起要有浮动」）。
   absolute 脱流 → 变式不重排；这里只动浮层自身 opacity + 轻位移。 */
.mother-float-enter-active,
.mother-float-leave-active {
  transition:
    opacity 0.24s ease,
    transform 0.24s cubic-bezier(0.32, 0.72, 0, 1);
}
.mother-float-enter-from,
.mother-float-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}

.canvas-body {
  flex: 1;
  /* 🔴 BUG-05a：flex 子项默认 min-height:auto（撑到内容高）→ 不会内滚而是把面板撑高、
     把吸顶头顶走。min-height:0 强制 .canvas-body 在剩余空间内滚动，头才冻结。 */
  min-height: 0;
  overflow-y: auto;
  /* 🔴 PRD-A-023 B5：母题卡浮层（.mother-slot position:absolute）的定位上下文 = 本容器。 */
  position: relative;
  padding: 16px 32px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* 拖拽行：手柄 + 卡片横排（手柄居中、卡片占满剩余宽） */
.card-wrap {
  display: flex;
  align-items: stretch;
  gap: 8px;
}
.card-wrap > .card-body {
  flex: 1;
  min-width: 0;
}
/* 拖手柄：默认低调，hover 转 grab；移动端 touch 可拖 */
.drag-handle {
  flex-shrink: 0;
  align-self: center;
  width: 22px;
  padding: 6px 0;
  border: none;
  background: none;
  color: var(--faint);
  font-size: 15px;
  line-height: 1;
  cursor: grab;
  border-radius: var(--r-xs);
  touch-action: none;
  user-select: none;
}
.drag-handle:hover {
  color: var(--teal);
  background: var(--teal-50);
}
.drag-handle:active {
  cursor: grabbing;
}
/* sortable 拖拽态：占位幽灵 + 抬起卡 */
.card-ghost {
  opacity: 0.4;
}
.card-ghost > .card-body {
  border: 1px dashed var(--violet);
  background: var(--bg-soft);
}
.card-chosen > .card-body {
  box-shadow: var(--shadow-lg);
}

/* P2b 剔除题退场过渡：淡出 + 收高（与 scheduleDropRemoval 320ms 兜底对齐） */
.canvas-body > .is-dropping {
  opacity: 0;
  transform: translateX(12px);
  max-height: 0;
  padding-top: 0;
  padding-bottom: 0;
  margin-top: -14px; /* 抵消 gap，避免退场期留空隙 */
  overflow: hidden;
  transition:
    opacity 0.28s ease,
    transform 0.28s ease,
    max-height 0.3s ease,
    margin 0.3s ease,
    padding 0.3s ease;
}

/* 生成中骨架卡：bg-100 脉动 + 120ms stagger */
.skeleton-card {
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: var(--r);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  animation: sk-pulse 1.4s infinite ease-in-out;
}
.sk-line {
  height: 14px;
  border-radius: var(--r-xs);
  background: var(--bg-soft);
}
.sk-w40 {
  width: 40%;
}
.sk-w70 {
  width: 70%;
}
@keyframes sk-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}

/* PRD-C-012 P2 占位卡：与 VariantCard 同宽同圆角（白底 14px radius 14/16 padding），
   题号圆灰化 + 「生成中…」+ 淡灰 shimmer 行，复用 sk-pulse 脉动 */
.pending-card {
  background: var(--paper);
  border: 1px dashed var(--line);
  border-radius: var(--r);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  animation: sk-pulse 1.4s infinite ease-in-out;
}
.pending-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* 题号圆：尺寸/字重对齐 VariantCard .seq，灰底表「未完成」 */
.pending-seq {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--faint);
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.pending-text {
  font-size: 13px;
  color: var(--muted);
}

/* 🔴 PRD-A-017 空态高保真（restyle.html .empty-canvas / .hero-ic / .stepper / .recipe-note）：
   居中三叠卡 + 标题副文 + 4 步横向 stepper（青点 + 渐变连线）+ recipe-note 配方引导。 */
.empty-canvas {
  margin: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
}
.hero-ic {
  width: 108px;
  height: 92px;
  opacity: 0.92;
  margin-bottom: 20px;
}
.empty-canvas h2 {
  margin: 0;
  font-size: 19px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--ink);
}
.empty-canvas .sub {
  font-size: 13px;
  color: var(--muted);
  max-width: 380px;
  margin-top: 8px;
  line-height: 1.7;
}
.stepper {
  display: flex;
  align-items: center;
  gap: 0;
  margin-top: 30px;
}
.stepper .node {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 104px;
}
.stepper .nd {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--teal);
  box-shadow: 0 0 0 4px var(--teal-50);
}
.stepper .nl {
  font-size: 12px;
  color: var(--ink-2);
  font-weight: 500;
  line-height: 1.35;
}
.stepper .seg {
  width: 46px;
  height: 1.5px;
  background: linear-gradient(90deg, var(--teal-line), var(--teal-line));
  margin-bottom: 25px;
  border-radius: 2px;
}
.recipe-note {
  margin-top: 34px;
  font-size: 12px;
  color: var(--faint);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: center;
  max-width: 480px;
}
.recipe-note b {
  color: var(--muted);
  font-weight: 600;
}
.recipe-note .sep {
  color: var(--teal-line);
}
</style>
