<script setup lang="ts">
/**
 * PRD-A-015 — 题目「高级属性」编辑页（/question/attributes/:id）。
 *
 * 🔴 2026-06-30 重排（维护者拍板，以 DB 实有数据为准）：
 *   - 只暴露「题目信息」相关维度；管理/溯源类（打标元数据、AI 解析、标注状态/完整度）全部撤掉。
 *   - 整表全空的列剔除：dim5 结构指纹 / 来源卷名 / 数学思想 / 建模框架 / 条件 / 打标依据。
 *   - 题型 dim2、难度 dim4 改字典下拉（不再裸数字步进器）。
 *   - 技术 DNA（DNA类型 / 验证种类 / 参数槽 / 变式画像）= 变式引擎内部基因，折叠到「技术 DNA（高级）」默认收起。
 *
 * 权限：本人题（createUser=登录 id）或 superadmin 才可编辑；非 canEdit 全禁用 + 顶部提示，保存禁用。
 * 保存：只回写「变了的」字段 → updateQuestionAttrs（POST /teacher/question/update-attrs，BE 条件 set）。
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
import { useDictStore, DICT_QUESTION_TYPE, DICT_QUESTION_DIFFICULTY, DICT_QUESTION_SOURCE_TYPE, DICT_QUESTION_ASSESSMENT_TYPE } from '@/store/dict'
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

// ── 受控词表（全走字典 SSOT，超管可维护）──────────────────────────────────────
const dict = useDictStore()
dict.load(DICT_QUESTION_TYPE)
dict.load(DICT_QUESTION_DIFFICULTY)
dict.load(DICT_QUESTION_SOURCE_TYPE)
dict.load(DICT_QUESTION_ASSESSMENT_TYPE)
// 题型 dim2 / 难度 dim4（数值码=value，label 取字典文案）
const QUESTION_TYPE_OPTIONS = computed(() =>
  dict.list(DICT_QUESTION_TYPE).map((d) => ({ label: d.dictLabel, value: Number(d.dictValue) })),
)
const DIFFICULTY_OPTIONS = computed(() =>
  dict.list(DICT_QUESTION_DIFFICULTY).map((d) => ({ label: d.dictLabel, value: Number(d.dictValue) })),
)
const SOURCE_TYPE_OPTIONS = computed(() =>
  dict.list(DICT_QUESTION_SOURCE_TYPE).map((d) => ({ label: d.dictLabel, value: Number(d.dictValue) })),
)
// 考察类型 dim2（string 码 = label）；与 22-题目维度 SSOT / 变式 EXAM_TYPES 同源（字典为准）。
const ASSESSMENT_TYPE_OPTIONS = computed(() =>
  dict.list(DICT_QUESTION_ASSESSMENT_TYPE).map((d) => d.dictLabel),
)

// ── JSON 串字段 try-parse（红线：解析失败原样字符串显示，绝不崩） ─────────────
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

// ── 可编辑表单（只保留「题目信息」相关、且 DB 有数据的维度）────────────────────
interface AdvForm {
  dim1KpId: string
  dim2Qtype: number | null
  dim4Difficulty: number | null
  baseScore: number | null
  sourceType: number | null
  regionCode: string
  examYear: string
  variantRelation: string
  motherQuestionId: string
  // AI 打标可编辑维
  solutionSkeleton: string
  scenario: string
  assessmentType: string
  hardPoints: string[]
  tags: string[]
}
function blankForm(): AdvForm {
  return {
    dim1KpId: '', dim2Qtype: null, dim4Difficulty: null,
    baseScore: null, sourceType: null, regionCode: '',
    examYear: '', variantRelation: '', motherQuestionId: '',
    solutionSkeleton: '', scenario: '', assessmentType: '',
    hardPoints: [], tags: [],
  }
}
const form = ref<AdvForm>(blankForm())
const original = ref<AdvForm>(blankForm())

const DASH = '—'
function display(v: unknown): string {
  if (v === null || v === undefined || v === '') return DASH
  return String(v)
}

function formFromDetail(res: QuestionDetail): AdvForm {
  const dna = res.dna ?? null
  return {
    dim1KpId: res.dim1KpId != null ? String(res.dim1KpId) : '',
    dim2Qtype: res.dim2Qtype ?? null,
    dim4Difficulty: res.dim4Difficulty ?? null,
    baseScore: res.baseScore ?? null,
    sourceType: res.sourceType ?? null,
    regionCode: res.regionCode != null ? String(res.regionCode) : '',
    examYear: res.examYear != null ? String(res.examYear) : '',
    variantRelation: res.variantRelation != null ? String(res.variantRelation) : '',
    motherQuestionId: res.motherQuestionId != null ? String(res.motherQuestionId) : '',
    solutionSkeleton: dna?.solutionSkeleton != null ? String(dna.solutionSkeleton) : '',
    scenario: dna?.scenario != null ? String(dna.scenario) : '',
    assessmentType: dna?.assessmentType != null ? String(dna.assessmentType) : '',
    hardPoints: parseJsonArr(dna?.hardPoints),
    tags: parseJsonArr(dna?.tags),
  }
}

// ── DNA 只读维 ──────────────────────────────────────────────────────────────
const dnaObj = computed<QuestionDna | null>(() => detail.value?.dna ?? null)
const hasDna = computed(() => !!dnaObj.value)
// 展示用：突破点（与学术 DNA 同区）
const breakthroughPoints = computed(() => parseJsonArr(dnaObj.value?.breakthroughPoints))
// 技术 DNA（变式引擎内部基因，折叠默认收起）
const techDna = computed(() => {
  const d = dnaObj.value
  return {
    dnaType: d?.dnaType ?? '',
    verifyKind: d?.verifyKind ?? '',
    parametricSlots: parseJsonPretty(d?.parametricSlots),
    variationProfile: parseJsonPretty(d?.variationProfile),
  }
})
const hasTechDna = computed(() => {
  const t = techDna.value
  return !!(t.dnaType || t.verifyKind || t.parametricSlots || t.variationProfile)
})

// ── 解题模型（BE select 回填 models：biz_question_model JOIN biz_solution_model）──
// 类型在本页本地声明（不动共享 api/question 类型文件）；只读展示主/辅模型。
interface QuestionModel {
  modelId: string
  name: string
  category?: string | null
  difficultyTier?: number | null
  freqBand?: number | null
  isGold?: number | null
  isPrimary?: number | null
  role?: string | null
  source?: string | null
}
const models = computed<QuestionModel[]>(() => {
  const m = (detail.value as (QuestionDetail & { models?: QuestionModel[] }) | null)?.models
  return Array.isArray(m) ? m : []
})
const primaryModels = computed(() => models.value.filter((m) => m.isPrimary === 1))
const auxModels = computed(() => models.value.filter((m) => m.isPrimary !== 1))

// ── 数组维（难点/标签）按行编辑：computed 字符串代理（一行一条，读写互转） ──
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

  const setIf = (key: string, cur: unknown, old: unknown) => {
    if (cur !== old) {
      p[key] = cur
      changed = true
    }
  }
  setIf('dim1KpId', f.dim1KpId, o.dim1KpId)
  setIf('dim2Qtype', f.dim2Qtype, o.dim2Qtype)
  setIf('dim4Difficulty', f.dim4Difficulty, o.dim4Difficulty)
  setIf('baseScore', f.baseScore, o.baseScore)
  setIf('sourceType', f.sourceType, o.sourceType)
  setIf('regionCode', f.regionCode, o.regionCode)
  setIf('examYear', f.examYear, o.examYear)
  setIf('variantRelation', f.variantRelation, o.variantRelation)
  setIf('motherQuestionId', f.motherQuestionId, o.motherQuestionId)
  setIf('solutionSkeleton', f.solutionSkeleton, o.solutionSkeleton)
  setIf('scenario', f.scenario, o.scenario)
  setIf('assessmentType', f.assessmentType, o.assessmentType)
  const setArrIf = (key: string, cur: string[], old: string[]) => {
    if (JSON.stringify(cur) !== JSON.stringify(old)) {
      p[key] = cur
      changed = true
    }
  }
  setArrIf('hardPoints', f.hardPoints, o.hardPoints)
  setArrIf('tags', f.tags, o.tags)

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
      <!-- ══ 基础信息 ══ -->
      <el-card class="attr-card" shadow="never">
        <template #header>
          <span class="card-title">基础信息</span>
        </template>
        <div class="field-list">
          <div class="field-row">
            <!-- 命名对齐：题库这里的「知识点」= 母题卡的「主考点」 -->
            <span class="field-label">知识点 (dim1)<span class="field-note">(主考点)</span></span>
            <div class="field-control">
              <ChapterPicker v-if="canEdit" v-model="form.dim1KpId" />
              <span v-else class="field-value">{{ display(form.dim1KpId) }}</span>
            </div>
          </div>
          <div class="field-row">
            <span class="field-label">题型 (dim2)</span>
            <el-select
              v-model="form.dim2Qtype"
              :disabled="!canEdit"
              clearable
              placeholder="题型"
              style="width: 200px"
            >
              <el-option v-for="t in QUESTION_TYPE_OPTIONS" :key="t.value" :label="t.label" :value="t.value" />
            </el-select>
          </div>
          <div class="field-row">
            <span class="field-label">难度 (dim4)</span>
            <el-select
              v-model="form.dim4Difficulty"
              :disabled="!canEdit"
              clearable
              placeholder="难度"
              style="width: 200px"
            >
              <el-option v-for="d in DIFFICULTY_OPTIONS" :key="d.value" :label="d.label" :value="d.value" />
            </el-select>
          </div>
        </div>
      </el-card>

      <!-- ══ 学术 DNA（AI 打标，部分可编辑）══ -->
      <el-card class="attr-card" shadow="never">
        <template #header>
          <span class="card-title">学术 DNA</span>
          <span class="card-hint">真实打标 · 题目信息维度</span>
        </template>

        <div v-if="!hasDna" class="dna-empty">该题暂无 AI 打标数据</div>

        <div v-else class="field-list">
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
            <span class="field-label">突破点</span>
            <div class="field-control">
              <template v-if="breakthroughPoints.length">
                <el-tag v-for="(bp, i) in breakthroughPoints" :key="i" type="success" size="small" class="dna-chip">{{ bp }}</el-tag>
              </template>
              <span v-else class="field-value dna-muted">未标</span>
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
        </div>
      </el-card>

      <!-- ══ 解题模型（命中的解法基因，只读）══ -->
      <el-card v-if="models.length" class="attr-card" shadow="never">
        <template #header>
          <span class="card-title">解题模型</span>
          <span class="card-hint">命中的解法基因 · 只读</span>
        </template>
        <div class="field-list">
          <div class="field-row field-row-top">
            <span class="field-label">主模型</span>
            <div class="field-control">
              <template v-if="primaryModels.length">
                <div v-for="m in primaryModels" :key="m.modelId" class="model-row">
                  <span class="model-name">{{ m.name }}</span>
                  <el-tag v-if="m.category" size="small" type="info" class="dna-chip">{{ m.category }}</el-tag>
                  <el-tag v-if="m.isGold === 1" size="small" type="warning" class="dna-chip">金标</el-tag>
                  <span class="model-id">{{ m.modelId }}</span>
                </div>
              </template>
              <span v-else class="field-value dna-muted">无</span>
            </div>
          </div>
          <div class="field-row field-row-top">
            <span class="field-label">辅助模型</span>
            <div class="field-control">
              <template v-if="auxModels.length">
                <div v-for="m in auxModels" :key="m.modelId" class="model-row">
                  <span class="model-name">{{ m.name }}</span>
                  <el-tag v-if="m.category" size="small" type="info" class="dna-chip">{{ m.category }}</el-tag>
                  <el-tag v-if="m.isGold === 1" size="small" type="warning" class="dna-chip">金标</el-tag>
                  <span class="model-id">{{ m.modelId }}</span>
                </div>
              </template>
              <span v-else class="field-value dna-muted">无</span>
            </div>
          </div>
        </div>
      </el-card>

      <!-- ══ 来源 / 血缘（可编辑）══ -->
      <el-card class="attr-card" shadow="never">
        <template #header>
          <span class="card-title">来源 / 血缘</span>
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
        </div>
      </el-card>

      <!-- ══ 技术 DNA（变式引擎内部基因，默认收起）══ -->
      <el-collapse v-if="hasDna && hasTechDna" class="tech-dna-collapse">
        <el-collapse-item name="tech">
          <template #title>
            <span class="tech-dna-title">技术 DNA（高级）</span>
            <span class="tech-dna-hint">变式引擎内部基因 · 只读</span>
          </template>
          <div class="field-list">
            <div v-if="techDna.dnaType" class="field-row">
              <span class="field-label">DNA 类型</span>
              <span class="field-value">{{ display(techDna.dnaType) }}</span>
            </div>
            <div v-if="techDna.verifyKind" class="field-row">
              <span class="field-label">验证种类</span>
              <span class="field-value">{{ display(techDna.verifyKind) }}</span>
            </div>
            <div v-if="techDna.parametricSlots" class="field-row field-row-top">
              <span class="field-label">参数槽</span>
              <pre class="dna-json">{{ techDna.parametricSlots }}</pre>
            </div>
            <div v-if="techDna.variationProfile" class="field-row field-row-top">
              <span class="field-label">变式画像</span>
              <pre class="dna-json">{{ techDna.variationProfile }}</pre>
            </div>
          </div>
        </el-collapse-item>
      </el-collapse>
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

/* 解题模型行 */
.model-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  width: 100%;
  margin-bottom: 6px;
}
.model-row:last-child {
  margin-bottom: 0;
}
.model-name {
  font-size: 13px;
  font-weight: 600;
  color: #1d2129;
}
.model-id {
  font-size: 11px;
  color: #a8acb3;
  font-family: var(--mono, ui-monospace, Menlo, Consolas, monospace);
}

/* 技术 DNA 折叠 */
.tech-dna-collapse {
  border: 1px solid #f2f3f5;
  border-radius: 10px;
  background: #fff;
  padding: 0 16px;
}
.tech-dna-title {
  font-size: 14px;
  font-weight: 600;
  color: #4e5969;
}
.tech-dna-hint {
  margin-left: 10px;
  font-size: 12px;
  color: #c9cdd4;
}
</style>
