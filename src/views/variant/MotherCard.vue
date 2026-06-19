<script setup lang="ts">
// ---------------------------------------------------------------------------
// PRD-C-017 B3 ②③④⑥ + B3.6 母题 DNA 编辑→重生 — 母题紧凑卡（AC4 / AC6 / AC7 / G6 / G7 / G12 / M8）。
//
// 取代 C-015 的全宽大横条 MotherBar：收成【紧凑卡】，位置移到「变式题组」标题/chip 区
// （宿主 ArtifactPanel canvas-head 下方），可折叠（AC7 / G7 收窄移位）。
//
// 内容（②母题卡先出 + 全 10 维）：
//   - 解法骨架（solution_skeleton，【】标最难步 → 高亮可视）
//   - opus 解出的答案（solved_answer）
//   - 全 10 维 DNA：主考点 / 副考点 / 题型 / 考察类型 / 难度 / 场景 / 难点 / 突破点(骨架最难步)
//     / 模型 / 标签 + anchor 章 + need_anchor_review 标记
//   - ④难点空 → 显式「此题无显著难点」（M8，不是空白；送分题难点空是诚实正确）
//   - need_anchor_review=1 → 显式标「锚定待人审」（闸B 留空的诚实提示）
//   - ⑥「入库」按钮（G12）：母题确认入库 → 宿主映射 CreateQuestionBo → POST /teacher/question/create
//
// 🔴 B3.6 母题 DNA 编辑→重生（AC6/G6，复用 C-015 通路）：
//   C-015 MotherBar 原承载「母题守恒维编辑 → 触发重生」能力，B3 收窄时被下线（index.vue 里
//   onEditMotherDna 留成 dead code）。本批把这能力重接到收窄后的母题卡上，紧凑卡内联可编辑：
//     可改维 = C-015 守恒维定义（不扩不缩）：副考点 / 考察类型 / 解法骨架 / 难点。
//     改 → emit('edit-mother-dna', {field, value}) → 宿主 onEditMotherDna 调
//          editVariantDna(index=1, field) 落 mother_dna.dna（组级共享，BE 守恒维路由）→ 下游变式回流 dirty。
//     母题脏（motherDirty）→ 卡头亮「重生」按钮 → emit('regen-mother') → 宿主 runRegen 走
//          C-015 四分流重生（regenVariant），下游回流。重生机制一行不新造，纯复用既有端点。
//   🔴 入库 dirty 闸：母题脏（守恒维改了未重生）→ 入库按钮禁用（避免拿旧基准入库；与变式致命①一致）。
//
// 🔴 母题卡先于变式出：宿主在 needConfirm 确认后、变式 assemble 前若 toolkit 透传母题专帧，
//    本卡先单独亮（hasVariants=false 也渲染）；B3.5 后 toolkit 发 header.mother_card 专帧（含全维 dna）。
// ---------------------------------------------------------------------------
import { computed, ref } from 'vue'
import {
  EXAM_TYPES,
  type DnaEditValue,
  type DnaField,
  type MotherFigureItem,
  type VariantMotherCard,
} from '@/api/variant'
import MarkdownMath from '@/components/MarkdownMath.vue'
import InlineMath from '@/components/InlineMath.vue'
import KpTreeDialog from './KpTreeDialog.vue'

const props = defineProps<{
  motherCard: VariantMotherCard | null
  /**
   * 🔴 B4-polish：老师在确认面亲手选的章「人话名」（如「第二章 一元二次方程」）。
   * 母题卡「锚定章」优先显示它——最可靠，不依赖 toolkit 回灌 chapter_id。
   */
  confirmedChapterName?: string
  /**
   * 🔴 PRD-C-017 B5：老师确认面亲选的年级册人话名（如「七年级上」）。chip 年级优先显示它，
   * 不依赖 toolkit 回灌 header.grade（消除 chip「年级 未定」陈旧态）。
   */
  confirmedGradeBookName?: string
  /** 母题原图（守恒锚缩略图，点开看大图） */
  motherImg?: string
  /** 母题已入库 → 入库按钮置「已入库」 */
  persisted: boolean
  /** 入库进行中 → 按钮 loading */
  persisting: boolean
  /**
   * 🔴 B3.6 母题脏（守恒维改了、下游变式待重生）→ 亮「重生」按钮 + 禁入库（dirty 闸）。
   * 数据源 = artifact.header.motherDirty（D-merge8，BE 母题守恒维改后置位）。
   */
  motherDirty: boolean
  /** 🔴 B3.6 当前已有变式（重生需要有下游变式才有意义；无变式时只编辑、不亮重生） */
  hasVariants: boolean
  /** 重生进行中 → 重生按钮 loading（宿主 regeneratingIndexes 非空驱动） */
  regenerating: boolean
  /** 发送中：禁交互 */
  sending: boolean
  // ----- 🔴 PRD-C-100 B6 带图展示：母题切图（宿主调 crop_mother 后回填）-----
  /**
   * 🔴 PRD-C-100 bug-002 单元3：母题多图（toolkit 升方案 a，全部成功切图按检出顺序）。
   * 有值则 v-for 渲染全部；为空则回退用 figurePng 单图（向后兼容老路径）。
   */
  figures?: MotherFigureItem[]
  /** 切出的母题图 PNG base64（=figures[0]，老路径兼容；展示 data:image/png;base64,...） */
  figurePng?: string | null
  /** 切图进行中 → 按钮 loading + 占位 */
  figureLoading?: boolean
  /** 需配图但没切出来（G4）→ 「⚠待补图」徽章 */
  figureNeedsFigure?: boolean
  /** 切图相关文案（如「未识别到图形」），外显 */
  figureReason?: string | null
  /**
   * 🔴 PRD-A-017 批2b 合并头：折叠态由父级（ArtifactPanel 合并头 caret）控制。
   *   合并头持有 caret + 年级章 chip（避免两份），MotherCard 自身不再画折叠 toggle / chip。
   *   缺省 false（展开）；父不传则始终展开（向后兼容）。
   */
  collapsed?: boolean
}>()

const emit = defineEmits<{
  /** 母题入库（G12）→ 宿主映射 CreateQuestionBo 调 create */
  (e: 'persist-mother'): void
  /**
   * 🔴 B3.6 改母题守恒维（副考点/考察类型/骨架/难点·C-015 可改维定义）→ 宿主 onEditMotherDna
   * 调 editVariantDna(index=1, field) 落 mother_dna.dna（组级共享，下游回流 dirty）。
   */
  (e: 'edit-mother-dna', payload: { field: DnaField; value: DnaEditValue }): void
  /** 🔴 B3.6 触发重生（母题脏后）→ 宿主 runRegen 走 C-015 四分流（regenVariant），下游回流 */
  (e: 'regen-mother'): void
  /**
   * 🔴 PRD-C-017 B5：母题硬停 resume —— 老师点「开始举一反三」→ 宿主 onStartVariants 经
   * 续聊回合 agent_config 回传 start_variants=true，toolkit 直奔生成变式（不重跑 opus）。
   */
  (e: 'start-variants'): void
  /** 点开看大图 */
  (e: 'preview', url: string): void
  /** 🔴 PRD-C-100 B6：切母题图（宿主调 cropMotherFigure；重切=再点） */
  (e: 'crop-figure'): void
  /** 🔴 PRD-C-100 BC3：母题「手动排版」（仅已入库；宿主跳 A-015 网格编辑器 round-trip blockJson） */
  (e: 'manual-layout-mother'): void
}>()

// 折叠态：🔴 PRD-A-017 批2b 起改由父级合并头 caret 控（props.collapsed）。缺省展开。
const collapsed = computed(() => props.collapsed ?? false)

// 🔴 布局收窄（治「解析/答案超长把下方变式区+操作按钮挤没」）：
//   解法骨架 / 答案 / 解析三块文本默认「限高折叠」（detailExpanded=false → 各块 max-height +
//   渐隐遮罩 + 「展开全部」按钮），母题卡默认收窄、占位有上限；老师要看全点「展开全部」即去掉限高、
//   改内部滚动（max-height 撑大 + overflow:auto，超长在块内滚，仍不撑爆卡片）。
//   只折叠这三块「可能很长」的富文本，DNA 维网格 / chip / 图缩略 / 各「改」按钮一律不受影响（功能保留）。
const detailExpanded = ref(false)

const dna = computed(() => props.motherCard?.dna ?? null)
const hasCard = computed(() => !!props.motherCard)

// 🔴 B4-polish：锚定章显示文本。
//   优先级：① 老师确认面亲手选的章人话名（最可靠）；② toolkit 母题专帧回灌的 chapter id 兜底；
//   ③ 都没有 → 「按年级册锚定」（诚实兜底，不露内部字段名，彻底消除「（确认章 id 未透传）」占位）。
const anchorChapterText = computed(() => {
  const name = props.confirmedChapterName?.trim()
  if (name) return name
  const id = props.motherCard?.anchorChapterId?.trim()
  if (id) return id
  return '按年级册锚定'
})

// 难点（M8）：hard_points 空 → 显式「此题无显著难点」
const hardPoints = computed(() => dna.value?.hardPoints ?? [])

// 🔴 PRD-A-017 批2b：原 chipKp/chipGrade（卡头锚定 chip）已上移到 ArtifactPanel 合并头
//   （由宿主 index.vue anchorChip 算同一真值），此处删去避免两份。confirmedGradeBookName prop
//   仍由父透传备用，不再在本卡 chip 中消费。

// 🔴 PRD-C-017 B5 难度：1-4 星级（与变式卡同风格）+ 档位文案
const DIFFICULTY_LABEL = ['', '送分', '常规', '多步综合', '压轴']
const difficulty = computed(() => {
  const d = props.motherCard?.difficulty
  return typeof d === 'number' && d > 0 ? Math.round(d) : 0
})
const difficultyLabel = computed(() =>
  difficulty.value >= 1 && difficulty.value <= 4 ? DIFFICULTY_LABEL[difficulty.value] : ''
)

// 🔴 PRD-C-017 B5 答案：标准答案 answer 优先，回退 solvedAnswer
const answerText = computed(
  () => props.motherCard?.answer || props.motherCard?.solvedAnswer || ''
)

// 🔴 PRD-C-017 B5 解析：opus 完整解析富文本（analysis）
const analysisText = computed(() => props.motherCard?.analysis || '')

// 🔴 PRD-C-017 B5「开始举一反三」按钮：母题卡出来、尚无变式（toolkit 硬停 awaiting_mother_review）
//   → 显示主按钮，老师点了才生成变式；已有变式则不再显示（避免重复触发）。
const showStartBtn = computed(() => props.hasVariants === false && hasCard.value)
function onStart() {
  if (props.sending) return
  emit('start-variants')
}

// 解法骨架：把【...】最难步包成高亮 span（骨架文本里【】标记最难步基因）
const skeletonHtml = computed(() => props.motherCard?.solutionSkeleton ?? '')
const hasHardestMark = computed(() => /【[^】]+】/.test(skeletonHtml.value))

// 🔴 B3.6 重生可点：母题脏 + 已有变式 + 非发送中 + 非重生中
const canRegen = computed(
  () => props.motherDirty && props.hasVariants && !props.sending && !props.regenerating
)
// 🔴 入库 dirty 闸：母题脏（守恒维改了未重生）→ 禁入库，避免拿旧基准落库
const persistBlockedByDirty = computed(() => props.motherDirty)

const examTypeOptions = EXAM_TYPES

// ---- B3.6 守恒维：副考点（知识点树多选 ≤3，C-015 通路）----
const kpDialog = ref(false)
function onPickSecondaryKps(value: Array<{ id: string; name: string }>) {
  emit('edit-mother-dna', { field: 'secondary_kps', value })
  kpDialog.value = false
}

// ---- B3.6 守恒维：考察类型（闭集下拉）----
function onPickExamType(v: string) {
  if (!v || v === dna.value?.examType) return
  emit('edit-mother-dna', { field: 'exam_type', value: v })
}

// ---- B3.6 守恒维：解法骨架（文本编辑，【】标最难步）----
const skelEditing = ref(false)
const skelDraft = ref('')
function openSkelEdit() {
  if (props.sending) return
  skelDraft.value = props.motherCard?.solutionSkeleton || dna.value?.skeleton || ''
  skelEditing.value = true
  // 骨架编辑框在收窄区内 —— 打开时自动展开，避免限高 overflow:hidden 把编辑框截断
  detailExpanded.value = true
}
function saveSkel() {
  emit('edit-mother-dna', { field: 'skeleton', value: skelDraft.value.trim() })
  skelEditing.value = false
}

// ---- B3.6 守恒维：难点（文本编辑，多条按行）----
const hardEditing = ref(false)
const hardDraft = ref('')
function openHardEdit() {
  if (props.sending) return
  hardDraft.value = hardPoints.value.join('\n')
  hardEditing.value = true
}
function saveHard() {
  const arr = hardDraft.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  emit('edit-mother-dna', { field: 'hard_points', value: arr })
  hardEditing.value = false
}

// 🔴 PRD-C-100 bug-002 单元3：母题切图渲染列表。
//   优先用多图 figures[]；为空（老路径/兜底）则回退 figurePng 单图 → 包成单元素数组，模板统一 v-for。
const figureList = computed<string[]>(() => {
  const list = props.figures
  if (Array.isArray(list) && list.length) return list.map((f) => f.pngBase64).filter(Boolean)
  return props.figurePng ? [props.figurePng] : []
})

// 🔴 PRD-A-017 polish Fix-B：母题为纯文本/不需切图 → 不显「⚠待补图 / 不适合切图」噪音。
//   分流：① reason 文案表明「不适合/不需切图」(opus 判定不适合配图 / 未给命令 / 无需配图 …) →
//   后端权威「本题不需图」信号，即便 needsFigure 误标 true 也按「不需图」收起告警；② needsFigure=false
//   且无图 → 不需切图态。仅「确需切图但失败」(needsFigure=true 且 reason 非『不适合』语义，如本机
//   doclayout_yolo 缺模块的真失败) 才显 ⚠待补图。
const REASON_NOT_NEEDED = /不适合配图|未给命令|无需配图|不需配图|无图可画|无需配/
const figureReasonSaysNotNeeded = computed(
  () => !!props.figureReason && REASON_NOT_NEEDED.test(props.figureReason)
)
// 🔴 PRD-A-017 polish2：切图基建缺失（doclayout_yolo/torch/cv2 未装、权重缺）会回「母题切图失败:
//   No module named …」之类**原始 Python 异常**——老师看不懂、无法处置，是 infra 噪音不是产品信息。
//   命中即整体当「切图不可用」收起：不显 ⚠待补图、不显原始异常文案（真失败留后端日志/bug 池 BUG-02，
//   不漏给老师；纯文本母题本就无图可切，收起亦无误导）。非禁假数据——切图确不可用，诚实地不假装有图。
const REASON_IS_INFRA = /no module|modulenotfound|importerror|traceback|切图失败|无法加载|errno|exception|\bError\b/i
const figureReasonIsInfra = computed(
  () => !!props.figureReason && REASON_IS_INFRA.test(props.figureReason)
)
const figureNotNeeded = computed(
  () =>
    figureList.value.length === 0 &&
    (figureReasonSaysNotNeeded.value || (!props.figureNeedsFigure && !!props.figureReason))
)
</script>

<template>
  <section v-if="hasCard" class="mother-card" data-testid="variant-mother-card">
    <!-- 卡头：🔴 PRD-A-017 批2b 合并头化——折叠 caret + 标题 + 年级章 chip 已上移到 ArtifactPanel
         合并头（避免两份），此处只保留母题级状态标 + 功能按钮（待审 / 待重生 / 开始举一反三 /
         重生 / 入库 / 手动排版）。折叠态由 props.collapsed 控（合并头 caret 驱动）。 -->
    <header class="mc-head">
      <span class="mc-head-label">母题卡</span>
      <!-- ④ need_anchor_review 显式标（闸B 留空的诚实提示） -->
      <span v-if="motherCard?.needAnchorReview" class="mc-review-flag" title="主考点未锚到章内叶子，留待人工核对">
        锚定待人审
      </span>
      <!-- 🔴 B3.6 母题脏标记（守恒维改了、下游待按新基准重生） -->
      <span v-if="motherDirty" class="mc-dirty-flag" title="母题考点已改，下游变式待按新基准重生">
        待重生
      </span>
      <span class="mc-spacer" />
      <!-- 🔴 PRD-C-017 B5「开始举一反三」主按钮（母题硬停 → 老师点了才生成变式；生成中 loading） -->
      <el-button
        v-if="showStartBtn"
        size="small"
        class="mc-start"
        type="primary"
        :loading="sending"
        :disabled="sending"
        @click="onStart"
      >
        {{ sending ? '生成中…' : '▶ 开始举一反三' }}
      </el-button>
      <!-- 🔴 B3.6 重生按钮（母题脏 + 有变式才显，复用 C-015 regenVariant 通路） -->
      <el-button
        v-if="motherDirty && hasVariants"
        size="small"
        class="mc-regen"
        type="warning"
        plain
        :loading="regenerating"
        :disabled="!canRegen"
        @click="emit('regen-mother')"
      >
        重生下游变式
      </el-button>
      <!-- ⑥ 入库（G12）·🔴 B3.6 母题脏时禁入库（dirty 闸） -->
      <el-button
        size="small"
        class="mc-persist"
        :type="persisted ? 'success' : 'primary'"
        :loading="persisting"
        :disabled="sending || persisted || persistBlockedByDirty"
        :title="persistBlockedByDirty ? '母题考点已改，请先点「重生下游变式」再入库' : ''"
        @click="emit('persist-mother')"
      >
        {{ persisted ? '✓ 已入库' : '母题入库' }}
      </el-button>
      <!-- 🔴 PRD-C-100 BC3：母题手动排版（跳 A-015 网格编辑器，仅已入库才可点） -->
      <el-button
        v-if="persisted"
        size="small"
        class="mc-layout"
        plain
        :disabled="sending"
        title="打开网格编辑器手动排版母题（拖拉拽布局）"
        @click="emit('manual-layout-mother')"
      >
        🎨 手动排版
      </el-button>
    </header>

    <div v-show="!collapsed" class="mc-body">
      <!-- 左：母题图缩略（守恒锚） + 🔴 PRD-C-100 B6 切图（图形区） -->
      <div v-if="motherImg" class="mc-thumb-col">
        <div class="mc-thumb" title="母题原图 · 点开看大图" @click="emit('preview', motherImg)">
          <img :src="motherImg" alt="母题" referrerpolicy="no-referrer" />
        </div>
        <!-- 🔴 PRD-C-100 bug-002 单元3：母题切图多图（PNG 无损），v-for 渲染全部，各自点开看大图 -->
        <template v-if="figureList.length">
          <div
            v-for="(fig, i) in figureList"
            :key="i"
            class="mc-figure"
            :title="`母题图形 ${i + 1}/${figureList.length}（切图）· 点开看大图`"
            @click="emit('preview', `data:image/png;base64,${fig}`)"
          >
            <img :src="`data:image/png;base64,${fig}`" :alt="`母题图形 ${i + 1}`" />
            <span class="mc-figure-tag">图形{{ figureList.length > 1 ? ` ${i + 1}` : '' }}</span>
          </div>
        </template>
        <!-- G4：确需配图但没切出来 → ⚠待补图。🔴 Fix-B：reason 表「不适合切图」时去噪不显。 -->
        <div v-else-if="figureNeedsFigure && !figureReasonSaysNotNeeded && !figureReasonIsInfra" class="mc-figure-warn">⚠ 待补图</div>
        <!-- 切图 / 重切按钮（loading 期转圈）。🔴 验收纠偏：纯文本/不需切图/基建缺失态不显
             （避免母题图下方挂一个无意义的「切图形」孤儿按钮 + 空框，王老师/张校长挑刺）。
             仅「已切出图（可重切）」或「确需切图且非 infra/非不适合」才显。 -->
        <el-button
          v-if="figureList.length || (figureNeedsFigure && !figureReasonSaysNotNeeded && !figureReasonIsInfra)"
          text
          size="small"
          class="mc-figure-btn"
          :loading="figureLoading"
          :disabled="sending || figureLoading"
          @click="emit('crop-figure')"
        >
          {{ figureList.length ? '重新切图' : '切图形' }}
        </el-button>
        <!-- 🔴 Fix-B：不需切图态不显 reason（避免「母题切图失败」对纯文本母题的误报噪音） -->
        <p v-if="figureReason && !figureNotNeeded && !figureReasonIsInfra" class="mc-figure-reason">{{ figureReason }}</p>
      </div>

      <div class="mc-main">
        <!-- 🔴 收窄区：解法骨架 / 答案 / 解析三块「可能很长」的富文本默认限高折叠（detailExpanded=false）：
             各块 max-height 限高 + 底部渐隐遮罩，超长不撑爆卡、不挤没下方变式区；
             点「展开全部」→ 去限高、块内滚动看全。DNA 维网格等不在此区，始终完整显示。 -->
        <div class="mc-detail" :class="{ 'is-expanded': detailExpanded }">
        <!-- 解法骨架（【】标最难步，高亮可视） + opus 解答 -->
        <div class="mc-block">
          <span class="mc-block-k">
            解法骨架
            <span v-if="hasHardestMark" class="mc-hardest-hint">（【】= 最难步）</span>
            <button type="button" class="mc-min-btn" :disabled="sending" @click="openSkelEdit">改</button>
          </span>
          <template v-if="!skelEditing">
            <div v-if="motherCard?.solutionSkeleton" class="mc-skeleton" :class="{ 'has-mark': hasHardestMark }">
              <MarkdownMath :content="skeletonHtml" />
            </div>
            <span v-else class="mc-muted">（解法骨架未产出）</span>
          </template>
          <!-- 🔴 B3.6 骨架内联编辑（rewrite_solve 维，改→下游重写解析过闸B） -->
          <div v-else class="mc-edit-box">
            <el-input
              v-model="skelDraft"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 6 }"
              resize="none"
              placeholder="解法骨架（【】包最难步基因；改它=换基因，下游变式重写解析）"
            />
            <div class="mc-edit-actions">
              <button type="button" class="mc-cancel" @click="skelEditing = false">取消</button>
              <button type="button" class="mc-save" @click="saveSkel">保存</button>
            </div>
          </div>
        </div>
        <!-- 🔴 PRD-C-017 B5 答案（标准答案 answer 优先，回退 solvedAnswer） -->
        <div v-if="answerText" class="mc-block">
          <span class="mc-block-k">答案</span>
          <div class="mc-answer"><MarkdownMath :content="answerText" /></div>
        </div>
        <!-- 🔴 PRD-C-017 B5 解析（opus 完整解析富文本，与解答同风格 MarkdownMath） -->
        <div v-if="analysisText" class="mc-block">
          <span class="mc-block-k">解析</span>
          <div class="mc-answer"><MarkdownMath :content="analysisText" /></div>
        </div>
        </div>
        <!-- 🔴 展开/收起切换（仅在有可能超长的解法骨架/答案/解析时显示）：收窄态点「展开全部」看全，
             展开态点「收起」回限高。默认收窄让母题卡占位小、下方变式区可见。 -->
        <button
          v-if="motherCard?.solutionSkeleton || answerText || analysisText"
          type="button"
          class="mc-detail-toggle"
          @click="detailExpanded = !detailExpanded"
        >
          {{ detailExpanded ? '收起解法 / 解析 ▲' : '展开解法 / 解析全文 ▼' }}
        </button>

        <!-- 全 10 维 DNA（副考点 / 考察类型 / 难点 可改 = C-015 守恒维） -->
        <div class="mc-dna-grid">
          <span class="mc-k">主考点</span>
          <span class="mc-v"><b>{{ dna?.mainKp || motherCard?.anchorKp || '未锚定' }}</b></span>

          <span class="mc-k">副考点 <span class="mc-edit-tag">可改</span></span>
          <span class="mc-v">
            <template v-if="dna?.secondaryKps.length">
              <span v-for="kp in dna.secondaryKps" :key="kp" class="mc-pill sec"><InlineMath :content="kp" /></span>
            </template>
            <span v-else class="mc-muted">未标</span>
            <button type="button" class="mc-min-btn" :disabled="sending" @click="kpDialog = true">
              {{ dna?.secondaryKps.length ? '改' : '＋ 选' }}
            </button>
          </span>

          <span class="mc-k">题型 / 考察类型 <span class="mc-edit-tag">可改</span></span>
          <span class="mc-v">
            <span class="mc-pill">{{ motherCard?.qtype || '—' }}</span>
            <el-select
              :model-value="dna?.examType || ''"
              size="small"
              placeholder="选考察类型"
              class="mc-select"
              :disabled="sending"
              @change="onPickExamType"
            >
              <el-option v-for="t in examTypeOptions" :key="t" :label="t" :value="t" />
            </el-select>
          </span>

          <span class="mc-k">场景</span>
          <span class="mc-v"><InlineMath :content="dna?.scene || '纯代数'" /></span>

          <!-- 🔴 PRD-C-017 B5 难度行（1-4 星 + 档位文案，与变式卡同风格） -->
          <span class="mc-k">难度</span>
          <span class="mc-v">
            <template v-if="difficulty">
              <span class="mc-diff-stars">
                <span
                  v-for="n in 4"
                  :key="`md${n}`"
                  class="mc-star"
                  :class="n <= difficulty ? 'is-full' : 'is-empty'"
                >{{ n <= difficulty ? '★' : '☆' }}</span>
              </span>
              <span class="mc-diff-label">{{ difficultyLabel }}（{{ difficulty }}）</span>
            </template>
            <span v-else class="mc-muted">未标</span>
          </span>

          <span class="mc-k">难点 <span class="mc-edit-tag">可改</span></span>
          <span class="mc-v mc-full">
            <template v-if="!hardEditing">
              <template v-if="hardPoints.length">
                <span v-for="hp in hardPoints" :key="hp" class="mc-hard"><InlineMath :content="hp" /></span>
              </template>
              <!-- ④ M8：难点空 → 显式文案，不留白（送分题难点空是诚实正确） -->
              <span v-else class="mc-muted">此题无显著难点</span>
              <button type="button" class="mc-min-btn" :disabled="sending" @click="openHardEdit">改</button>
            </template>
            <!-- 🔴 B3.6 难点内联编辑（meta 维，改→即时生效不重出，但下游回流仍标 dirty 由 BE 决定） -->
            <div v-else class="mc-edit-box">
              <el-input
                v-model="hardDraft"
                type="textarea"
                :autosize="{ minRows: 1, maxRows: 4 }"
                resize="none"
                placeholder="难点（一行一条；基础题留空，宁空不凑）"
              />
              <div class="mc-edit-actions">
                <button type="button" class="mc-cancel" @click="hardEditing = false">取消</button>
                <button type="button" class="mc-save" @click="saveHard">保存</button>
              </div>
            </div>
          </span>

          <span class="mc-k">解题模型</span>
          <span class="mc-v">
            <template v-if="dna?.models.length">
              <span v-for="m in dna.models" :key="m.id" class="mc-model"><InlineMath :content="m.name || m.id" /></span>
            </template>
            <span v-else class="mc-muted">未标</span>
          </span>

          <span class="mc-k">标签</span>
          <span class="mc-v">
            <template v-if="dna?.tags.length">
              <span v-for="t in dna.tags" :key="t" class="mc-tag"><InlineMath :content="t" /></span>
            </template>
            <span v-else class="mc-muted">未标</span>
          </span>

          <span class="mc-k">锚定章</span>
          <span class="mc-v">
            <span class="mc-anchor-id">{{ anchorChapterText }}</span>
          </span>
        </div>

        <!-- 🔴 B3.6 母题脏提示条（守恒维改了、下游待重生 → 引导点重生） -->
        <p v-if="motherDirty && hasVariants" class="mc-dirty-hint">
          母题考点已改 → 下游变式已标「待重生」，点右上「重生下游变式」按新基准重出。
        </p>
      </div>
    </div>

    <!-- 副考点知识点树（多选 ≤3，C-015 通路） -->
    <KpTreeDialog
      v-model="kpDialog"
      mode="multi"
      title="改母题副考点（≤3）"
      :max="3"
      :preselected="[]"
      @pick-multi="onPickSecondaryKps"
    />
  </section>
</template>

<style scoped>
/* 🔴 PRD-A-017 换皮（青紫数学理性）：颜色一律取 .variant-page token（variant-theme.css）。
   青 var(--teal)=老师/主操作；紫 var(--violet)=AI；琥珀 var(--amber)=待审/重生；红 var(--red)=脏拦。
   合并头化：折叠 caret + 年级章 chip 已移到 ArtifactPanel 合并头，本卡头只剩状态标 + 功能按钮。 */
.mother-card {
  background: var(--paper);
  border: 1px solid var(--teal-line);
  border-radius: var(--r-sm);
  margin: 0 16px 12px;
  overflow: hidden;
}
.mc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: linear-gradient(180deg, var(--teal-50), var(--teal-100));
  border-bottom: 1px solid var(--teal-line);
}
.mc-head-label {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--teal-700);
}
.mc-review-flag {
  font-size: 11px;
  color: var(--amber);
  background: var(--amber-50);
  border: 1px solid var(--amber-line);
  border-radius: var(--r-xs);
  padding: 1px 8px;
  font-weight: 700;
}
.mc-dirty-flag {
  font-size: 11px;
  color: var(--red);
  background: var(--red-50);
  border: 1px solid var(--red-line);
  border-radius: var(--r-xs);
  padding: 1px 8px;
  font-weight: 700;
}
.mc-spacer {
  flex: 1;
}
.mc-regen {
  font-size: 12px;
}
.mc-persist {
  font-size: 12px;
}
/* 🔴 PRD-C-100 BC3 母题手动排版按钮（violet 系） */
.mc-layout {
  font-size: 12px;
  color: var(--violet-700);
  border-color: var(--violet-line);
}
/* 🔴 PRD-C-017 B5「开始举一反三」主按钮 */
.mc-start {
  font-size: 12px;
}
/* 🔴 PRD-C-017 B5 难度星（与变式卡同色语：暖琥珀实心 / 淡灰空心） */
.mc-diff-stars {
  display: inline-flex;
  align-items: center;
  line-height: 1;
  letter-spacing: -1px;
  font-size: 13px;
}
.mc-star.is-full {
  color: var(--amber);
}
.mc-star.is-empty {
  color: var(--faint);
}
.mc-diff-label {
  font-size: 11.5px;
  color: var(--muted);
}

.mc-body {
  display: flex;
  gap: 12px;
  padding: 12px;
}
.mc-thumb-col {
  flex: 0 0 96px;
  width: 96px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mc-thumb {
  width: 96px;
  height: 72px;
  border-radius: var(--r-sm);
  overflow: hidden;
  border: 1px solid var(--teal-line);
  cursor: zoom-in;
  background: var(--bg-soft);
}
.mc-thumb img {
  width: 100%;
  height: 100%;
  /* 🔴 母题图多为竖长条(题干+选项)，cover 会裁成中间一条 sliver(只露某个选项行)；
     contain = 整图缩进框、可辨认(守恒锚视觉提示，点开看大图)。 */
  object-fit: contain;
}
/* PRD-C-100 B6：母题切图（图形区） */
.mc-figure {
  position: relative;
  width: 96px;
  min-height: 50px;
  border-radius: var(--r-sm);
  overflow: hidden;
  border: 1px dashed var(--violet);
  cursor: zoom-in;
  background: var(--violet-50);
}
.mc-figure img {
  width: 100%;
  height: auto;
  display: block;
}
.mc-figure-tag {
  position: absolute;
  left: 0;
  bottom: 0;
  right: 0;
  font-size: 9px;
  color: #fff;
  text-align: center;
  background: rgba(123, 108, 240, 0.78);
}
.mc-figure-warn {
  width: 96px;
  font-size: 11px;
  color: var(--amber);
  background: var(--amber-50);
  border: 1px dashed var(--amber-line);
  border-radius: var(--r-sm);
  text-align: center;
  padding: 4px 0;
}
.mc-figure-btn {
  justify-content: flex-start;
  padding: 0;
}
.mc-figure-reason {
  font-size: 10px;
  color: var(--faint);
  line-height: 1.4;
  margin: 0;
}
.mc-main {
  flex: 1;
  min-width: 0;
}

.mc-block {
  margin-bottom: 8px;
}
.mc-block-k {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--muted);
  margin-bottom: 2px;
}
.mc-hardest-hint {
  color: var(--amber);
  font-weight: 600;
}
.mc-skeleton,
.mc-answer {
  font-size: 13px;
  color: var(--ink);
  line-height: 1.6;
}
.mc-skeleton :deep(p),
.mc-answer :deep(p) {
  margin: 0;
}
/* 最难步【】高亮：骨架里若有【】标记，整块加暖底提示「含最难步基因」 */
.mc-skeleton.has-mark {
  background: var(--amber-50);
  border-left: 3px solid var(--amber);
  border-radius: 0 var(--r-xs) var(--r-xs) 0;
  padding: 6px 10px;
}

/* 🔴 收窄区（解法骨架 / 答案 / 解析三块富文本）：默认限高折叠 + 底部渐隐遮罩，
   提示「内容被截断、点展开看全」；母题卡默认占位小，绝不把下方变式区/操作按钮挤没。 */
.mc-detail {
  position: relative;
  max-height: 168px;
  overflow: hidden;
}
.mc-detail::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 36px;
  background: linear-gradient(to bottom, rgba(255, 255, 255, 0), var(--paper) 92%);
  pointer-events: none;
}
/* 展开态：去限高、改内部滚动 —— 超长仍在本区内滚（不撑爆卡片），遮罩撤掉 */
.mc-detail.is-expanded {
  max-height: 46vh;
  overflow-y: auto;
}
.mc-detail.is-expanded::after {
  display: none;
}
/* 展开 / 收起切换按钮（低调文字按钮，居中） */
.mc-detail-toggle {
  display: block;
  margin: 4px auto 2px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--teal-700);
  background: var(--teal-50);
  border: 1px solid var(--teal-line);
  border-radius: var(--r-sm);
  padding: 2px 14px;
  cursor: pointer;
}
.mc-detail-toggle:hover {
  background: var(--teal-100);
}

.mc-dna-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 12px;
  font-size: 12.5px;
  align-items: baseline;
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px dashed var(--line);
}
.mc-k {
  color: var(--muted);
  white-space: nowrap;
}
.mc-edit-tag {
  font-size: 9.5px;
  color: var(--teal-700);
  background: var(--teal-50);
  border: 1px solid var(--teal-line);
  border-radius: var(--r-xs);
  padding: 0 4px;
  font-weight: 600;
}
.mc-v {
  color: var(--ink);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}
.mc-v.mc-full {
  align-items: flex-start;
}
.mc-muted {
  color: var(--faint);
}
.mc-pill {
  font-size: 11.5px;
  border-radius: 999px;
  padding: 1px 9px;
  background: var(--paper);
  color: var(--teal-700);
  border: 1px solid var(--teal-line);
}
.mc-pill.sec {
  border-color: var(--teal-line);
}
.mc-hard {
  font-size: 11.5px;
  background: var(--amber-50);
  color: var(--amber);
  border-radius: var(--r-xs);
  padding: 1px 8px;
  font-weight: 600;
}
.mc-model {
  font-size: 11.5px;
  background: var(--violet-50);
  color: var(--violet-700);
  border: 1px solid var(--violet-line);
  border-radius: 999px;
  padding: 1px 9px;
}
.mc-tag {
  font-size: 11.5px;
  background: var(--teal-50);
  color: var(--teal-700);
  border-radius: var(--r-xs);
  padding: 1px 8px;
}
.mc-anchor-id {
  font-size: 11px;
  color: var(--faint);
  font-family: var(--mono);
}

/* 🔴 B3.6 内联编辑控件（复用 MotherBar 守恒维编辑视觉） */
.mc-min-btn {
  font-size: 11px;
  color: var(--teal-700);
  background: var(--paper);
  border: 1px solid var(--teal-line);
  border-radius: var(--r-xs);
  padding: 1px 9px;
  cursor: pointer;
}
.mc-min-btn:hover:not(:disabled) {
  background: var(--teal-50);
}
.mc-min-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.mc-select {
  width: 138px;
}
.mc-edit-box {
  flex-basis: 100%;
  width: 100%;
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  padding: 8px;
}
.mc-edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}
.mc-cancel,
.mc-save {
  font-size: 12px;
  border-radius: var(--r-sm);
  padding: 3px 14px;
  cursor: pointer;
}
.mc-cancel {
  color: var(--muted);
  background: var(--paper);
  border: 1px solid var(--line);
}
.mc-save {
  color: #fff;
  background: var(--teal);
  border: 1px solid var(--teal);
}
.mc-save:hover {
  background: var(--teal-700);
}
.mc-dirty-hint {
  margin: 10px 0 0;
  font-size: 11.5px;
  color: var(--amber);
  background: var(--amber-50);
  border: 1px solid var(--amber-line);
  border-radius: var(--r-sm);
  padding: 6px 10px;
  line-height: 1.5;
}
</style>
