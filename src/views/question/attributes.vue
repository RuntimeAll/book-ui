<script setup lang="ts">
/**
 * PRD-A-015 — 题目「高级属性」编辑页（/question/attributes/:id）。
 *
 * 🔴 2026-06-17 重构（用户拍板「属性=高级设置」）：
 *   - 基础属性（题型/难度/章节/自由标签）已挪到「编辑/排版」页（editor.vue），本页不再含。
 *   - 本页 = 高级设置：AI 打标 5 维 + 打标元数据 + N1 高级属性，AI 维度与 N1 全部「可编辑」，
 *     打标元数据（置信度/打标者/打标时间/导入来源 = 系统/AI 产出的溯源）只读。
 *
 * 权限：本人题（createUser=登录 id）或 superadmin 才可编辑；非 canEdit 全禁用 + 顶部提示，保存禁用。
 * 保存：只回写「变了的」字段 → updateQuestionAttrs（POST /teacher/question/update-attrs，BE 条件 set）。
 * SPA 路由 id 变化（watch route.params.id）重新加载（防组件复用不刷新，与 detail/editor 同款）。
 */
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowLeft } from '@element-plus/icons-vue'
import {
  getQuestionDetail,
  updateQuestionAttrs,
  type QuestionDetail,
  type QuestionDna,
  type UpdateAttrsPayload,
} from '@/api/question/index'
import ChapterPicker from '@/components/business/ChapterPicker/index.vue'
import { useDictStore, DICT_QUESTION_SOURCE_TYPE } from '@/store/dict'
import { useUserStore } from '@/store/user'
import { getCurrentUser } from '@/api/user'

// ── 路由 ──────────────────────────────────────────────────────────────────────
const route = useRoute()
const router = useRouter()
// 雪花 id 全程 string（防 Number 精度丢失），与 detail.vue 同。
const questionId = computed(() => String(route.params.id))

// ── 用户 / 权限 ────────────────────────────────────────────────────────────────
const userStore = useUserStore()
const detail = ref<QuestionDetail | null>(null)
const loading = ref(false)
const saving = ref(false)

// 可编辑 = superadmin 或 本人题（createUser === 登录 id）。
const canEdit = computed(() => {
  if (!detail.value) return false
  if (userStore.isSuperAdmin) return true
  const uid = userStore.userInfo?.id
  const owner = detail.value.createUser
  return uid != null && owner != null && String(owner) === String(uid)
})

// ── 受控词表 ────────────────────────────────────────────────────────────────
// 🔴 C-100 B-converge 方案B：dim3（思维方法）随 BE V905 DROP 列剥除，METHOD_OPTIONS 一并删（属性编辑页 C 线预期降级）。
const LABEL_STATUS_OPTIONS = [
  { label: '未标', value: 0 },
  { label: 'AI 已标', value: 1 },
  { label: '已审核', value: 2 },
  { label: '争议', value: 3 },
]
// 来源下拉走字典 SSOT（biz_question_source_type，超管可维护）；选项 = 字典全量。
const dict = useDictStore()
dict.load(DICT_QUESTION_SOURCE_TYPE)
const SOURCE_TYPE_OPTIONS = computed(() =>
  dict.list(DICT_QUESTION_SOURCE_TYPE).map((d) => ({ label: d.dictLabel, value: Number(d.dictValue) })),
)
const ANNOTATE_STATUS_OPTIONS = [
  { label: '未标', value: 0 },
  { label: '已标全', value: 1 },
  { label: '部分', value: 2 },
]
// PRD-C-204：考察类型闭集 10（与 22-题目维度 SSOT / EXAM_TYPES 一致）
const ASSESSMENT_TYPE_OPTIONS = [
  '概念辨析', '直接计算', '公式套用', '性质判定', '证明推理',
  '应用建模', '作图', '探究归纳', '阅读理解迁移', '纠错',
]

// ── PRD-C-204 — JSON 串字段 try-parse（红线：解析失败原样字符串显示，绝不崩） ─────────────
/** 把 JSON 数组串解析成 string[]；解析失败 / 非数组 → 原串包成单元素数组（友好显示，不崩） */
function parseJsonArr(raw: unknown): string[] {
  if (raw == null || raw === '') return []
  if (Array.isArray(raw)) return raw.map((x) => String(x)).filter((s) => s.trim())
  if (typeof raw !== 'string') return [String(raw)]
  try {
    const v = JSON.parse(raw)
    if (Array.isArray(v)) return v.map((x) => String(x)).filter((s) => s.trim() !== '')
    if (v == null) return []
    return [typeof v === 'object' ? JSON.stringify(v) : String(v)]
  } catch {
    // 解析失败：原样字符串显示（红线）
    return [raw]
  }
}
/** 把 JSON 对象/数组串解析成「友好可读」文本；解析失败原样返回原串（不崩） */
function parseJsonPretty(raw: unknown): string {
  if (raw == null || raw === '') return ''
  if (typeof raw !== 'string') {
    try { return JSON.stringify(raw, null, 2) } catch { return String(raw) }
  }
  try {
    const v = JSON.parse(raw)
    if (v == null) return ''
    if (typeof v === 'object') return JSON.stringify(v, null, 2)
    return String(v)
  } catch {
    return raw
  }
}

// ── 可编辑表单（高级字段全集）────────────────────────────────────────────────
// 🔴 C-100 B-converge 方案B：dim3Skill / auxTags 随 BE V905 DROP 列剥除（属性编辑页 C 线预期降级）。
interface AdvForm {
  dim1KpId: string
  dim2Qtype: number | null
  dim4Difficulty: number | null
  dim5Structure: string
  labelStatus: number | null
  baseScore: number | null
  sourceType: number | null
  regionCode: string
  variantRelation: string
  motherQuestionId: string
  annotateStatus: number | null
  // ── PRD-C-204 高级属性新增可写：来源三要素补 examYear / examPaperName ──
  examYear: string
  examPaperName: string
  // ── PRD-C-204 AI 打标维度可编辑：solutionSkeleton / scenario / assessmentType / hardPoints / tags ──
  solutionSkeleton: string
  scenario: string
  assessmentType: string
  /** 难点（数组，按行编辑，UI 用多行文本） */
  hardPoints: string[]
  /** 标签（数组，按行编辑） */
  tags: string[]
}
function blankForm(): AdvForm {
  return {
    dim1KpId: '', dim2Qtype: null, dim4Difficulty: null,
    dim5Structure: '', labelStatus: null,
    baseScore: null, sourceType: null, regionCode: '',
    variantRelation: '', motherQuestionId: '', annotateStatus: null,
    examYear: '', examPaperName: '',
    solutionSkeleton: '', scenario: '', assessmentType: '',
    hardPoints: [], tags: [],
  }
}
const form = ref<AdvForm>(blankForm())
const original = ref<AdvForm>(blankForm())

// 打标时间格式化（只读）
const DASH = '—'
function display(v: unknown): string {
  if (v === null || v === undefined || v === '') return DASH
  return String(v)
}
// ── PRD-C-204 — DNA 可编辑表单初值/基线生成（load + 保存后刷新共用） ──────────────
function formFromDetail(res: QuestionDetail): AdvForm {
  const dna = res.dna ?? null
  return {
    dim1KpId: res.dim1KpId != null ? String(res.dim1KpId) : '',
    dim2Qtype: res.dim2Qtype ?? null,
    dim4Difficulty: res.dim4Difficulty ?? null,
    dim5Structure: res.dim5Structure != null ? String(res.dim5Structure) : '',
    labelStatus: res.labelStatus ?? null,
    baseScore: res.baseScore ?? null,
    sourceType: res.sourceType ?? null,
    regionCode: res.regionCode != null ? String(res.regionCode) : '',
    variantRelation: res.variantRelation != null ? String(res.variantRelation) : '',
    motherQuestionId: res.motherQuestionId != null ? String(res.motherQuestionId) : '',
    annotateStatus: res.annotateStatus ?? null,
    examYear: res.examYear != null ? String(res.examYear) : '',
    examPaperName: res.examPaperName != null ? String(res.examPaperName) : '',
    // AI 打标可编辑维（dna 为 null 时全空）
    solutionSkeleton: dna?.solutionSkeleton != null ? String(dna.solutionSkeleton) : '',
    scenario: dna?.scenario != null ? String(dna.scenario) : '',
    assessmentType: dna?.assessmentType != null ? String(dna.assessmentType) : '',
    hardPoints: parseJsonArr(dna?.hardPoints),
    tags: parseJsonArr(dna?.tags),
  }
}

// ── PRD-C-204 — DNA 只读维（JSON 串 try-parse 后友好显示）────────────────────────
const dnaObj = computed<QuestionDna | null>(() => detail.value?.dna ?? null)
const hasDna = computed(() => !!dnaObj.value)
const dnaReadonly = computed(() => {
  const d = dnaObj.value
  return {
    breakthroughPoints: parseJsonArr(d?.breakthroughPoints),
    mathThoughts: parseJsonArr(d?.mathThoughts),
    dnaType: d?.dnaType ?? '',
    verifyKind: d?.verifyKind ?? '',
    parametricSlots: parseJsonPretty(d?.parametricSlots),
    modelingFrame: parseJsonPretty(d?.modelingFrame),
    conditions: parseJsonPretty(d?.conditions),
    variationProfile: parseJsonPretty(d?.variationProfile),
  }
})
// AI 解析块（reasoning + confidence + needAnchorReview，只读）
const aiAnalysis = computed(() => {
  const d = dnaObj.value
  return {
    reasoning: d?.reasoning ?? '',
    confidence: d?.confidence ?? null,
    needAnchorReview: d?.needAnchorReview === true,
  }
})

// ── PRD-C-204 — 数组维（难点/标签）按行编辑：computed 字符串代理（一行一条，读写互转） ──
function arrayLineProxy(key: 'hardPoints' | 'tags') {
  return computed<string>({
    get: () => form.value[key].join('\n'),
    set: (v: string) => {
      form.value[key] = v.split('\n').map((s) => s.trim()).filter(Boolean)
    },
  })
}
const hardPointsText = arrayLineProxy('hardPoints')
const tagsText = arrayLineProxy('tags')

const labeledAtText = computed<string>(() => {
  const v = detail.value?.labeledAt
  if (v === null || v === undefined || v === '') return DASH
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v))
  if (Number.isNaN(d.getTime())) return String(v)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
})

// ── 加载 ──────────────────────────────────────────────────────────────────────
async function loadDetail() {
  if (!questionId.value || questionId.value === 'undefined') return
  loading.value = true
  try {
    const res = await getQuestionDetail(questionId.value)
    detail.value = res ?? null
    if (res) {
      const f = formFromDetail(res)
      form.value = f
      original.value = JSON.parse(JSON.stringify(f))
    }
  } catch (e) {
    console.warn('[question-attributes] loadDetail failed', e)
    ElMessage.warning('题目加载失败（接口需登录态）')
  } finally {
    loading.value = false
  }
}

// ── 保存（只回写变更字段）──────────────────────────────────────────────────
async function handleSave() {
  if (!canEdit.value) {
    ElMessage.warning('非本人题/无权编辑')
    return
  }
  if (!detail.value) return

  const f = form.value
  const o = original.value
  const payload: UpdateAttrsPayload = { questionId: questionId.value }
  const p = payload as unknown as Record<string, unknown> // 动态键赋值用
  let changed = false

  // 简单标量字段：变了才带（注意 BE update-attrs 仅在值非 null 时 set，故清空到 null 不会落库）
  const setIf = (key: string, cur: unknown, old: unknown) => {
    if (cur !== old) {
      p[key] = cur
      changed = true
    }
  }
  setIf('dim1KpId', f.dim1KpId, o.dim1KpId)
  setIf('dim2Qtype', f.dim2Qtype, o.dim2Qtype)
  setIf('dim4Difficulty', f.dim4Difficulty, o.dim4Difficulty)
  setIf('dim5Structure', f.dim5Structure, o.dim5Structure)
  setIf('labelStatus', f.labelStatus, o.labelStatus)
  setIf('baseScore', f.baseScore, o.baseScore)
  setIf('sourceType', f.sourceType, o.sourceType)
  setIf('regionCode', f.regionCode, o.regionCode)
  setIf('variantRelation', f.variantRelation, o.variantRelation)
  setIf('motherQuestionId', f.motherQuestionId, o.motherQuestionId)
  setIf('annotateStatus', f.annotateStatus, o.annotateStatus)
  // ── PRD-C-204 新增可写标量 ──
  setIf('examYear', f.examYear, o.examYear)
  setIf('examPaperName', f.examPaperName, o.examPaperName)
  setIf('solutionSkeleton', f.solutionSkeleton, o.solutionSkeleton)
  setIf('scenario', f.scenario, o.scenario)
  setIf('assessmentType', f.assessmentType, o.assessmentType)
  // ── PRD-C-204 数组维（hardPoints / tags）：按值比对（JSON.stringify 差量），变了整数组回写 ──
  const setArrIf = (key: string, cur: string[], old: string[]) => {
    if (JSON.stringify(cur) !== JSON.stringify(old)) {
      p[key] = cur
      changed = true
    }
  }
  setArrIf('hardPoints', f.hardPoints, o.hardPoints)
  setArrIf('tags', f.tags, o.tags)

  // 🔴 C-100 B-converge 方案B：dim3Skill / auxTags 随 BE V905 DROP 列剥除（属性编辑页 C 线预期降级）。

  if (!changed) {
    ElMessage.info('没有改动需要保存')
    return
  }

  saving.value = true
  try {
    const res = await updateQuestionAttrs(payload)
    ElMessage.success('保存成功')
    if (res) {
      detail.value = res
      // 用返回值刷新表单基线
      const nf = formFromDetail(res)
      form.value = nf
      original.value = JSON.parse(JSON.stringify(nf))
    }
  } catch (e: unknown) {
    const msg = (e as { message?: string })?.message || '请稍后重试'
    ElMessage.error(`保存失败：${msg}`)
    console.warn('[question-attributes] save failed', e)
  } finally {
    saving.value = false
  }
}

function goBack() {
  router.back()
}

// ── 初始化 ───────────────────────────────────────────────────────────────────
onMounted(async () => {
  // 兜底拉当前用户（权限判定需 userInfo.id/roles；内存态刷新会丢，与 detail/editor 同款兜底）
  if (!userStore.userInfo) {
    try {
      const info = await getCurrentUser()
      if (info) userStore.setUserInfo(info)
    } catch (e) {
      console.warn('[question-attributes] getCurrentUser 兜底失败', e)
    }
  }
  await loadDetail()
})

// SPA 内路由 id 变化重新加载（防组件复用不刷新）
watch(questionId, async () => {
  await loadDetail()
})
</script>

<template>
  <div class="attr-page">
    <!-- 顶栏 -->
    <div class="attr-topbar">
      <el-button link class="back-btn" @click="goBack">
        <el-icon><ArrowLeft /></el-icon>
        <span>返回</span>
      </el-button>
      <span class="topbar-title">题目高级属性</span>
      <span class="topbar-sub">基础属性（题型/难度/章节/标签）请在「编辑」页设置</span>
      <div class="topbar-spacer" />
      <el-button
        type="primary"
        class="save-btn"
        :loading="saving"
        :disabled="!canEdit"
        @click="handleSave"
      >
        保存
      </el-button>
    </div>

    <!-- 无权编辑提示条 -->
    <el-alert
      v-if="detail && !canEdit"
      type="warning"
      :closable="false"
      title="非本人题/无权编辑（保存已禁用）"
      class="attr-alert"
    />

    <div v-loading="loading" class="attr-body">
      <!-- ══ 基础打标维度（dim1~5 + 标注状态，可编辑）══ -->
      <el-card class="attr-card" shadow="never">
        <template #header>
          <span class="card-title">基础打标维度</span>
        </template>
        <div class="field-list">
          <div class="field-row">
            <!-- PRD-C-204 命名对齐：题库这里的「知识点」= 母题卡的「主考点」 -->
            <span class="field-label">知识点 (dim1)<span class="field-note">(主考点)</span></span>
            <div class="field-control">
              <ChapterPicker v-if="canEdit" v-model="form.dim1KpId" />
              <span v-else class="field-value">{{ display(form.dim1KpId) }}</span>
            </div>
          </div>
          <div class="field-row">
            <span class="field-label">题型 (dim2)</span>
            <el-input-number
              v-model="form.dim2Qtype"
              :disabled="!canEdit"
              :min="0"
              controls-position="right"
              style="width: 160px"
            />
          </div>
          <!-- 🔴 C-100 B-converge 方案B：思维方法 (dim3) 随 BE V905 DROP 列剥除（属性编辑页 C 线预期降级） -->
          <div class="field-row">
            <!-- 难度档文案统一回字典 biz_question_difficulty：1=基础 / 2=中等 / 3=较难 / 4=压轴 -->
            <span class="field-label">难度 (dim4)<span class="field-note">(1基础/2中等/3较难/4压轴)</span></span>
            <el-input-number
              v-model="form.dim4Difficulty"
              :disabled="!canEdit"
              :min="0"
              :max="10"
              controls-position="right"
              style="width: 160px"
            />
          </div>
          <div class="field-row">
            <span class="field-label">结构指纹 (dim5)</span>
            <el-input
              v-model="form.dim5Structure"
              :disabled="!canEdit"
              placeholder="结构指纹串"
              style="width: 100%; max-width: 420px"
            />
          </div>
          <!-- 🔴 C-100 B-converge 方案B：辅标签 (aux_tags) 随 BE V905 DROP 列剥除（属性编辑页 C 线预期降级） -->
          <div class="field-row">
            <span class="field-label">标注状态</span>
            <el-select
              v-model="form.labelStatus"
              :disabled="!canEdit"
              clearable
              placeholder="标注状态"
              style="width: 160px"
            >
              <el-option v-for="s in LABEL_STATUS_OPTIONS" :key="s.value" :label="s.label" :value="s.value" />
            </el-select>
          </div>
        </div>
      </el-card>

      <!-- ══ AI 打标维度（全 DNA 维；部分可编辑，其余只读）══ -->
      <el-card class="attr-card" shadow="never">
        <template #header>
          <span class="card-title">AI 打标维度</span>
          <span class="card-hint">真实打标 DNA · 全维展示</span>
        </template>

        <!-- dna=null → 无打标数据提示 -->
        <div v-if="!hasDna" class="dna-empty">该题暂无 AI 打标数据</div>

        <div v-else class="field-list">
          <!-- ── 可编辑维 ── -->
          <div class="field-row">
            <span class="field-label">考察类型</span>
            <el-select
              v-model="form.assessmentType"
              :disabled="!canEdit"
              clearable
              filterable
              allow-create
              placeholder="考察类型"
              style="width: 220px"
            >
              <el-option v-for="t in ASSESSMENT_TYPE_OPTIONS" :key="t" :label="t" :value="t" />
            </el-select>
          </div>
          <div class="field-row">
            <span class="field-label">场景</span>
            <el-input
              v-model="form.scenario"
              :disabled="!canEdit"
              placeholder="场景（如「纯代数」或一句话场景）"
              style="width: 100%; max-width: 420px"
            />
          </div>
          <div class="field-row field-row-top">
            <span class="field-label">解法骨架</span>
            <el-input
              v-model="form.solutionSkeleton"
              :disabled="!canEdit"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 8 }"
              resize="none"
              placeholder="解法骨架（【】标最难步）"
              style="width: 100%; max-width: 520px"
            />
          </div>
          <div class="field-row field-row-top">
            <span class="field-label">难点<span class="field-note">(一行一条)</span></span>
            <div class="field-control">
              <el-input
                v-if="canEdit"
                v-model="hardPointsText"
                type="textarea"
                :autosize="{ minRows: 2, maxRows: 6 }"
                resize="none"
                placeholder="一行一条难点（基础题可留空，宁空不凑）"
                style="width: 100%; max-width: 520px"
              />
              <template v-else>
                <template v-if="form.hardPoints.length">
                  <el-tag v-for="(hp, i) in form.hardPoints" :key="i" type="warning" size="small" class="dna-chip">{{ hp }}</el-tag>
                </template>
                <span v-else class="field-value dna-muted">未标</span>
              </template>
            </div>
          </div>
          <div class="field-row field-row-top">
            <span class="field-label">标签<span class="field-note">(一行一个)</span></span>
            <div class="field-control">
              <el-input
                v-if="canEdit"
                v-model="tagsText"
                type="textarea"
                :autosize="{ minRows: 2, maxRows: 6 }"
                resize="none"
                placeholder="一行一个标签"
                style="width: 100%; max-width: 520px"
              />
              <template v-else>
                <template v-if="form.tags.length">
                  <el-tag v-for="(t, i) in form.tags" :key="i" size="small" class="dna-chip">{{ t }}</el-tag>
                </template>
                <span v-else class="field-value dna-muted">未标</span>
              </template>
            </div>
          </div>

          <!-- ── 只读维（BE 暂只读；JSON 串 try-parse 后友好显示）── -->
          <div class="dna-readonly-head">以下维度暂为只读</div>
          <div class="field-row field-row-top">
            <span class="field-label">突破点</span>
            <div class="field-control">
              <template v-if="dnaReadonly.breakthroughPoints.length">
                <el-tag v-for="(bp, i) in dnaReadonly.breakthroughPoints" :key="i" type="success" size="small" class="dna-chip">{{ bp }}</el-tag>
              </template>
              <span v-else class="field-value dna-muted">未标</span>
            </div>
          </div>
          <div class="field-row field-row-top">
            <span class="field-label">数学思想</span>
            <div class="field-control">
              <template v-if="dnaReadonly.mathThoughts.length">
                <el-tag v-for="(mt, i) in dnaReadonly.mathThoughts" :key="i" type="info" size="small" class="dna-chip">{{ mt }}</el-tag>
              </template>
              <span v-else class="field-value dna-muted">未标</span>
            </div>
          </div>
          <div class="field-row">
            <span class="field-label">DNA 类型</span>
            <span class="field-value">{{ display(dnaReadonly.dnaType) }}</span>
          </div>
          <div class="field-row">
            <span class="field-label">验证种类</span>
            <span class="field-value">{{ display(dnaReadonly.verifyKind) }}</span>
          </div>
          <div v-if="dnaReadonly.parametricSlots" class="field-row field-row-top">
            <span class="field-label">参数槽</span>
            <pre class="dna-json">{{ dnaReadonly.parametricSlots }}</pre>
          </div>
          <div v-if="dnaReadonly.modelingFrame" class="field-row field-row-top">
            <span class="field-label">建模框架</span>
            <pre class="dna-json">{{ dnaReadonly.modelingFrame }}</pre>
          </div>
          <div v-if="dnaReadonly.conditions" class="field-row field-row-top">
            <span class="field-label">条件</span>
            <pre class="dna-json">{{ dnaReadonly.conditions }}</pre>
          </div>
          <div v-if="dnaReadonly.variationProfile" class="field-row field-row-top">
            <span class="field-label">变式画像</span>
            <pre class="dna-json">{{ dnaReadonly.variationProfile }}</pre>
          </div>
        </div>
      </el-card>

      <!-- ══ AI 解析（reasoning / confidence / needAnchorReview，只读）══ -->
      <el-card v-if="hasDna" class="attr-card" shadow="never">
        <template #header>
          <span class="card-title">AI 解析</span>
          <span class="card-hint">AI 产出 · 只读</span>
        </template>
        <div class="field-list">
          <div class="field-row">
            <span class="field-label">置信度</span>
            <span class="field-value">{{ aiAnalysis.confidence != null ? aiAnalysis.confidence : '—' }}</span>
          </div>
          <div class="field-row">
            <span class="field-label">锚定待人审</span>
            <el-tag v-if="aiAnalysis.needAnchorReview" type="warning" size="small">待人审</el-tag>
            <span v-else class="field-value">否</span>
          </div>
          <div class="field-row field-row-top">
            <span class="field-label">打标依据</span>
            <div class="field-control">
              <span v-if="aiAnalysis.reasoning" class="dna-reasoning">{{ aiAnalysis.reasoning }}</span>
              <span v-else class="field-value dna-muted">未提供</span>
            </div>
          </div>
        </div>
      </el-card>

      <!-- ══ 打标元数据（系统/AI 溯源，只读）══ -->
      <el-card class="attr-card" shadow="never">
        <template #header>
          <span class="card-title">打标元数据</span>
          <span class="card-hint">系统溯源·只读</span>
        </template>
        <div class="field-list">
          <div class="field-row">
            <span class="field-label">置信度</span>
            <span class="field-value">{{ display(detail?.labelConfidence) }}</span>
          </div>
          <div class="field-row">
            <span class="field-label">打标者</span>
            <span class="field-value">{{ display(detail?.labeledBy) }}</span>
          </div>
          <div class="field-row">
            <span class="field-label">打标时间</span>
            <span class="field-value">{{ labeledAtText }}</span>
          </div>
          <div class="field-row">
            <span class="field-label">导入来源</span>
            <span class="field-value">{{ display(detail?.importSource) }}</span>
          </div>
        </div>
      </el-card>

      <!-- ══ N1 高级属性（可编辑）══ -->
      <el-card class="attr-card" shadow="never">
        <template #header>
          <span class="card-title">高级属性</span>
        </template>
        <div class="field-list">
          <div class="field-row">
            <span class="field-label">标准分值</span>
            <el-input-number
              v-model="form.baseScore"
              :disabled="!canEdit"
              :min="0"
              :precision="1"
              :step="1"
              controls-position="right"
              style="width: 160px"
            />
          </div>
          <div class="field-row">
            <span class="field-label">来源类型</span>
            <el-select
              v-model="form.sourceType"
              :disabled="!canEdit"
              clearable
              placeholder="来源类型"
              style="width: 200px"
            >
              <el-option v-for="s in SOURCE_TYPE_OPTIONS" :key="s.value" :label="s.label" :value="s.value" />
            </el-select>
          </div>
          <div class="field-row">
            <span class="field-label">地域</span>
            <el-input
              v-model="form.regionCode"
              :disabled="!canEdit"
              placeholder="地域编码，如 330100"
              style="width: 200px"
            />
          </div>
          <!-- PRD-C-204：来源三要素补 真题年份 + 来源卷名（与 来源类型/地域 凑齐） -->
          <div class="field-row">
            <span class="field-label">真题年份</span>
            <el-input
              v-model="form.examYear"
              :disabled="!canEdit"
              placeholder="如 2024"
              style="width: 200px"
            />
          </div>
          <div class="field-row">
            <span class="field-label">来源卷名</span>
            <el-input
              v-model="form.examPaperName"
              :disabled="!canEdit"
              placeholder="如 2024 杭州中考数学"
              style="width: 100%; max-width: 420px"
            />
          </div>
          <div class="field-row">
            <span class="field-label">变式关系</span>
            <el-input
              v-model="form.variantRelation"
              :disabled="!canEdit"
              placeholder="变式关系描述"
              style="width: 100%; max-width: 420px"
            />
          </div>
          <div class="field-row">
            <span class="field-label">母题 id</span>
            <el-input
              v-model="form.motherQuestionId"
              :disabled="!canEdit"
              placeholder="母题雪花 id"
              style="width: 280px"
            />
          </div>
          <div class="field-row">
            <span class="field-label">标注完整度</span>
            <el-select
              v-model="form.annotateStatus"
              :disabled="!canEdit"
              clearable
              placeholder="标注完整度"
              style="width: 160px"
            >
              <el-option v-for="s in ANNOTATE_STATUS_OPTIONS" :key="s.value" :label="s.label" :value="s.value" />
            </el-select>
          </div>
        </div>
      </el-card>
    </div>
  </div>
</template>

<style scoped>
.attr-page {
  min-height: 100vh;
  background: #f0f2f5;
  display: flex;
  flex-direction: column;
}

/* 顶栏 */
.attr-topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 24px;
  background: #fff;
  border-bottom: 1px solid #f2f3f5;
  position: sticky;
  top: 0;
  z-index: 100;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
}

.back-btn {
  color: #4e5969;
  gap: 4px;
}
.back-btn:hover {
  color: #1e8a8a;
}

.topbar-title {
  font-size: 16px;
  font-weight: 600;
  color: #1d2129;
}

.topbar-sub {
  font-size: 12px;
  color: #86909c;
}

.topbar-spacer {
  flex: 1;
}

.save-btn {
  background: #1e8a8a;
  border-color: #1e8a8a;
}

.attr-alert {
  margin: 8px 24px 0;
}

/* 单栏主体 */
.attr-body {
  flex: 1;
  padding: 16px 24px;
  max-width: 760px;
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.attr-card {
  border-radius: 10px;
  border: 1px solid #f2f3f5;
}

.card-title {
  font-size: 15px;
  font-weight: 600;
  color: #1d2129;
  border-left: 4px solid #7b6cf0;
  padding-left: 10px;
}

.card-hint {
  margin-left: 10px;
  font-size: 12px;
  color: #c9cdd4;
}

/* 字段行 */
.field-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.field-row {
  display: flex;
  align-items: center;
  gap: 16px;
}
.field-row-top {
  align-items: flex-start;
}

.field-label {
  width: 120px;
  flex-shrink: 0;
  font-size: 13px;
  color: #4e5969;
  font-weight: 500;
}

.field-control {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.field-value {
  font-size: 13px;
  color: #1d2129;
  word-break: break-all;
}

/* ── PRD-C-204 DNA 全维展示样式 ── */
.field-note {
  margin-left: 4px;
  font-size: 11px;
  font-weight: 400;
  color: #a8acb3;
}
.dna-empty {
  font-size: 13px;
  color: #c9cdd4;
  padding: 8px 0;
}
.dna-muted {
  color: #c9cdd4;
}
.dna-chip {
  margin: 0 4px 4px 0;
}
.dna-readonly-head {
  margin-top: 4px;
  padding-top: 8px;
  border-top: 1px dashed #e5e6eb;
  font-size: 12px;
  color: #86909c;
  font-weight: 600;
}
.dna-json {
  flex: 1;
  min-width: 0;
  margin: 0;
  padding: 8px 10px;
  background: #f7f8fa;
  border: 1px solid #f0f1f3;
  border-radius: 6px;
  font-size: 12px;
  font-family: var(--mono, ui-monospace, Menlo, Consolas, monospace);
  color: #4e5969;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  max-width: 520px;
}
.dna-reasoning {
  font-size: 13px;
  color: #4e5969;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
