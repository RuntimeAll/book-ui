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
  type UpdateAttrsPayload,
} from '@/api/question/index'
import ChapterPicker from '@/components/business/ChapterPicker/index.vue'
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
const SOURCE_TYPE_OPTIONS = [
  { label: '中考真题', value: 1 },
  { label: '模拟', value: 2 },
  { label: '期末', value: 3 },
  { label: '月考', value: 4 },
  { label: '单元', value: 5 },
  { label: '自编', value: 6 },
  { label: '其他', value: 9 },
]
const ANNOTATE_STATUS_OPTIONS = [
  { label: '未标', value: 0 },
  { label: '已标全', value: 1 },
  { label: '部分', value: 2 },
]

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
}
function blankForm(): AdvForm {
  return {
    dim1KpId: '', dim2Qtype: null, dim4Difficulty: null,
    dim5Structure: '', labelStatus: null,
    baseScore: null, sourceType: null, regionCode: '',
    variantRelation: '', motherQuestionId: '', annotateStatus: null,
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
      const f: AdvForm = {
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
      }
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
      const nf: AdvForm = {
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
      }
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
      <!-- ══ AI 打标维度（可编辑）══ -->
      <el-card class="attr-card" shadow="never">
        <template #header>
          <span class="card-title">AI 打标维度</span>
        </template>
        <div class="field-list">
          <div class="field-row">
            <span class="field-label">知识点 (dim1)</span>
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
            <span class="field-label">难度 (dim4)</span>
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
</style>
