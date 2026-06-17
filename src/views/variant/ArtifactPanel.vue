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
  loading: boolean
  needs: boolean
  reason: string | null
}
import KpTreeDialog from './KpTreeDialog.vue'
import FontSizeSwitch from '@/components/business/FontSizeSwitch/index.vue'
import { useFontScale } from '@/composables/useFontScale'

// 题面展示字号（小/中/大）—— 与个人题库共用同一状态，注入 --md-font-size 级联给卡片 MarkdownMath
const { cssVars: fontVars } = useFontScale()

const props = defineProps<{
  artifact: VariantArtifact | null
  /** 发送中：禁用画布级按钮 + 无快照时显示骨架卡 */
  sending: boolean
  /** 是否已有初始出题 utterance（决定「换一批」可用性） */
  canRegenerate: boolean
  /** 正在重新验算的题 index（1-based）；该卡显示 loading 态 */
  reverifyingIndex?: number | null
  /** PRD-C-014 T1：正在「收录入库」的题 index（1-based）；该卡入库按钮 loading */
  persistingIndex?: number | null
  /** PRD-C-014 T2：正在「加入试题篮」的题 index（1-based）；该卡加篮按钮 loading */
  basketingIndex?: number | null
  /** PRD-C-015 批5：正在重生的题号集合（1-based）；命中的卡 loading + 重生按钮转圈。null/[]=无 */
  regeneratingIndexes?: number[] | null
  /** 🔴 PRD-C-100 B6：单卡配图态（按题 index 1-based）；宿主透传，缺省 = 未配图 */
  variantFigures?: Record<number, VariantFigureState>
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
  /** 🔴 PRD-C-100 B6：点开看大图（含切图 / 配图 data URL；宿主弹大图遮罩） */
  (e: 'preview', url: string): void
  /** 🔴 PRD-C-100 BC3：已入库变式「手动排版」（宿主标印记 + 跳 A-015 网格编辑器） */
  (e: 'manual-layout', index: number): void
}>()

// G13 ⑤：头部主考点（知识点树弹层）/ 年级（下拉）可改
const headerKpDialog = ref(false)
const gradePopover = ref(false)
const GRADE_OPTIONS = [
  '七年级上', '七年级下', '八年级上', '八年级下', '九年级上', '九年级下',
  '高一上', '高一下', '高二上', '高二下', '高三',
]
function onPickHeaderKp(value: { id: string; name: string }) {
  emit('edit-header-kp', value)
  headerKpDialog.value = false
}
function pickGrade(g: string) {
  gradePopover.value = false
  emit('edit-header-grade', g)
}

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
  if (props.sending || items.value.length === 0 || allPersisted.value) return
  // PRD-C-015 批5 致命①：有脏题 → 前端拦下（后端 persist_to_bank 也会硬拦）
  if (hasDirty.value) {
    const ns = regenPendingIndexes.value.join('、')
    ElMessage.warning(`第 ${ns || '?'} 题改了还没重生，先点「重生待重生集合」或撤销，再全部入库`)
    return
  }
  emit('persist')
}

function regenerate() {
  if (props.sending || !props.canRegenerate) return
  emit('regenerate')
}

/** PRD-C-015 批5：一键重生全待重生集合（D-merge8，indexes 省略 = 全集合） */
function regenAll() {
  if (props.sending || regenPendingIndexes.value.length === 0) return
  emit('regen-all')
}
</script>

<template>
  <section class="artifact-panel" data-testid="variant-artifact-panel" :style="fontVars">
    <!-- 画布头：标题 + 守恒/配方徽章 + 画布级动作（右上） -->
    <header class="canvas-head">
      <div class="head-line">
        <h2 class="canvas-title">变式题组<template v-if="items.length"> · {{ items.length }} 道</template></h2>
        <span class="head-spacer" />
        <FontSizeSwitch class="head-font-switch" />
        <!-- PRD-C-015 批5：待重生集合非空 → 「重生 N 题」按钮（D-merge8 一键重出全集合） -->
        <el-button
          v-if="regenPendingIndexes.length > 0"
          size="small"
          class="regen-all-btn"
          :loading="!!(regeneratingIndexes && regeneratingIndexes.length)"
          :disabled="sending"
          @click="regenAll"
        >
          🔄 重生 {{ regenPendingIndexes.length }} 题
        </el-button>
        <el-button
          size="small"
          :disabled="sending || !canRegenerate"
          @click="regenerate"
        >
          换一批
        </el-button>
        <el-button
          size="small"
          class="persist-btn"
          :disabled="sending || items.length === 0 || allPersisted || hasDirty"
          :title="hasDirty ? '有题改了还没重生，先点「重生」或撤销' : ''"
          @click="persistAll"
        >
          {{ allPersisted ? '已全部收录' : '全部入库' }}
        </el-button>
      </div>
      <!-- PRD-C-015 批5：母题脏 / 待重生提示条（致命①入库拦截原因外显） -->
      <div v-if="hasDirty" class="dirty-banner">
        <template v-if="artifact?.header.motherDirty">
          母题守恒维改过，下游变式已标「待重生」——点上方「重生」按新基准重出，重生前不可入库。
        </template>
        <template v-else>
          第 {{ regenPendingIndexes.join('、') }} 题改了还没重生，点「重生」按新 DNA 重出后才能入库。
        </template>
      </div>
      <!-- G13 ⑤：头部「主考点 / 年级」固定显示且可改（点 ✎ 调知识点树 / 年级下拉） -->
      <div v-if="artifact" class="head-badges">
        <button type="button" class="keep-badge editable" :disabled="sending" @click="headerKpDialog = true">
          主考点 <b>{{ artifact.header.kp || '未锚定' }}</b><span class="edit-pen">✎</span>
        </button>
        <el-popover :visible="gradePopover" placement="bottom-start" :width="220" trigger="manual">
          <template #reference>
            <button type="button" class="keep-badge editable" :disabled="sending" @click="gradePopover = !gradePopover">
              年级 <b>{{ artifact.header.grade || '未定' }}</b><span class="edit-pen">✎</span>
            </button>
          </template>
          <div class="grade-pop">
            <span v-for="g in GRADE_OPTIONS" :key="g" class="grade-opt" @click="pickGrade(g)">{{ g }}</span>
          </div>
        </el-popover>
        <span v-if="artifact.header.recipe" class="recipe-badge">{{ artifact.header.recipe }}</span>
      </div>
    </header>

    <!-- PRD-C-017 B3·AC7 收窄移位：母题紧凑卡插槽——位于「变式题组」标题区下方
         （原 C-015 全宽横条 MotherBar 收成本卡，宿主 index.vue 注入 MotherCard） -->
    <slot name="mother-card" />

    <!-- G13 ⑤：头部主考点的知识点树弹层（组级守恒锚） -->
    <KpTreeDialog
      v-model="headerKpDialog"
      mode="single"
      title="选择整组主考点"
      @pick="onPickHeaderKp"
    />

    <!-- 卡片列 -->
    <div ref="listEl" class="canvas-body">
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
            :checking="checking"
            :reverifying="reverifyingIndex === it.index"
            :persisting="persistingIndex === it.index"
            :basketing="basketingIndex === it.index"
            :regenerating="!!(regeneratingIndexes && regeneratingIndexes.includes(it.index))"
            :figure-png="variantFigures?.[it.index]?.png ?? null"
            :figure-loading="!!variantFigures?.[it.index]?.loading"
            :figure-needs-figure="!!variantFigures?.[it.index]?.needs"
            :figure-reason="variantFigures?.[it.index]?.reason ?? null"
            @utterance="(t: string) => emit('utterance', t)"
            @edit="(p) => emit('edit', p)"
            @reverify="(i: number) => emit('reverify', i)"
            @persist-one="(i: number) => emit('persist-one', i)"
            @add-to-basket="(i: number) => emit('add-to-basket', i)"
            @edit-dna="(p) => emit('edit-dna', p)"
            @regen="(i: number) => emit('regen', i)"
            @undo-regen="(i: number) => emit('undo-regen', i)"
            @edit-models="(p) => emit('edit-models', p)"
            @compose-figure="(p) => emit('compose-figure', p)"
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

      <!-- 生成中骨架卡（尚无快照时） -->
      <template v-else-if="sending">
        <div v-for="n in 3" :key="n" class="skeleton-card" :style="{ animationDelay: `${(n - 1) * 120}ms` }">
          <div class="sk-line sk-w40" />
          <div class="sk-line" />
          <div class="sk-line sk-w70" />
        </div>
      </template>

      <!-- 空态引导（旧后端无 artifact 帧时也落这里，左栏不受影响） -->
      <div v-else class="canvas-empty">
        <div class="empty-emoji">🗂</div>
        <p class="empty-title">题组卡片会出现在这里</p>
        <p class="empty-tip">
          在左侧贴一张母题图开始出题；每道变式以卡片呈现——题干、解析折叠、
          验算徽章、换数字 / 换场景快捷键，最后一键「全部入库」。
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* DESIGN token：bg-50 #F5F8F8 / card #FFF / border #E3E9E9 / ink-900 #1D2A2E
   teal-50 #E6F2F2 / teal-600 #1E8A8A / teal-700 #176E6E / bg-100 #EDF2F2 / ink-700 #33464C */
.artifact-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #fbfaf6; /* 暖纸白 paper（v3 设计语言） */
  border-radius: 16px;
  overflow: hidden;
}

.canvas-head {
  flex-shrink: 0;
  padding: 14px 20px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-bottom: 1px solid #e7e3da;
  background: #fbfaf6;
}
.head-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.canvas-title {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: #1d2a2e; /* ink-900 */
}
.head-spacer {
  flex: 1;
}
.head-font-switch {
  margin-right: 4px;
}
/* 老师拍板动作 = teal（不是紫）：右栏不出现紫色实心按钮 */
.persist-btn {
  background: #1e8a8a;
  border-color: #1e8a8a;
  color: #fff;
}
.persist-btn:hover:not(:disabled) {
  background: #176e6e;
  border-color: #176e6e;
  color: #fff;
}
.persist-btn:disabled {
  background: #b9d8d8;
  border-color: #b9d8d8;
  color: #fff;
}

/* PRD-C-015 批5：「重生 N 题」按钮（amber 实心，与卡内重生按钮同色语） */
.regen-all-btn {
  background: #b8741a;
  border-color: #b8741a;
  color: #fff;
}
.regen-all-btn:hover:not(:disabled) {
  background: #9a6015;
  border-color: #9a6015;
  color: #fff;
}
/* PRD-C-015 批5：母题脏 / 待重生入库拦截提示条 */
.dirty-banner {
  font-size: 12px;
  line-height: 1.6;
  color: #92590f;
  background: #fdf4e3;
  border: 1px solid #ecc98f;
  border-radius: 8px;
  padding: 6px 11px;
}

.head-badges {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.keep-badge {
  font-size: 12px;
  color: #385350; /* ink-700 */
  background: #fff;
  border: 1px solid #e7e3da;
  border-radius: 999px;
  padding: 4px 11px;
  font-weight: 500;
}
.keep-badge b {
  color: #0f6e6e; /* teal-700 */
  margin: 0 2px;
  font-weight: 700;
}
.keep-badge.editable {
  cursor: pointer;
  display: inline-flex;
  align-items: center;
}
.keep-badge.editable:hover:not(:disabled) {
  background: #e7f3f1;
  border-color: #7fc0bd;
}
.keep-badge.editable:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.edit-pen {
  margin-left: 5px;
  color: #1e8a8a;
  font-size: 11px;
}
.grade-pop {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.grade-opt {
  font-size: 12px;
  color: #385350;
  background: #f7faf9;
  border: 1px solid #e7e3da;
  border-radius: 8px;
  padding: 4px 10px;
  cursor: pointer;
}
.grade-opt:hover {
  background: #e7f3f1;
  border-color: #7fc0bd;
  color: #0f6e6e;
}
.recipe-badge {
  font-size: 12px;
  color: #33464c; /* ink-700 */
  background: #edf2f2; /* bg-100 */
  border-radius: 6px;
  padding: 2px 10px;
}

.canvas-body {
  flex: 1;
  overflow-y: auto;
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
  color: #c0c6cf;
  font-size: 15px;
  line-height: 1;
  cursor: grab;
  border-radius: 6px;
  touch-action: none;
  user-select: none;
}
.drag-handle:hover {
  color: #1e8a8a; /* teal-600 */
  background: #e6f2f2;
}
.drag-handle:active {
  cursor: grabbing;
}
/* sortable 拖拽态：占位幽灵 + 抬起卡 */
.card-ghost {
  opacity: 0.4;
}
.card-ghost > .card-body {
  border: 1px dashed #7b6cf0;
  background: #f5f8f8;
}
.card-chosen > .card-body {
  box-shadow: 0 6px 18px rgba(29, 42, 46, 0.12);
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
  background: #fff;
  border: 1px solid #e3e9e9;
  border-radius: 14px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  animation: sk-pulse 1.4s infinite ease-in-out;
}
.sk-line {
  height: 14px;
  border-radius: 6px;
  background: #edf2f2; /* bg-100 */
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
  background: #fff;
  border: 1px dashed #d4dede;
  border-radius: 14px;
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
  background: #c0c6cf;
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
  color: #86909c;
}

.canvas-empty {
  margin: auto;
  text-align: center;
  color: #86909c;
  max-width: 360px;
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
  line-height: 1.7;
}
</style>
