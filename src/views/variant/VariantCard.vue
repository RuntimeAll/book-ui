<script setup lang="ts">
// ---------------------------------------------------------------------------
// PRD-C-011 Bucket3 — 变式题组单卡（DESIGN.md §14.4）。
//
// 数据源 = artifact 快照帧（props.item），FE 不 parse markdown 拼卡片（铁律 2）。
// 卡片快捷键 = utterance：换数字 / 换场景 / 答疑全部 emit('utterance', 预设句)，
// 由宿主走【现有 chat SSE 通道】发给 agent（铁律 1，零新增结构化编辑端点）。
//
// 验证徽章语义（PRD-C-012 4d「只说好、不说坏，除非双闸都不高」，2026-06-11 用户拍板）：
// 唯一依据 = item.tier（BE _apply_visibility 矩阵产出）：
//   verified → ✓ 程序验算通过（green）；self_ok → ✓ 已独立复算一致（green）；
//   proof → ℹ 转人工复核（violet，中性）；silent → 无徽章；both_low → ⚠ 需重点核对（amber）。
// 旧线程恢复无 tier → 按「只说好」兜底：仅 sympy_pass/proof 外显，其余沉默。
// gene 徽章只保留正面（pass → 平行度 ✓）；warn 沉默（双闸低已由 ⚠ 承担）。
// persisted=true → 已收录（入库后 BE 重发快照帧驱动）。
// ---------------------------------------------------------------------------
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  EXAM_TYPES,
  QTYPE_OPTIONS,
  REGEN_CLASS_BADGE,
  regenClassOf,
  type DnaField,
  type RegenClass,
  type VariantArtifactItem,
} from '@/api/variant'
import { tagsByKp as fetchTagsByKp } from '@/api/question'
import MarkdownMath from '@/components/MarkdownMath.vue'
import KpTreeDialog from './KpTreeDialog.vue'
import {
  normalizeStem,
  parseChoiceStem,
  assembleChoiceStem,
  smartMath,
} from './normalize'

const props = defineProps<{
  item: VariantArtifactItem
  /** 发送中禁用所有快捷键 */
  sending: boolean
  /**
   * PRD-C-013 P2b：本组仍在增量上屏（artifact.partial===true）。仅在此期间，
   * item.tier 为 null 才解读为「验算中」过渡态；恢复/定稿帧无此标记 → 走只说好兜底。
   */
  checking?: boolean
  /** 本卡正在重新验算（单题 LLM+sympy，几秒）→ 验算按钮 loading + 卡片轻禁用 */
  reverifying?: boolean
  /** PRD-C-014 T1：本卡正在「收录入库」（调 persist-one）→ 按钮 loading */
  persisting?: boolean
  /** PRD-C-014 T2：本卡正在「加入试题篮」（透明入库：可能含 persist-one + 篮 add）→ 按钮 loading */
  basketing?: boolean
  /** PRD-C-015 批5：本卡正在重生（regen 待重生集合命中本题）→ 卡片 loading + 重生按钮转圈 */
  regenerating?: boolean
}>()

const emit = defineEmits<{
  (e: 'utterance', text: string): void
  /** 保存内容编辑（只传改过的字段，宿主调 editVariantItem） */
  (e: 'edit', payload: { index: number; stem?: string; answer?: string; solution?: string }): void
  /** 重新验算（宿主调 reverifyVariantItem） */
  (e: 'reverify', index: number): void
  /** PRD-C-014 T1：单题「收录入库」（宿主调 persistVariantOne） */
  (e: 'persist-one', index: number): void
  /** PRD-C-014 T2：单题「加入试题篮」（宿主透明入库：未入库先 persist-one 再加篮，已入库直接加篮） */
  (e: 'add-to-basket', index: number): void
  /**
   * PRD-C-014 T3：DNA 列表选编辑（零 LLM，平台数据源）。宿主调 editVariantDna(field, value)。
   * value 类型随 field：main_kp={id,name} / secondary_kps=[{id,name}] / qtype|exam_type=string
   *   / tags=string[] / difficulty=number。
   */
  (
    e: 'edit-dna',
    payload: {
      index: number
      // 🔴 PRD-C-017 B5：scene / skeleton 改点击直改 → 也走 edit-dna（结构化字段，去掉自然语言 revise）
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
  /**
   * PRD-C-015 批5：重生本题（宿主调 regenVariant([index])，对 dirty 维按新 DNA 重出）。
   * 🔴 PRD-C-017 B5：「重生这道」按钮始终可点（不再限 dirty），按当前改好的字段重出本题。
   */
  (e: 'regen', index: number): void
  /** PRD-C-015 批5：撤销本题重生（宿主调 undoRegenVariant，回上一版快照） */
  (e: 'undo-regen', index: number): void
  /** PRD-C-015 批5：models 维改（rewrite_solve 档；宿主调 editVariantDna(field='models')） */
  (e: 'edit-models', payload: { index: number; value: Array<{ id: string; name: string }> }): void
}>()

const showSolution = ref(false)

// ---------------------------------------------------------------------------
// 内容编辑（傻瓜式）：编辑态把 stem/answer/solution 各显示为 textarea + 实时 MarkdownMath
// 预览（KaTeX 立等可见）；保存只把「改过的字段」传给宿主（走 edit-item，BE 净化 + 标
// manual_edited + 置 tier='manual'）；取消还原。「规范排版」= 纯 FE 文本 normalize（解析
// 不出原样返回，降级不报错）。tier='manual' 的卡显示「重新验算」按钮。
// ---------------------------------------------------------------------------
const editing = ref(false)
// 通用字段草稿（题干/答案/解析）；选择题额外用 choiceDraft 拆字段（题干+4选项），保存时回拼
const draft = reactive({ stem: '', answer: '', solution: '' })
// 选择题结构化草稿：题干（不含选项段）+ 选项内容数组（A-D）+ 答案字母
const choiceDraft = reactive({ stem: '', options: ['', '', '', ''], answer: '' })

// ---------------------------------------------------------------------------
// 题型判定（决定编辑态字段布局，与 normalize.ts 的 isXxx 同口径）：
//   choice（选择）：题干 + 选项A-D + 答案下拉(A-D)，保存回拼 canonical
//   blank（填空） ：题干（含 ____）+ 答案
//   judge（判断） ：题干 + 答案下拉(对/错)
//   essay（解答/其他兜底）：题干/答案/解析三段（维持现状，多小问不拆）
// ---------------------------------------------------------------------------
type EditKind = 'choice' | 'blank' | 'judge' | 'essay'
const editKind = computed<EditKind>(() => {
  const qt = props.item.qtype || ''
  if (/选择|单选|多选/.test(qt)) return 'choice'
  if (/判断|对错|正误/.test(qt)) return 'judge'
  if (/填空/.test(qt)) return 'blank'
  // qtype 不可靠时按 stem 文本兜底判选择（含 A. B. 两标记）
  const stem = props.item.stem || ''
  if (/(^|[\s，。；、\n])A\s*[.．、:：)）]/.test(stem) && /(^|[\s，。；、\n])B\s*[.．、:：)）]/.test(stem)) {
    return 'choice'
  }
  return 'essay'
})

const CHOICE_LETTERS = ['A', 'B', 'C', 'D'] as const
const JUDGE_OPTIONS = ['对', '错'] as const

// 题组刷新（保存/重排/验算后宿主整量替换 item）→ 若仍在编辑态且不是本卡触发，退出编辑避免脏改
watch(
  () => props.item.seq,
  () => {
    if (editing.value) editing.value = false
  }
)

function startEdit() {
  if (props.sending || props.reverifying) return
  draft.stem = props.item.stem || ''
  draft.answer = props.item.answer || ''
  draft.solution = props.item.solution || ''
  if (editKind.value === 'choice') {
    const parsed = parseChoiceStem(props.item.stem || '')
    choiceDraft.stem = parsed.stem
    // 固定 4 框（A-D）；解析出的选项填入，不足补空、多出（E…）合并进 D 末尾的提示由老师手动处理
    choiceDraft.options = [0, 1, 2, 3].map((i) => parsed.options[i] || '')
    // 答案归一成单字母（BE 可能给 "A" 或 "A. xxx" 或含多字母）
    const ans = (props.item.answer || '').trim().toUpperCase()
    const m = ans.match(/[A-D]/)
    choiceDraft.answer = m ? m[0] : ''
  }
  showSolution.value = true // 展开解析，编辑答案/解析时可见
  editing.value = true
}

function cancelEdit() {
  editing.value = false
}

/** 把当前编辑草稿规整成「待保存的最终字段」（选择题回拼 canonical stem + 字母 answer） */
function buildSaveFields(): { stem: string; answer: string; solution: string } {
  if (editKind.value === 'choice') {
    return {
      stem: assembleChoiceStem(choiceDraft.stem, choiceDraft.options),
      answer: choiceDraft.answer,
      solution: draft.solution,
    }
  }
  return { stem: draft.stem, answer: draft.answer, solution: draft.solution }
}

function saveEdit() {
  const fields = buildSaveFields()
  // 只传改过的字段（其余 BE 不动）
  const payload: { index: number; stem?: string; answer?: string; solution?: string } = {
    index: props.item.index,
  }
  let changed = false
  if (fields.stem !== (props.item.stem || '')) {
    payload.stem = fields.stem
    changed = true
  }
  if (fields.answer !== (props.item.answer || '')) {
    payload.answer = fields.answer
    changed = true
  }
  if (fields.solution !== (props.item.solution || '')) {
    payload.solution = fields.solution
    changed = true
  }
  if (!changed) {
    editing.value = false
    return
  }
  emit('edit', payload)
  editing.value = false
}

/** 规范排版：纯 FE 行级 normalize 题干（选项独立成行 / 填空下划线 / 判断题补括号），失败原样 */
function normalize() {
  try {
    const before = draft.stem
    const after = normalizeStem(before, props.item.qtype)
    if (after === before) {
      ElMessage.info('题干已是规范格式，无需调整')
    } else {
      draft.stem = after
      ElMessage.success('已规范排版，可继续编辑后保存')
    }
  } catch {
    // 降级：解析不出不报错，保持原样
  }
}

// ---------------------------------------------------------------------------
// 智能输入：失焦时把字段内自然写法（2/5、x^2、sqrt3、<=）转 $...$ LaTeX，预览立等可见。
// 已是 $...$ 的不重复包，转不了原样。绑在各字段 @blur 上（输入中不打断，失焦才转）。
// ---------------------------------------------------------------------------
function smartChoiceStem() {
  choiceDraft.stem = smartMath(choiceDraft.stem)
}
function smartChoiceOption(i: number) {
  choiceDraft.options[i] = smartMath(choiceDraft.options[i] || '')
}
function smartDraftStem() {
  draft.stem = smartMath(draft.stem)
}
function smartDraftAnswer() {
  draft.answer = smartMath(draft.answer)
}
function smartDraftSolution() {
  draft.solution = smartMath(draft.solution)
}

// ---------------------------------------------------------------------------
// 展示态选择题：解析 stem → 题干 + 选项，选项按长度自适应（短则 2 列、长则 1 列），
// 编辑框（一行一项）与展示一致（存储仍一行一项，2×2 仅渲染层）。
// ---------------------------------------------------------------------------
const displayChoice = computed(() => {
  if (editKind.value !== 'choice') return null
  const parsed = parseChoiceStem(props.item.stem || '')
  if (!parsed.options.length) return null // 解析不出 → 回退整段 MarkdownMath
  const maxLen = parsed.options.reduce((m, o) => Math.max(m, o.length), 0)
  // 任一选项过长（>14 字符，约含分式/长文）→ 单列；否则 2 列（2×2）
  const twoCol = maxLen <= 14 && parsed.options.length <= 4
  return {
    stem: parsed.stem,
    options: parsed.options.map((o, i) => ({ letter: CHOICE_LETTERS[i] || '?', content: o })),
    twoCol,
    answer: ((props.item.answer || '').trim().toUpperCase().match(/[A-D]/) || [''])[0],
  }
})

const isManual = computed(() => props.item.tier === 'manual')

// PRD-C-013 P2b 逐题上屏：增量帧首发该题时无 tier（闸链 A+B 未跑完）→ 显示「验算中…」
// 过渡徽章（呼吸态，不出 ✓/⚠）；闸链完成后 BE 原位重发同 seq 带 tier，徽章原位更新、不闪烁。
// 🔴 与一期「旧线程恢复无 tier 按只说好兜底」的区分：恢复帧（partial 不为 true）里无 tier =
// 历史定稿、走兜底沉默；只有增量帧（partial===true）里无 tier 才是「验算中」过渡态。
const isChecking = computed(() => {
  if (props.item.tier === 'checking') return true // 向前兼容：BE 显式标过渡
  return props.item.tier === null && props.checking === true
})

const verifyBadge = computed(() => {
  if (isChecking.value) return null // 过渡态由独立呼吸徽章承担，不走此 computed
  const t = props.item.tier
  // 题组编辑器：手动编辑后 BE 置 tier='manual'（验算待重跑）→ 中性徽章，不出 ✓/⚠ 误导
  if (t === 'manual') return { cls: 'vb-manual', text: '✎ 手动编辑（验算待重跑）' }
  if (t === 'verified') return { cls: 'vb-green', text: '✓ 程序验算通过' }
  if (t === 'self_ok') return { cls: 'vb-green', text: '✓ 已独立复算一致' }
  if (t === 'proof') return { cls: 'vb-violet', text: 'ℹ 转人工复核' }
  if (t === 'both_low') return { cls: 'vb-amber', text: '⚠ 需重点核对' }
  if (t === 'silent') return null
  // 旧数据无 tier（且非增量过渡）：按「只说好」兜底——只外显正面/中性，其余沉默
  const v = props.item.verify
  if (v === 'sympy_pass') return { cls: 'vb-green', text: '✓ 程序验算通过' }
  if (v === 'proof_needs_human') return { cls: 'vb-violet', text: 'ℹ 转人工复核' }
  return null
})

const geneBadge = computed(() => {
  // 4d：只说好——warn 等负面值一律沉默（双闸低由 verifyBadge 的 ⚠ 承担）
  return props.item.gene === 'pass' ? { cls: 'gb-teal', text: '平行度 ✓' } : null
})

// PRD-C-013 P8：难度按数值渲染星级。上限动态（存量库题可能 5，新生成题 1-4）——
// 满格 = max(difficulty, 5)，实心 = difficulty，空星补足；title 仍给「难度 N」文本可读。
const difficultyStars = computed(() => {
  const d = props.item.difficulty
  if (!(d > 0)) return null
  const filled = Math.round(d)
  const total = Math.max(filled, 5)
  return {
    full: filled,
    empty: total - filled,
    title: `难度 ${d}`,
  }
})

function knob(text: string) {
  if (props.sending) return
  emit('utterance', text)
}

// ---------------------------------------------------------------------------
// PRD-C-015 批5 — DNA 改→重生四分流（徽章 + dirty 角标 + 重生/撤销）。
// ---------------------------------------------------------------------------
/** 本题脏维集合 = 自身改的 dirtyDims ∪ 母题守恒维波及的 motherDirtyDims（D-merge8 合并） */
const allDirtyDims = computed(() => {
  const s = new Set<string>([...props.item.dirtyDims, ...props.item.motherDirtyDims])
  return s
})
/** 本题是否脏（有待重生维或母题脏波及）→ 禁入库 + 显「重生」按钮 */
const isDirty = computed(() => props.item.dnaDirty || allDirtyDims.value.size > 0)
/** 某维是否在脏集合里（FE 在该维旁打「待重生⏳」角标） */
function dimDirty(field: DnaField): boolean {
  return allDirtyDims.value.has(field)
}
/** 某维的 regen_class 徽章（标注改后行为：硬锚/软重生/重写解析/只标注） */
function classBadge(field: DnaField): { cls: RegenClass; label: string; hint: string } {
  const cls = regenClassOf(field)
  return { cls, ...REGEN_CLASS_BADGE[cls] }
}

// 🔴 PRD-C-017 B5：「重生这道」始终可点（不再限 dirty）—— 按当前改好的字段重出本题。
function onRegen() {
  if (props.sending || props.regenerating) return
  emit('regen', props.item.index)
}
function onUndoRegen() {
  if (props.sending || props.regenerating || !props.item.canUndoRegen) return
  emit('undo-regen', props.item.index)
}

// ---------------------------------------------------------------------------
// PRD-C-014 T2 — 题目 DNA 面板（默认收起 = 🧬 chip；点开展开全维，老师可逐维改）。
// ---------------------------------------------------------------------------
const dnaOpen = ref(false)
const dna = computed(() => props.item.dna)

// 难度档位中文（与 22-SSOT §2 四档 rubric 对齐，难度 1-4） — 星级旁不再放层级文字（G13 ④）
const DIFFICULTY_LABEL = ['', '送分', '常规', '多步综合', '压轴']
function difficultyLabel(n: number): string {
  const r = Math.round(n)
  return r >= 1 && r <= 4 ? DIFFICULTY_LABEL[r] : ''
}

// 题型/考察类型枚举（DNA 面板下拉）
const qtypeOptions = QTYPE_OPTIONS
const examTypeOptions = EXAM_TYPES

// ---- T3：主考点 / 副考点（知识点树弹层）----
const kpDialog = ref<false | 'main' | 'secondary'>(false)
const kpDialogMode = computed<'single' | 'multi'>(() =>
  kpDialog.value === 'secondary' ? 'multi' : 'single'
)
function openKpDialog(which: 'main' | 'secondary') {
  if (props.sending) return
  kpDialog.value = which
}
function onPickMainKp(value: { id: string; name: string }) {
  emit('edit-dna', { index: props.item.index, field: 'main_kp', value })
  kpDialog.value = false
}
function onPickSecondaryKps(value: Array<{ id: string; name: string }>) {
  emit('edit-dna', { index: props.item.index, field: 'secondary_kps', value })
  kpDialog.value = false
}

// ---- T3：题型 / 考察类型（枚举下拉，选即提交）----
function onPickQtype(v: string) {
  if (!v || v === props.item.qtype) return
  emit('edit-dna', { index: props.item.index, field: 'qtype', value: v })
}
function onPickExamType(v: string) {
  if (!v || v === dna.value.examType) return
  emit('edit-dna', { index: props.item.index, field: 'exam_type', value: v })
}

// ---- T3：难度点星覆盖（1-4，老师覆盖优先级最高）----
function onPickDifficulty(n: number) {
  if (props.sending) return
  if (n < 1 || n > 4) return
  if (Math.round(props.item.difficulty) === n) return
  emit('edit-dna', { index: props.item.index, field: 'difficulty', value: n })
}

// ---- T3：标签多选弹层（候选 = tagsByKp（按主考点）+ 手输补充）----
const tagPopover = ref(false)
const tagCandidates = ref<string[]>([])
const tagLoading = ref(false)
const tagDraft = ref<string[]>([]) // 当前编辑中的标签集合（含已选 + 候选勾选）
const tagInput = ref('') // 手输补充框

async function openTagPopover() {
  if (props.sending) return
  tagDraft.value = [...dna.value.tags]
  tagPopover.value = true
  // 候选按当前主考点 id 取（无 id → 跳过，仅手输）
  const kpId = dna.value.mainKpId
  if (!kpId) {
    tagCandidates.value = []
    return
  }
  tagLoading.value = true
  try {
    const raw = await fetchTagsByKp(kpId, 50)
    tagCandidates.value = normalizeTagList(raw)
  } catch {
    tagCandidates.value = [] // 候选拉取失败不阻塞，仍可手输（不静默崩）
  } finally {
    tagLoading.value = false
  }
}

/** 宽松归一候选标签：吃 string[] 或 {name}[] */
function normalizeTagList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const x of raw) {
    if (typeof x === 'string' && x.trim()) out.push(x.trim())
    else if (x && typeof x === 'object') {
      const n = (x as Record<string, unknown>).name
      if (typeof n === 'string' && n.trim()) out.push(n.trim())
    }
  }
  return out
}

function toggleTag(tag: string) {
  const i = tagDraft.value.indexOf(tag)
  if (i >= 0) tagDraft.value.splice(i, 1)
  else tagDraft.value.push(tag)
}
function addManualTag() {
  const t = tagInput.value.trim()
  if (!t) return
  if (!tagDraft.value.includes(t)) tagDraft.value.push(t)
  tagInput.value = ''
}
function removeDraftTag(tag: string) {
  tagDraft.value = tagDraft.value.filter((t) => t !== tag)
}
function saveTags() {
  emit('edit-dna', { index: props.item.index, field: 'tags', value: [...tagDraft.value] })
  tagPopover.value = false
}

// ---- PRD-C-015 批5：models 维（解题模型 chips + 编辑弹层）----
// 归 rewrite_solve 视觉档（改 models = 换解法 = 重写解析过闸B，置 dirty）。
// 候选无专用接口（BE 反查池未透传到 FE）→ 弹层支持移除已有 + 手输补充（与 tags 同模式）。
const modelPopover = ref(false)
const modelDraft = ref<Array<{ id: string; name: string }>>([])
const modelInput = ref('')
function openModelPopover() {
  if (props.sending) return
  modelDraft.value = props.item.dna.models.map((m) => ({ ...m }))
  modelPopover.value = true
}
function removeDraftModel(id: string) {
  modelDraft.value = modelDraft.value.filter((m) => m.id !== id)
}
function addManualModel() {
  const t = modelInput.value.trim()
  if (!t) return
  // 手输模型名：id=name（BE 归一时按名匹配词库；池外名走待命名池 ⚠，不阻断）
  if (!modelDraft.value.some((m) => m.name === t || m.id === t)) {
    modelDraft.value.push({ id: t, name: t })
  }
  modelInput.value = ''
}
function saveModels() {
  emit('edit-models', { index: props.item.index, value: modelDraft.value.map((m) => ({ ...m })) })
  modelPopover.value = false
}

// ---------------------------------------------------------------------------
// 🔴 PRD-C-017 B5：场景 / 解法骨架改为「点击直改」（inline 文本编辑），去掉原 C-015 的
//   「说一句改」自然语言 revise 框 + 整卡「重做这题」whole revise。
//   保存 → emit('edit-dna', field='scene'/'skeleton', value=string)（结构化字段，宿主走
//   editVariantDna 落 toolkit 会话 state；scene=soft_regen / skeleton=rewrite_solve，改后标
//   dirty，点「重生这道」按新 DNA 重出）—— 复用既有 edit-dna 端点，不新造、不动底层状态机。
// ---------------------------------------------------------------------------
const editingField = ref<null | 'scene' | 'skeleton'>(null)
const fieldDraft = ref('')
function openFieldEdit(field: 'scene' | 'skeleton') {
  if (props.sending || props.reverifying) return
  editingField.value = field
  fieldDraft.value =
    field === 'scene' ? props.item.dna.scene || '' : props.item.dna.skeleton || ''
}
function cancelFieldEdit() {
  editingField.value = null
  fieldDraft.value = ''
}
function saveFieldEdit() {
  const field = editingField.value
  if (!field) return
  const v = fieldDraft.value.trim()
  const cur = (field === 'scene' ? props.item.dna.scene : props.item.dna.skeleton) || ''
  if (v === cur) {
    cancelFieldEdit()
    return
  }
  emit('edit-dna', { index: props.item.index, field, value: v })
  cancelFieldEdit()
}
</script>

<template>
  <article
    class="variant-card"
    :class="{ 'is-persisted': item.persisted, 'is-editing': editing, 'is-reverifying': reverifying }"
  >
    <!-- 卡头：题号圆 + 题型 + 可点星级（难度覆盖） + 验证角标（右上）
         G13 ④：星级旁不放层级文字标签（常规/提高/压轴字样删） -->
    <header class="card-head">
      <span class="seq">{{ item.index }}</span>
      <span v-if="item.qtype" class="meta-tag">{{ item.qtype }}</span>
      <!-- 可点星级：点第 n 颗 = 把难度覆盖成 n（1-4），老师覆盖优先级最高 -->
      <span v-if="difficultyStars" class="diff-stars" :title="`${difficultyStars.title}（点星可改）`">
        <span
          v-for="n in 4"
          :key="`s${n}`"
          class="star is-click"
          :class="n <= Math.round(item.difficulty) ? 'is-full' : 'is-empty'"
          @click="onPickDifficulty(n)"
        >{{ n <= Math.round(item.difficulty) ? '★' : '☆' }}</span>
      </span>
      <span class="head-spacer" />
      <!-- PRD-C-015 批5：待重生角标（dirty 题改了还没重生）→ 醒目 amber，提示先重生 -->
      <span
        v-if="isDirty"
        class="dirty-tag"
        :title="`改了 ${[...allDirtyDims].join('、')}，点「重生」按新 DNA 重出（重生前入库会被拦）`"
      >⏳ 待重生</span>
      <span v-if="item.manualEdited" class="manual-tag" title="本题有维度被手动编辑过">✎ 手动编辑</span>
      <span v-if="item.persisted" class="persisted-tag">已收录</span>
      <span v-if="geneBadge" class="gene-badge" :class="geneBadge.cls">{{ geneBadge.text }}</span>
      <!-- 重新验算中：徽章位展示 loading 态 -->
      <span v-if="reverifying" class="verify-badge vb-checking">
        <span class="check-dot" />重新验算中…
      </span>
      <!-- P2b 过渡态：闸链未完成（增量帧无 tier）→ 呼吸「验算中…」，不出 ✓/⚠ -->
      <span v-else-if="isChecking" class="verify-badge vb-checking">
        <span class="check-dot" />验算中…
      </span>
      <span v-else-if="verifyBadge" class="verify-badge" :class="verifyBadge.cls">
        {{ verifyBadge.text }}
      </span>
    </header>

    <!-- ============ 编辑态：按题型拆字段 + 实时 MarkdownMath 预览 + 智能输入（失焦转 LaTeX） ============ -->
    <template v-if="editing">
      <p class="smart-hint">
        智能输入：直接敲自然写法（2/5、x^2、sqrt3、&lt;=），失焦自动转公式，预览立等可见
      </p>

      <!-- ---------- 选择题：题干 + 选项A-D + 答案下拉 ---------- -->
      <template v-if="editKind === 'choice'">
        <div class="edit-field">
          <div class="edit-label-row">
            <span class="edit-label">题干</span>
            <span class="edit-hint">以「（ ）」收尾，保存自动补</span>
          </div>
          <div class="edit-pair">
            <el-input
              v-model="choiceDraft.stem"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 10 }"
              resize="none"
              placeholder="题干（如：下列各数中最小的是）"
              @blur="smartChoiceStem"
            />
            <div class="edit-preview">
              <span class="preview-tag">预览</span>
              <MarkdownMath :content="choiceDraft.stem" />
            </div>
          </div>
        </div>

        <div class="edit-field">
          <span class="edit-label">选项</span>
          <div v-for="(opt, i) in choiceDraft.options" :key="`opt${i}`" class="choice-opt-row">
            <span class="opt-letter">{{ CHOICE_LETTERS[i] }}</span>
            <div class="edit-pair opt-pair">
              <el-input
                v-model="choiceDraft.options[i]"
                type="textarea"
                :autosize="{ minRows: 1, maxRows: 4 }"
                resize="none"
                :placeholder="`选项 ${CHOICE_LETTERS[i]}`"
                @blur="smartChoiceOption(i)"
              />
              <div class="edit-preview opt-preview">
                <MarkdownMath :content="opt || ' '" />
              </div>
            </div>
          </div>
        </div>

        <div class="edit-field">
          <span class="edit-label">答案</span>
          <el-select
            v-model="choiceDraft.answer"
            placeholder="选择正确选项"
            class="ans-select"
            clearable
          >
            <el-option v-for="l in CHOICE_LETTERS" :key="l" :label="l" :value="l" />
          </el-select>
        </div>
      </template>

      <!-- ---------- 填空题：题干（含 ____）+ 答案 ---------- -->
      <template v-else-if="editKind === 'blank'">
        <div class="edit-field">
          <div class="edit-label-row">
            <span class="edit-label">题干</span>
            <span class="edit-hint">空位用 ____（4 下划线）</span>
            <button type="button" class="norm-btn" @click="normalize">规范排版</button>
          </div>
          <div class="edit-pair">
            <el-input
              v-model="draft.stem"
              type="textarea"
              :autosize="{ minRows: 3, maxRows: 12 }"
              resize="none"
              placeholder="题干（含空位 ____）"
              @blur="smartDraftStem"
            />
            <div class="edit-preview">
              <span class="preview-tag">预览</span>
              <MarkdownMath :content="draft.stem" />
            </div>
          </div>
        </div>
        <div class="edit-field">
          <span class="edit-label">答案</span>
          <div class="edit-pair">
            <el-input
              v-model="draft.answer"
              type="textarea"
              :autosize="{ minRows: 1, maxRows: 6 }"
              resize="none"
              placeholder="答案（多空用分号隔开）"
              @blur="smartDraftAnswer"
            />
            <div class="edit-preview">
              <span class="preview-tag">预览</span>
              <MarkdownMath :content="draft.answer" />
            </div>
          </div>
        </div>
      </template>

      <!-- ---------- 判断题：题干 + 答案下拉(对/错) ---------- -->
      <template v-else-if="editKind === 'judge'">
        <div class="edit-field">
          <div class="edit-label-row">
            <span class="edit-label">题干</span>
            <button type="button" class="norm-btn" @click="normalize">规范排版</button>
          </div>
          <div class="edit-pair">
            <el-input
              v-model="draft.stem"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 10 }"
              resize="none"
              placeholder="题干（尾部会补判断括号）"
              @blur="smartDraftStem"
            />
            <div class="edit-preview">
              <span class="preview-tag">预览</span>
              <MarkdownMath :content="draft.stem" />
            </div>
          </div>
        </div>
        <div class="edit-field">
          <span class="edit-label">答案</span>
          <el-select v-model="draft.answer" placeholder="对 / 错" class="ans-select" clearable>
            <el-option v-for="o in JUDGE_OPTIONS" :key="o" :label="o" :value="o" />
          </el-select>
        </div>
      </template>

      <!-- ---------- 解答/兜底：题干/答案/解析三段（不拆小问） ---------- -->
      <template v-else>
        <div class="edit-field">
          <div class="edit-label-row">
            <span class="edit-label">题干</span>
            <button type="button" class="norm-btn" @click="normalize">规范排版</button>
          </div>
          <div class="edit-pair">
            <el-input
              v-model="draft.stem"
              type="textarea"
              :autosize="{ minRows: 3, maxRows: 12 }"
              resize="none"
              placeholder="题干（支持 markdown + LaTeX，多小问保留）"
              @blur="smartDraftStem"
            />
            <div class="edit-preview">
              <span class="preview-tag">预览</span>
              <MarkdownMath :content="draft.stem" />
            </div>
          </div>
        </div>
        <div class="edit-field">
          <span class="edit-label">答案</span>
          <div class="edit-pair">
            <el-input
              v-model="draft.answer"
              type="textarea"
              :autosize="{ minRows: 1, maxRows: 6 }"
              resize="none"
              placeholder="答案"
              @blur="smartDraftAnswer"
            />
            <div class="edit-preview">
              <span class="preview-tag">预览</span>
              <MarkdownMath :content="draft.answer" />
            </div>
          </div>
        </div>
      </template>

      <!-- 解析：所有题型都给（解答题尤其需要；选择/填空/判断也可补充） -->
      <div class="edit-field">
        <span class="edit-label">解析</span>
        <div class="edit-pair">
          <el-input
            v-model="draft.solution"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 12 }"
            resize="none"
            placeholder="解析（可选）"
            @blur="smartDraftSolution"
          />
          <div class="edit-preview">
            <span class="preview-tag">预览</span>
            <MarkdownMath :content="draft.solution" />
          </div>
        </div>
      </div>

      <footer class="edit-actions">
        <button type="button" class="edit-cancel" @click="cancelEdit">取消</button>
        <button type="button" class="edit-save" @click="saveEdit">保存</button>
      </footer>
    </template>

    <!-- ============ 展示态 ============ -->
    <template v-else>
      <!-- 题干（KaTeX 富文本）：选择题拆题干 + 自适应选项网格（短 2×2 / 长单列），
           解析不出 → 回退整段 MarkdownMath（与编辑框一致：存储仍一行一项） -->
      <div class="card-stem">
        <template v-if="displayChoice">
          <MarkdownMath :content="displayChoice.stem" />
          <ul class="choice-grid" :class="{ 'is-two-col': displayChoice.twoCol }">
            <li
              v-for="opt in displayChoice.options"
              :key="opt.letter"
              class="choice-item"
              :class="{ 'is-answer': displayChoice.answer && opt.letter === displayChoice.answer }"
            >
              <span class="choice-letter">{{ opt.letter }}</span>
              <MarkdownMath class="choice-content" :content="opt.content || ' '" />
            </li>
          </ul>
        </template>
        <MarkdownMath v-else :content="item.stem" />
      </div>

      <!-- ============ 🧬 题目 DNA（G13 ③：默认收起 = 图标 chip；点开展开全维，逐维可改） ============ -->
      <div class="dna-zone">
        <button type="button" class="dna-chip" :class="{ open: dnaOpen }" @click="dnaOpen = !dnaOpen">
          <span class="dna-spiral">🧬</span>题目 DNA
          <span class="dna-caret">{{ dnaOpen ? '▴' : '▾' }}</span>
        </button>

        <div v-if="dnaOpen" class="dna-panel">
          <div class="dna-top">
            <span class="dna-note">老师可改任意一维 · 你说了算</span>
          </div>
          <!-- 组级 vs 单题级维度作用域说明（PRD-C-014 上线硬条件）：守恒维改全组，题型/难度仅本题 -->
          <p class="dna-scope-hint">
            考点 / 考察类型 / 标签 / 场景为整组共享维度，修改将对全组生效；题型与难度仅作用于本题
          </p>

          <div class="dna-grid">
            <!-- 主考点（hard_anchor：改→立即解冻重锚） -->
            <span class="dna-k">
              主考点
              <span class="rc-badge" :class="`rc-${classBadge('main_kp').cls}`" :title="classBadge('main_kp').hint">{{ classBadge('main_kp').label }}</span>
            </span>
            <span class="dna-v">
              <button type="button" class="kp-pill" :disabled="sending" @click="openKpDialog('main')">
                {{ dna.mainKp || '未标 · 点选' }}<span class="pill-edit">✎</span>
              </button>
              <span v-if="dimDirty('main_kp')" class="dim-dirty">待重生⏳</span>
            </span>

            <!-- 副考点（meta：只标注即时生效） -->
            <span class="dna-k">
              副考点
              <span class="rc-badge" :class="`rc-${classBadge('secondary_kps').cls}`" :title="classBadge('secondary_kps').hint">{{ classBadge('secondary_kps').label }}</span>
            </span>
            <span class="dna-v">
              <template v-if="dna.secondaryKps.length">
                <span v-for="kp in dna.secondaryKps" :key="kp" class="kp-pill sec">{{ kp }}</span>
              </template>
              <button type="button" class="dna-min-btn" :disabled="sending" @click="openKpDialog('secondary')">
                {{ dna.secondaryKps.length ? '改' : '＋ 选副考点' }}
              </button>
            </span>

            <!-- 题型（soft_regen：改→待重生，点重生统一重出） -->
            <span class="dna-k">
              题型
              <span class="rc-badge" :class="`rc-${classBadge('qtype').cls}`" :title="classBadge('qtype').hint">{{ classBadge('qtype').label }}</span>
            </span>
            <span class="dna-v">
              <el-select
                :model-value="item.qtype || ''"
                size="small"
                placeholder="选题型"
                class="dna-select"
                :disabled="sending"
                @change="onPickQtype"
              >
                <el-option v-for="q in qtypeOptions" :key="q" :label="q" :value="q" />
              </el-select>
              <span v-if="dimDirty('qtype')" class="dim-dirty">待重生⏳</span>
            </span>

            <!-- 考察类型（soft_regen：改→待重生） -->
            <span class="dna-k">
              考察类型
              <span class="rc-badge" :class="`rc-${classBadge('exam_type').cls}`" :title="classBadge('exam_type').hint">{{ classBadge('exam_type').label }}</span>
            </span>
            <span class="dna-v">
              <el-select
                :model-value="dna.examType || ''"
                size="small"
                placeholder="选考察类型"
                class="dna-select"
                :disabled="sending"
                @change="onPickExamType"
              >
                <el-option v-for="t in examTypeOptions" :key="t" :label="t" :value="t" />
              </el-select>
              <span v-if="dimDirty('exam_type')" class="dim-dirty">待重生⏳</span>
            </span>

            <!-- 难度（soft_regen：点星覆盖，改→待重生；这里给文字档位） -->
            <span class="dna-k">
              难度
              <span class="rc-badge" :class="`rc-${classBadge('difficulty').cls}`" :title="classBadge('difficulty').hint">{{ classBadge('difficulty').label }}</span>
            </span>
            <span class="dna-v dna-diff">
              <span class="diff-stars-inline">
                <span
                  v-for="n in 4"
                  :key="`ds${n}`"
                  class="star is-click"
                  :class="n <= Math.round(item.difficulty) ? 'is-full' : 'is-empty'"
                  @click="onPickDifficulty(n)"
                >{{ n <= Math.round(item.difficulty) ? '★' : '☆' }}</span>
              </span>
              <span class="diff-label">{{ difficultyLabel(item.difficulty) }}（{{ Math.round(item.difficulty) }}）</span>
              <span v-if="dimDirty('difficulty')" class="dim-dirty">待重生⏳</span>
            </span>

            <!-- 场景（soft_regen：点击-说话改 / 改→待重生） -->
            <span class="dna-k">
              场景
              <span class="rc-badge" :class="`rc-${classBadge('scene').cls}`" :title="classBadge('scene').hint">{{ classBadge('scene').label }}</span>
            </span>
            <span class="dna-v dna-full">
              <!-- 🔴 PRD-C-017 B5：场景点击直改（去「说一句改」自然语言框） -->
              <template v-if="editingField !== 'scene'">
                <span class="dna-text">{{ dna.scene || '未标' }}</span>
                <span v-if="dimDirty('scene')" class="dim-dirty">待重生⏳</span>
                <button type="button" class="dna-min-btn" :disabled="sending || reverifying" @click="openFieldEdit('scene')">
                  改
                </button>
              </template>
              <div v-else class="inline-edit-box">
                <el-input
                  v-model="fieldDraft"
                  type="textarea"
                  :autosize="{ minRows: 1, maxRows: 3 }"
                  resize="none"
                  placeholder="场景（如：行程问题 / 纯代数；改后点「重生这道」按新场景重出）"
                  @keyup.enter.exact.prevent="saveFieldEdit"
                />
                <div class="inline-edit-actions">
                  <button type="button" class="inline-cancel" @click="cancelFieldEdit">取消</button>
                  <button type="button" class="inline-save" @click="saveFieldEdit">保存</button>
                </div>
              </div>
            </span>

            <!-- 解法骨架（rewrite_solve：改→重写解析过闸B；【】包最难步） -->
            <span class="dna-k">
              解法骨架
              <span class="rc-badge" :class="`rc-${classBadge('skeleton').cls}`" :title="classBadge('skeleton').hint">{{ classBadge('skeleton').label }}</span>
            </span>
            <span class="dna-v dna-full">
              <!-- 🔴 PRD-C-017 B5：解法骨架点击直改（去「说一句改」自然语言框；【】包最难步） -->
              <template v-if="editingField !== 'skeleton'">
                <span class="dna-text skel"><MarkdownMath :content="dna.skeleton || '未标'" /></span>
                <span v-if="dimDirty('skeleton')" class="dim-dirty">待重生⏳</span>
                <button type="button" class="dna-min-btn" :disabled="sending || reverifying" @click="openFieldEdit('skeleton')">
                  改
                </button>
              </template>
              <div v-else class="inline-edit-box">
                <el-input
                  v-model="fieldDraft"
                  type="textarea"
                  :autosize="{ minRows: 2, maxRows: 6 }"
                  resize="none"
                  placeholder="解法骨架（【】包最难步基因；改它=换基因，点「重生这道」重写解析过闸B）"
                />
                <div class="inline-edit-actions">
                  <button type="button" class="inline-cancel" @click="cancelFieldEdit">取消</button>
                  <button type="button" class="inline-save" @click="saveFieldEdit">保存</button>
                </div>
              </div>
            </span>

            <!-- PRD-C-015 块②：解题模型（rewrite_solve：「怎么解」轴；chips 展示 + 列表选可改） -->
            <span class="dna-k">
              模型
              <span class="rc-badge" :class="`rc-${classBadge('models').cls}`" :title="classBadge('models').hint">{{ classBadge('models').label }}</span>
            </span>
            <span class="dna-v dna-full">
              <template v-if="dna.models.length">
                <span v-for="m in dna.models" :key="m.id" class="model-pill">{{ m.name || m.id }}</span>
              </template>
              <span v-else class="dna-muted">未标</span>
              <span v-if="dimDirty('models')" class="dim-dirty">待重生⏳</span>
              <el-popover :visible="modelPopover" placement="bottom-start" :width="300" trigger="manual">
                <template #reference>
                  <button type="button" class="dna-min-btn" :disabled="sending" @click="openModelPopover">
                    {{ dna.models.length ? '改模型' : '＋ 加模型' }}
                  </button>
                </template>
                <div class="tag-pop">
                  <p class="tag-pop-title">已选模型（点 ✕ 移除）</p>
                  <div class="tag-pop-chosen">
                    <span v-for="m in modelDraft" :key="m.id" class="model-pill is-chosen" @click="removeDraftModel(m.id)">
                      {{ m.name || m.id }} ✕
                    </span>
                    <span v-if="!modelDraft.length" class="dna-muted">暂无（保存=兜底概念直用 M00）</span>
                  </div>
                  <div class="tag-pop-input">
                    <el-input
                      v-model="modelInput"
                      size="small"
                      placeholder="手输模型名，回车补充（池外名走待审，不阻断）"
                      @keyup.enter.prevent="addManualModel"
                    />
                    <el-button size="small" @click="addManualModel">加</el-button>
                  </div>
                  <p class="tag-pop-note">改模型 = 换解法 → 重写解析（点「重生」生效）</p>
                  <div class="tag-pop-actions">
                    <el-button size="small" @click="modelPopover = false">取消</el-button>
                    <el-button size="small" type="primary" @click="saveModels">保存</el-button>
                  </div>
                </div>
              </el-popover>
            </span>

            <!-- 难点（meta：只标注，基础题为空；改随骨架/整卡 revise 联动） -->
            <span class="dna-k">
              难点
              <span class="rc-badge" :class="`rc-${classBadge('hard_points').cls}`" :title="classBadge('hard_points').hint">{{ classBadge('hard_points').label }}</span>
            </span>
            <span class="dna-v dna-full">
              <template v-if="dna.hardPoints.length">
                <span v-for="hp in dna.hardPoints" :key="hp" class="hard-pill">{{ hp }}</span>
              </template>
              <span v-else class="dna-muted">无（基础题 · 宁空不凑）</span>
            </span>

            <!-- 标签（meta：多选弹层 = tagsByKp 候选 + 手输补充） -->
            <span class="dna-k">
              标签
              <span class="rc-badge" :class="`rc-${classBadge('tags').cls}`" :title="classBadge('tags').hint">{{ classBadge('tags').label }}</span>
            </span>
            <span class="dna-v dna-full">
              <template v-if="dna.tags.length">
                <span v-for="t in dna.tags" :key="t" class="ftag">{{ t }}</span>
              </template>
              <span v-else class="dna-muted">未标</span>
              <el-popover
                :visible="tagPopover"
                placement="bottom-start"
                :width="300"
                trigger="manual"
              >
                <template #reference>
                  <button type="button" class="dna-min-btn" :disabled="sending" @click="openTagPopover">
                    {{ dna.tags.length ? '改标签' : '＋ 加标签' }}
                  </button>
                </template>
                <div class="tag-pop">
                  <p class="tag-pop-title">已选（点 ✕ 移除）</p>
                  <div class="tag-pop-chosen">
                    <span v-for="t in tagDraft" :key="t" class="ftag is-chosen" @click="removeDraftTag(t)">
                      {{ t }} ✕
                    </span>
                    <span v-if="!tagDraft.length" class="dna-muted">暂无</span>
                  </div>
                  <div class="tag-pop-input">
                    <el-input
                      v-model="tagInput"
                      size="small"
                      placeholder="手输标签，回车补充"
                      @keyup.enter.prevent="addManualTag"
                    />
                    <el-button size="small" @click="addManualTag">加</el-button>
                  </div>
                  <p class="tag-pop-title">候选（按主考点）</p>
                  <div v-loading="tagLoading" class="tag-pop-cands">
                    <span
                      v-for="c in tagCandidates"
                      :key="c"
                      class="ftag is-cand"
                      :class="{ 'is-picked': tagDraft.includes(c) }"
                      @click="toggleTag(c)"
                    >
                      {{ c }}
                    </span>
                    <span v-if="!tagLoading && !tagCandidates.length" class="dna-muted">
                      无候选（可手输补充）
                    </span>
                  </div>
                  <div class="tag-pop-actions">
                    <el-button size="small" @click="tagPopover = false">取消</el-button>
                    <el-button size="small" type="primary" @click="saveTags">保存</el-button>
                  </div>
                </div>
              </el-popover>
            </span>
          </div>
        </div>
      </div>

      <!-- 解析折叠（默认收起，内含答案 + 解析） -->
      <div class="solution-block">
        <button type="button" class="solution-toggle" @click="showSolution = !showSolution">
          解析 {{ showSolution ? '▴' : '▾' }}
        </button>
        <div v-if="showSolution" class="solution-body">
          <p v-if="item.answer" class="solution-label">答案</p>
          <MarkdownMath v-if="item.answer" :content="item.answer" />
          <p v-if="item.solution" class="solution-label">解析</p>
          <MarkdownMath v-if="item.solution" :content="item.solution" />
          <p v-if="!item.answer && !item.solution" class="solution-empty">本题暂无解析内容</p>
        </div>
      </div>

      <!-- PRD-C-015 批5：dirty 题入库拦截提示（致命①新不变量，前端先拦给体验，后端硬闸兜底） -->
      <div v-if="isDirty" class="dirty-block-hint">
        本题改了「{{ [...allDirtyDims].join('、') }}」还没重生，先点下方「重生」按新 DNA 重出，或「撤销重生」回上一版，才能入库 / 加试题篮。
      </div>

      <!-- 入库行：收录入库（T1）+ 加入试题篮（T2）—— PRD-C-015 批5：dirty 题禁用（致命①） -->
      <footer class="bank-row">
        <!-- T1：已收录 → 按钮置「已收录」禁用态（重复点不重复发）；未收录 → teal 实心「收录入库」 -->
        <button
          type="button"
          class="bank-btn is-persist"
          :class="{ 'is-done': item.persisted }"
          :disabled="item.persisted || persisting || basketing || sending || isDirty"
          :title="isDirty ? '改了还没重生，先点「重生」或「撤销重生」' : ''"
          @click="!item.persisted && !isDirty && emit('persist-one', item.index)"
        >
          <template v-if="item.persisted">✓ 已收录</template>
          <template v-else-if="persisting">收录中…</template>
          <template v-else>收录入库</template>
        </button>
        <!-- T2：加入试题篮 —— PRD-C-015 批5：dirty 题禁用（与入库同口径） -->
        <button
          type="button"
          class="bank-btn is-basket"
          :disabled="basketing || persisting || sending || isDirty"
          :title="isDirty ? '改了还没重生，先点「重生」或「撤销重生」' : ''"
          @click="!isDirty && emit('add-to-basket', item.index)"
        >
          {{ basketing ? '加入中…' : '加入试题篮' }}
        </button>
      </footer>

      <!-- 旋钮行：编辑 + 重生/撤销重生 +（手动编辑后）重新验算 + 卡片快捷键 utterance -->
      <footer class="knob-row">
        <!-- 🔴 PRD-C-017 B5：「重生这道」始终可点（按当前改好的字段重出本题；复用 regen 通路） -->
        <button
          type="button"
          class="knob-btn is-regen"
          :disabled="sending || regenerating"
          @click="onRegen"
        >
          {{ regenerating ? '重生中…' : '🔄 重生这道' }}
        </button>
        <!-- PRD-C-015 批5：撤销重生（缺口12，重生过有快照才显示）→ 回上一版 -->
        <button
          v-if="item.canUndoRegen"
          type="button"
          class="knob-btn is-undo"
          :disabled="sending || regenerating"
          @click="onUndoRegen"
        >
          ↩ 撤销重生
        </button>
        <button
          type="button"
          class="knob-btn is-edit"
          :disabled="sending || reverifying"
          @click="startEdit"
        >
          编辑
        </button>
        <button
          v-if="isManual"
          type="button"
          class="knob-btn is-reverify"
          :disabled="sending || reverifying"
          @click="emit('reverify', item.index)"
        >
          {{ reverifying ? '验算中…' : '重新验算' }}
        </button>
        <button
          type="button"
          class="knob-btn"
          :disabled="sending"
          @click="knob(`第${item.index}题换个数字重出`)"
        >
          换数字
        </button>
        <button
          type="button"
          class="knob-btn"
          :disabled="sending"
          @click="knob(`第${item.index}题换个场景重出`)"
        >
          换场景
        </button>
        <button
          type="button"
          class="knob-btn"
          :disabled="sending"
          @click="knob(`第${item.index}题为什么这么解？`)"
        >
          答疑
        </button>
      </footer>
    </template>

    <!-- T3：知识点树弹层（主考点单选 / 副考点多选，与 dnaOpen 无关，按需挂载） -->
    <KpTreeDialog
      :model-value="kpDialog !== false"
      :mode="kpDialogMode"
      :title="kpDialog === 'secondary' ? '选择副考点（≤3）' : '选择主考点'"
      :max="3"
      :preselected="[]"
      @update:model-value="(v: boolean) => { if (!v) kpDialog = false }"
      @pick="onPickMainKp"
      @pick-multi="onPickSecondaryKps"
    />
  </article>
</template>

<style scoped>
/* DESIGN token：card #FFF / border #E3E9E9 / ink-900 #1D2A2E / teal-600 #1E8A8A
   green-600 #0E9F6E / amber-500 #E0A23C / violet-600 #7B6CF0 / violet-50 #F2F0FE */
/* G13 ②：卡片解剖顺序 = 顶部色条 → 题号/题型/星级 → 题干 → 选项 → 🧬 DNA chip → 解析 → 旋钮 */
.variant-card {
  position: relative;
  background: #fff;
  border: 1px solid #e7e3da;
  border-radius: 16px;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow: hidden;
  box-shadow: 0 1px 2px rgba(22, 48, 47, 0.05), 0 2px 8px rgba(22, 48, 47, 0.04);
  container-type: inline-size; /* 编辑态双栏的 @container 查询锚点 */
}
/* 顶部色条（深青渐变；已收录卡转 violet） */
.variant-card::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 3px;
  background: linear-gradient(90deg, #1e8a8a, #7fc0bd);
}
.variant-card.is-persisted {
  background: #efecfb; /* violet-50：已收录态弱高亮 */
  border-color: #6d5fd0;
}
.variant-card.is-persisted::before {
  background: linear-gradient(90deg, #6d5fd0, #b3a7f0);
}

.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.seq {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #1e8a8a; /* teal-600 */
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.meta-tag {
  font-size: 12px;
  color: #33464c; /* ink-700 */
  background: #edf2f2; /* bg-100 */
  border-radius: 6px;
  padding: 1px 8px;
}
.meta-tag.is-hard {
  color: #b8741a;
  background: #fbf1e0;
}
.head-spacer {
  flex: 1;
}

/* P8 难度星：实心 amber、空心淡灰，紧凑无间隙 */
.diff-stars {
  display: inline-flex;
  align-items: center;
  line-height: 1;
  font-size: 13px;
  letter-spacing: -1px;
  cursor: default;
}
.star.is-full {
  color: #b8741a; /* amber-600（v3 暖琥珀） */
}
.star.is-empty {
  color: #d9d3c6;
}
/* 可点星级（难度覆盖）：hover 提示可改 */
.star.is-click {
  cursor: pointer;
}
.star.is-click:hover {
  color: #b8741a;
}

/* 手动编辑徽章（任一 DNA 维被改过） */
.manual-tag {
  font-size: 12px;
  color: #5b6770;
  background: #eef1f3;
  border: 1px solid #d4dede;
  border-radius: 6px;
  padding: 1px 8px;
}

/* PRD-C-015 批5：待重生角标（卡头）——amber 醒目，提示先重生再入库 */
.dirty-tag {
  font-size: 12px;
  color: #b8741a;
  background: #fbeed6;
  border: 1px solid #ecc98f;
  border-radius: 6px;
  padding: 1px 8px;
  font-weight: 700;
}

/* 验证角标：⚠ 比 ✓ 醒目（实底白字 + ⚠ 加粗） */
.verify-badge {
  font-size: 12px;
  color: #fff;
  border-radius: 6px;
  padding: 2px 8px;
}
.vb-green {
  background: #0e9f6e; /* green-600 */
}
.vb-amber {
  background: #e0a23c; /* amber-500 */
  font-weight: 700;
}
.vb-red {
  background: #d9444b;
  font-weight: 700;
}
.vb-violet {
  background: #7b6cf0; /* violet-600 */
}
/* 手动编辑（验算待重跑）：中性灰底深字，不抢 ✓/⚠ 权重，暗示需重新验算 */
.vb-manual {
  background: #eef1f3;
  color: #5b6770;
  border: 1px solid #d4dede;
}
/* P2b 验算中过渡态：中性灰底 + 呼吸点，不抢 ✓/⚠ 的视觉权重 */
.vb-checking {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #5b6770;
  background: #edf2f2; /* bg-100 */
  animation: vb-breathe 1.4s infinite ease-in-out;
}
.check-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #7b6cf0; /* violet-600：AI 在场 */
}
@keyframes vb-breathe {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}

.gene-badge {
  font-size: 12px;
  border-radius: 6px;
  padding: 1px 8px;
}
.gb-teal {
  color: #176e6e; /* teal-700 */
  background: #e6f2f2; /* teal-50 */
}
.gb-amber {
  color: #b8741a;
  background: #fbf1e0;
  font-weight: 600;
}

.persisted-tag {
  font-size: 12px;
  color: #5b4fd6; /* violet-700 */
  background: #fff;
  border: 1px solid #7b6cf0;
  border-radius: 6px;
  padding: 1px 8px;
  font-weight: 600;
}

.card-stem {
  font-size: 14px;
  color: #1d2a2e; /* ink-900 */
}

/* 选择题展示：题干下选项网格。短选项 2 列（2×2），长选项单列（is-two-col 时才 2 列） */
.choice-grid {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  display: grid;
  grid-template-columns: 1fr;
  gap: 4px 18px;
}
.choice-grid.is-two-col {
  grid-template-columns: 1fr 1fr;
}
/* 卡片窄（<360px）时即便短选项也回退单列，避免挤压 */
@container (max-width: 360px) {
  .choice-grid.is-two-col {
    grid-template-columns: 1fr;
  }
}
.choice-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.choice-item.is-answer {
  background: #e6f2f2; /* teal-50：标出正确项 */
  border-radius: 6px;
  padding: 0 6px;
}
.choice-letter {
  font-weight: 700;
  color: #33464c; /* ink-700 */
  flex-shrink: 0;
}
.choice-item.is-answer .choice-letter {
  color: #176e6e; /* teal-700 */
}
.choice-content :deep(.md-math) {
  font-size: var(--md-font-size, 14px);
}
.choice-content :deep(p) {
  margin: 0;
}

/* ============ 🧬 题目 DNA（v3 设计语言：深青 + 暖纸白 + 暖琥珀） ============ */
.dna-zone {
  margin-top: 4px;
}
/* 收起态 = 图标 chip（深青 teal-50 底 + teal-700 字） */
.dna-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  font-weight: 600;
  color: #0f6e6e; /* teal-700 */
  background: #e7f3f1; /* teal-50 */
  border: 1px solid #cfe6e3;
  border-radius: 999px;
  padding: 5px 13px 5px 11px;
  cursor: pointer;
  transition: 0.15s;
}
.dna-chip:hover {
  background: #dcefec;
  border-color: #7fc0bd;
}
.dna-chip.open {
  background: #fff;
  border-color: #7fc0bd;
}
.dna-spiral {
  font-size: 13px;
}
.dna-caret {
  font-size: 10px;
  opacity: 0.7;
}

/* 展开态面板 */
.dna-panel {
  margin-top: 11px;
  background: #f7faf9;
  border: 1px solid #e7e3da; /* line */
  border-radius: 12px;
  padding: 13px 15px;
}
.dna-top {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 11px;
}
.dna-note {
  font-size: 11.5px;
  color: #0f6e6e;
  background: #e7f3f1;
  border-radius: 999px;
  padding: 2px 10px;
}
/* 组级 vs 单题级维度作用域说明（小号灰，轻量不抢） */
.dna-scope-hint {
  margin: -4px 0 11px;
  font-size: 11px;
  line-height: 1.5;
  color: #9fb0ad; /* ink-300 */
}
/* 维度网格：标签列 + 值列（窄屏单列） */
.dna-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 10px 14px;
  font-size: 13px;
  align-items: baseline;
}
.dna-k {
  color: #6b817e; /* ink-500 */
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

/* PRD-C-015 批5：四分流徽章（维度旁标注改后行为）。色系区分四类，hover title 给说明。 */
.rc-badge {
  font-size: 9.5px;
  line-height: 1.4;
  border-radius: 4px;
  padding: 0 5px;
  font-weight: 600;
  white-space: nowrap;
  cursor: help;
}
.rc-hard_anchor {
  /* 硬锚：深红描边（改=立即重锚，整组重出，最重） */
  color: #c0392b;
  background: #fdecea;
  border: 1px solid #f0b8b1;
}
.rc-soft_regen {
  /* 软重生：amber（改→待重生，点重生统一重出） */
  color: #b8741a;
  background: #fbeed6;
  border: 1px solid #ecc98f;
}
.rc-rewrite_solve {
  /* 重写解析：violet（改→重写解析过闸B，AI 在场） */
  color: #5b4fd6;
  background: #f2f0fe;
  border: 1px solid #cfc7f3;
}
.rc-meta {
  /* 只标注：灰（改→即时生效不重出，最轻） */
  color: #6b817e;
  background: #eef1f3;
  border: 1px solid #d9dfe1;
}

/* 维级「待重生⏳」角标（该维被改、未重生） */
.dim-dirty {
  font-size: 10.5px;
  color: #b8741a;
  background: #fbeed6;
  border-radius: 4px;
  padding: 0 6px;
  font-weight: 600;
}
.dna-v {
  color: #16302f; /* ink-900 */
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.dna-v.dna-full {
  flex-direction: row;
}
.dna-text {
  flex: 1;
  min-width: 0;
}
.dna-text.skel :deep(p) {
  margin: 0;
  display: inline;
}
.dna-diff {
  gap: 10px;
}
.diff-stars-inline {
  display: inline-flex;
  letter-spacing: -1px;
  font-size: 14px;
}
.diff-label {
  font-size: 12px;
  color: #6b817e;
}
.dna-muted {
  color: #9fb0ad; /* ink-300 */
  font-size: 12.5px;
}

/* 知识点药丸：主考点实心深青、副考点描边 */
.kp-pill {
  font-size: 12px;
  background: #0f6e6e; /* teal-700 */
  color: #fff;
  border: none;
  border-radius: 999px;
  padding: 3px 11px;
  font-weight: 600;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.kp-pill:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.kp-pill .pill-edit {
  font-size: 10px;
  opacity: 0.85;
}
.kp-pill.sec {
  background: #fff;
  color: #0f6e6e;
  border: 1px solid #7fc0bd;
  cursor: default;
}
.hard-pill {
  font-size: 12px;
  background: #fbeed6; /* amber-100 */
  color: #b8741a;
  border-radius: 5px;
  padding: 1px 8px;
  font-weight: 600;
}
/* PRD-C-015 块②：解题模型药丸（violet 系，呼应重写解析维） */
.model-pill {
  font-size: 12px;
  background: #f2f0fe; /* violet-50 */
  color: #5b4fd6; /* violet-700 */
  border: 1px solid #cfc7f3;
  border-radius: 999px;
  padding: 2px 9px;
  display: inline-block;
}
.model-pill.is-chosen {
  cursor: pointer;
}
.tag-pop-note {
  margin: 8px 0 0;
  font-size: 11px;
  color: #5b4fd6;
  background: #f2f0fe;
  border-radius: 6px;
  padding: 4px 8px;
}
.ftag {
  font-size: 12px;
  background: #f4f1ea;
  color: #385350;
  border: 1px solid #e9e3d6;
  border-radius: 999px;
  padding: 2px 9px;
  display: inline-block;
}
/* 骨架最难步高亮（BE 用【】包裹，这里也给视觉提示，由 MarkdownMath 渲染纯文本则保留括号） */
.dna-text.skel :deep(.hard) {
  background: #fbeed6;
  color: #b8741a;
  border-radius: 5px;
  padding: 0 6px;
  font-weight: 600;
}
/* DNA 维级小动作按钮（选副考点 / 说一句改 / 加标签） */
.dna-min-btn {
  font-size: 12px;
  color: #0f6e6e;
  background: #fff;
  border: 1px solid #7fc0bd;
  border-radius: 8px;
  padding: 2px 10px;
  cursor: pointer;
}
.dna-min-btn:hover:not(:disabled) {
  background: #e7f3f1;
}
.dna-min-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
/* DNA 维下拉（题型/考察类型）紧凑 */
.dna-select {
  width: 150px;
}

/* 🔴 PRD-C-017 B5：场景 / 骨架点击直改的 inline 编辑框（teal 系，老师拍板色） */
.inline-edit-box {
  flex-basis: 100%;
  width: 100%;
  background: #fff;
  border: 1px solid #e7e3da;
  border-radius: 10px;
  padding: 8px;
}
.inline-edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}
.inline-cancel,
.inline-save {
  font-size: 12px;
  border-radius: 8px;
  padding: 3px 14px;
  cursor: pointer;
}
.inline-cancel {
  color: #5b6770;
  background: #fff;
  border: 1px solid #e7e3da;
}
.inline-save {
  color: #fff;
  background: #1e8a8a; /* teal-600：老师拍板 */
  border: 1px solid #1e8a8a;
}
.inline-save:hover {
  background: #176e6e;
}

/* T4（已下线）：点击-说话内联输入框样式保留（无引用，不影响） */
.revise-box {
  flex-basis: 100%;
  margin-top: 8px;
  background: #fff;
  border: 1px solid #efecfb;
  border-radius: 10px;
  padding: 8px;
}
.revise-box.whole-revise {
  margin-top: 4px;
}
.revise-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}
.revise-cancel,
.revise-go {
  font-size: 12px;
  border-radius: 8px;
  padding: 3px 12px;
  cursor: pointer;
}
.revise-cancel {
  color: #5b6770;
  background: #fff;
  border: 1px solid #e7e3da;
}
.revise-go {
  color: #fff;
  background: #6d5fd0; /* violet-600：AI 在场（生成维） */
  border: 1px solid #6d5fd0;
}
.revise-go:hover {
  background: #5447b8;
}

/* 标签多选弹层 */
.tag-pop-title {
  margin: 8px 0 4px;
  font-size: 12px;
  font-weight: 700;
  color: #385350;
}
.tag-pop-title:first-child {
  margin-top: 0;
}
.tag-pop-chosen,
.tag-pop-cands {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 22px;
}
.tag-pop-cands {
  max-height: 140px;
  overflow-y: auto;
}
.ftag.is-chosen {
  background: #e7f3f1;
  color: #0f6e6e;
  border-color: #7fc0bd;
  cursor: pointer;
}
.ftag.is-cand {
  cursor: pointer;
}
.ftag.is-cand.is-picked {
  background: #e7f3f1;
  color: #0f6e6e;
  border-color: #7fc0bd;
}
.tag-pop-input {
  display: flex;
  gap: 6px;
  margin: 6px 0;
}
.tag-pop-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
  border-top: 1px dashed #e7e3da;
  padding-top: 8px;
}

/* 整卡重做按钮：violet 描边（AI 生成动作） */
.knob-btn.is-redo {
  color: #5447b8;
  border-color: #cfc7f3;
}
.knob-btn.is-redo:hover:not(:disabled) {
  background: #efecfb;
  border-color: #6d5fd0;
}

@container (max-width: 460px) {
  .dna-grid {
    grid-template-columns: 1fr;
    gap: 4px 0;
  }
  .dna-k {
    margin-top: 6px;
    font-weight: 600;
  }
}

.solution-block {
  border-top: 1px dashed #e3e9e9;
  padding-top: 6px;
}
.solution-toggle {
  border: none;
  background: none;
  padding: 2px 0;
  font-size: 13px;
  color: #1e8a8a; /* teal-600 */
  cursor: pointer;
}
.solution-toggle:hover {
  color: #176e6e;
}
.solution-body {
  margin-top: 6px;
  background: #f5f8f8; /* bg-50 内嵌 */
  border-radius: 8px;
  padding: 10px 12px;
}
.solution-label {
  margin: 4px 0 2px;
  font-size: 12px;
  font-weight: 700;
  color: #33464c;
}
.solution-empty {
  margin: 0;
  font-size: 12px;
  color: #86909c;
}

/* PRD-C-015 批5：dirty 题入库拦截提示条（amber 暖底，醒目但不报错色） */
.dirty-block-hint {
  font-size: 12px;
  line-height: 1.6;
  color: #92590f;
  background: #fdf4e3;
  border: 1px solid #ecc98f;
  border-radius: 8px;
  padding: 7px 11px;
}

/* 入库行（T1/T2）：与旋钮行同栏宽，按钮略强于旋钮（入库是主动作） */
.bank-row {
  display: flex;
  gap: 8px;
}
.bank-btn {
  font-size: 13px;
  border-radius: 8px;
  padding: 4px 14px;
  cursor: pointer;
  border: 1px solid transparent;
}
.bank-btn:disabled {
  cursor: not-allowed;
}
/* 收录入库：teal 实心（老师拍板色系，与右栏「全部入库」一致语汇） */
.bank-btn.is-persist {
  color: #fff;
  background: #1e8a8a; /* teal-600 */
  border-color: #1e8a8a;
}
.bank-btn.is-persist:hover:not(:disabled) {
  background: #176e6e;
  border-color: #176e6e;
}
.bank-btn.is-persist:disabled:not(.is-done) {
  background: #b9d8d8;
  border-color: #b9d8d8;
}
/* 已收录态：弱化为 violet-50 描边（与卡片 is-persisted 弱高亮呼应），非禁用灰 */
.bank-btn.is-persist.is-done {
  color: #5b4fd6; /* violet-700 */
  background: #f2f0fe; /* violet-50 */
  border-color: #c8c0f7;
}
/* 加入试题篮：teal 描边（始终可点；不抢实心入库的视觉权重） */
.bank-btn.is-basket {
  color: #176e6e; /* teal-700 */
  background: #fff;
  border-color: #b9d8d8;
}
.bank-btn.is-basket:hover:not(:disabled) {
  background: #e6f2f2; /* teal-50 */
}
.bank-btn.is-basket:disabled {
  opacity: 0.55;
}

.knob-row {
  display: flex;
  gap: 8px;
}
.knob-btn {
  font-size: 13px;
  color: #33464c;
  background: none;
  border: 1px solid #e3e9e9;
  border-radius: 8px;
  padding: 3px 12px;
  cursor: pointer;
}
.knob-btn:hover:not(:disabled) {
  color: #1e8a8a;
  border-color: #1e8a8a;
}
.knob-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
/* 「编辑」突出：teal 描边（老师拍板色系） */
.knob-btn.is-edit {
  color: #176e6e;
  border-color: #b9d8d8;
}
.knob-btn.is-edit:hover:not(:disabled) {
  background: #e6f2f2;
}
/* 「重新验算」：violet 描边（AI 在场） */
.knob-btn.is-reverify {
  color: #5b4fd6;
  border-color: #c8c0f7;
}
.knob-btn.is-reverify:hover:not(:disabled) {
  background: #f2f0fe;
  border-color: #7b6cf0;
}
/* PRD-C-015 批5：「重生」amber 实心（dirty 题的主动作，最醒目） */
.knob-btn.is-regen {
  color: #fff;
  background: #b8741a; /* 暖琥珀（v3） */
  border-color: #b8741a;
  font-weight: 600;
}
.knob-btn.is-regen:hover:not(:disabled) {
  background: #9a6015;
  border-color: #9a6015;
}
/* 「撤销重生」：灰描边（次动作，回上一版） */
.knob-btn.is-undo {
  color: #5b6770;
  border-color: #d4dede;
}
.knob-btn.is-undo:hover:not(:disabled) {
  background: #f5f8f8;
}

/* ============ 编辑态：textarea + 实时预览双栏 ============ */
.variant-card.is-editing {
  border-color: #7b6cf0; /* violet-600：编辑中 = AI 在场 */
  box-shadow: 0 0 0 2px rgba(123, 108, 240, 0.12);
}
.variant-card.is-reverifying {
  opacity: 0.85;
}
.edit-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.edit-label-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.edit-label {
  font-size: 12px;
  font-weight: 700;
  color: #33464c;
}
.norm-btn {
  font-size: 12px;
  color: #176e6e;
  background: #e6f2f2;
  border: 1px solid #b9d8d8;
  border-radius: 6px;
  padding: 1px 10px;
  cursor: pointer;
}
.norm-btn:hover {
  background: #d3eaea;
}
.edit-hint {
  font-size: 11px;
  color: #86909c;
}
/* 智能输入提示条 */
.smart-hint {
  margin: 0;
  font-size: 12px;
  color: #5b4fd6; /* violet-700：AI 辅助 */
  background: #f2f0fe; /* violet-50 */
  border-radius: 6px;
  padding: 4px 10px;
}
/* 选项编辑行：字母圈 + 双栏（输入/预览） */
.choice-opt-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.opt-letter {
  width: 22px;
  height: 22px;
  margin-top: 4px;
  border-radius: 50%;
  background: #edf2f2; /* bg-100 */
  color: #33464c;
  font-size: 12px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.opt-pair {
  flex: 1;
}
.opt-preview {
  min-height: 32px;
  padding: 10px 10px 6px;
}
.opt-preview :deep(p) {
  margin: 0;
}
.ans-select {
  width: 200px;
}
/* 双栏：左 textarea / 右预览；窄屏（卡片 <520px）上下堆叠 */
.edit-pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  align-items: start;
}
@container (max-width: 520px) {
  .edit-pair {
    grid-template-columns: 1fr;
  }
}
.edit-pair :deep(.el-textarea__inner) {
  font-size: 13px;
  line-height: 1.6;
  font-family:
    ui-monospace, 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace;
}
.edit-preview {
  position: relative;
  background: #f5f8f8; /* bg-50 */
  border: 1px solid #e3e9e9;
  border-radius: 8px;
  padding: 18px 12px 10px;
  font-size: 14px;
  color: #1d2a2e;
  min-height: 40px;
  overflow-x: auto;
}
.preview-tag {
  position: absolute;
  top: 2px;
  left: 8px;
  font-size: 10px;
  color: #a0a8b3;
}
.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  border-top: 1px dashed #e3e9e9;
  padding-top: 8px;
}
.edit-cancel,
.edit-save {
  font-size: 13px;
  border-radius: 8px;
  padding: 4px 16px;
  cursor: pointer;
}
.edit-cancel {
  color: #5b6770;
  background: #fff;
  border: 1px solid #e3e9e9;
}
.edit-cancel:hover {
  background: #f5f8f8;
}
.edit-save {
  color: #fff;
  background: #1e8a8a; /* teal-600：老师拍板 */
  border: 1px solid #1e8a8a;
}
.edit-save:hover {
  background: #176e6e;
  border-color: #176e6e;
}
</style>
