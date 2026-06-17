<script setup lang="ts">
/**
 * PRD-A-015 批1 — 题目属性编辑页（/question/attributes/:id）。
 *
 * 单栏分区：基础设置（可编辑：题型/难度/章节，自由标签只读）+ AI 打标维度（只读展示）
 *   + 打标元数据（只读）+ 高级属性（只读）。本批仅「基础设置」可保存回写。
 *
 * 权限：本人题（createUser=登录 id）或 superadmin 才可编辑；非 canEdit 全禁用 + 顶部提示，保存禁用。
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

// ── 基础设置表单（可编辑）────────────────────────────────────────────────────
const QUESTION_TYPES = [
  { label: '选择题', value: 1 },
  { label: '填空题', value: 4 },
  { label: '简答题', value: 5 },
]
const form = ref<{ questionType: number; difficult: number; subjectId: string }>({
  questionType: 1,
  difficult: 0,
  subjectId: '',
})
// 记录加载时的原值，保存时只传「变了的」字段。
const original = ref<{ questionType: number; difficult: number; subjectId: string }>({
  questionType: 1,
  difficult: 0,
  subjectId: '',
})

// ── 映射表（只读展示用文字）────────────────────────────────────────────────
const LABEL_STATUS_MAP: Record<number, string> = {
  0: '未标',
  1: 'AI 已标',
  2: '已审核',
  3: '争议',
}
const SOURCE_TYPE_MAP: Record<number, string> = {
  1: '中考真题',
  2: '模拟',
  3: '期末',
  4: '月考',
  5: '单元',
  6: '自编',
  9: '其他',
}
const ANNOTATE_STATUS_MAP: Record<number, string> = {
  0: '未标',
  1: '已标全',
  2: '部分',
}

// 空值占位
const DASH = '—'

// 通用：空值显 DASH
function display(v: unknown): string {
  if (v === null || v === undefined || v === '') return DASH
  return String(v)
}

// dim3Skill：JSON 字符串 → 数组（解析失败显原文）
const dim3SkillList = computed<string[] | null>(() => {
  const raw = detail.value?.dim3Skill
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.map((x) => String(x))
    return null
  } catch {
    return null
  }
})

// auxTags：JSON 字符串 → key:value 列表（解析失败回落原文）
const auxTagsEntries = computed<Array<[string, string]> | null>(() => {
  const raw = detail.value?.auxTags
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.entries(parsed).map(([k, v]) => [k, String(v)] as [string, string])
    }
    return null
  } catch {
    return null
  }
})

// labeledAt：时间戳 / 字符串格式化（空显 DASH）
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
      form.value.questionType = res.questionType != null ? Number(res.questionType) : 1
      form.value.difficult = res.difficult != null ? Number(res.difficult) : 0
      form.value.subjectId = res.subjectId != null ? String(res.subjectId) : ''
      original.value = { ...form.value }
    }
  } catch (e) {
    console.warn('[question-attributes] loadDetail failed', e)
    ElMessage.warning('题目加载失败（接口需登录态）')
  } finally {
    loading.value = false
  }
}

// ── 保存（本批仅基础设置生效）──────────────────────────────────────────────
async function handleSave() {
  if (!canEdit.value) {
    ElMessage.warning('非本人题/无权编辑')
    return
  }
  if (!detail.value) return

  // 只收集「变了的」字段
  const payload: UpdateAttrsPayload = { questionId: questionId.value }
  if (form.value.questionType !== original.value.questionType) {
    payload.questionType = form.value.questionType
  }
  if (form.value.difficult !== original.value.difficult) {
    payload.difficult = form.value.difficult
  }
  if (form.value.subjectId !== original.value.subjectId) {
    payload.subjectId = form.value.subjectId
  }

  // 没有任何改动则无需调接口
  if (
    payload.questionType === undefined &&
    payload.difficult === undefined &&
    payload.subjectId === undefined
  ) {
    ElMessage.info('没有改动需要保存')
    return
  }

  saving.value = true
  try {
    const res = await updateQuestionAttrs(payload)
    ElMessage.success('保存成功')
    // 用返回值刷新表单 + 详情
    if (res) {
      detail.value = res
      form.value.questionType = res.questionType != null ? Number(res.questionType) : form.value.questionType
      form.value.difficult = res.difficult != null ? Number(res.difficult) : form.value.difficult
      form.value.subjectId = res.subjectId != null ? String(res.subjectId) : form.value.subjectId
      original.value = { ...form.value }
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
      <span class="topbar-title">题目属性</span>
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
      <!-- ══ 基础设置（可编辑）══ -->
      <el-card class="attr-card" shadow="never">
        <template #header>
          <span class="card-title">基础设置</span>
        </template>
        <div class="field-list">
          <div class="field-row">
            <span class="field-label">题型</span>
            <el-select v-model="form.questionType" :disabled="!canEdit" style="width: 160px">
              <el-option
                v-for="t in QUESTION_TYPES"
                :key="t.value"
                :label="t.label"
                :value="t.value"
              />
            </el-select>
          </div>
          <div class="field-row">
            <span class="field-label">难度</span>
            <el-rate v-model="form.difficult" :max="4" :disabled="!canEdit" />
          </div>
          <div class="field-row">
            <span class="field-label">章节</span>
            <div class="field-control">
              <ChapterPicker
                v-if="canEdit"
                v-model="form.subjectId"
              />
              <span v-else class="field-value">{{ display(form.subjectId) }}</span>
            </div>
          </div>
          <div class="field-row">
            <span class="field-label">自由标签</span>
            <div class="field-control">
              <template v-if="detail?.freeTags && detail.freeTags.length > 0">
                <el-tag
                  v-for="ft in detail.freeTags"
                  :key="ft.id"
                  size="small"
                  class="readonly-tag"
                >
                  {{ ft.name }}
                </el-tag>
              </template>
              <span v-else class="field-empty">暂无</span>
            </div>
          </div>
        </div>
      </el-card>

      <!-- ══ AI 打标维度（本批只读展示）══ -->
      <el-card class="attr-card" shadow="never">
        <template #header>
          <span class="card-title">AI 打标维度</span>
          <span class="card-hint">本批只读</span>
        </template>
        <div class="field-list">
          <div class="field-row">
            <span class="field-label">知识点 (dim1)</span>
            <span class="field-value">{{ display(detail?.dim1KpId) }}</span>
          </div>
          <div class="field-row">
            <span class="field-label">题型 (dim2)</span>
            <span class="field-value">{{ display(detail?.dim2Qtype) }}</span>
          </div>
          <div class="field-row">
            <span class="field-label">思维方法 (dim3)</span>
            <div class="field-control">
              <template v-if="dim3SkillList && dim3SkillList.length > 0">
                <el-tag
                  v-for="(s, i) in dim3SkillList"
                  :key="i"
                  size="small"
                  type="info"
                  class="readonly-tag"
                >
                  {{ s }}
                </el-tag>
              </template>
              <span v-else-if="detail?.dim3Skill" class="field-value">{{ detail.dim3Skill }}</span>
              <span v-else class="field-value">{{ DASH }}</span>
            </div>
          </div>
          <div class="field-row">
            <span class="field-label">难度 (dim4)</span>
            <span class="field-value">{{ display(detail?.dim4Difficulty) }}</span>
          </div>
          <div class="field-row">
            <span class="field-label">结构指纹 (dim5)</span>
            <span class="field-value">{{ display(detail?.dim5Structure) }}</span>
          </div>
          <div class="field-row">
            <span class="field-label">辅标签</span>
            <div class="field-control">
              <template v-if="auxTagsEntries && auxTagsEntries.length > 0">
                <el-tag
                  v-for="([k, v], i) in auxTagsEntries"
                  :key="i"
                  size="small"
                  type="info"
                  class="readonly-tag"
                >
                  {{ k }}: {{ v }}
                </el-tag>
              </template>
              <span v-else-if="detail?.auxTags" class="field-value">{{ detail.auxTags }}</span>
              <span v-else class="field-value">{{ DASH }}</span>
            </div>
          </div>
          <div class="field-row">
            <span class="field-label">标注状态</span>
            <span class="field-value">
              {{ detail?.labelStatus != null ? (LABEL_STATUS_MAP[detail.labelStatus] ?? detail.labelStatus) : DASH }}
            </span>
          </div>
        </div>
      </el-card>

      <!-- ══ 打标元数据（只读）══ -->
      <el-card class="attr-card" shadow="never">
        <template #header>
          <span class="card-title">打标元数据</span>
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
        </div>
      </el-card>

      <!-- ══ 高级属性（本批只读展示）══ -->
      <el-card class="attr-card" shadow="never">
        <template #header>
          <span class="card-title">高级属性</span>
          <span class="card-hint">本批只读</span>
        </template>
        <div class="field-list">
          <div class="field-row">
            <span class="field-label">标准分值</span>
            <span class="field-value">{{ display(detail?.baseScore) }}</span>
          </div>
          <div class="field-row">
            <span class="field-label">来源类型</span>
            <span class="field-value">
              {{ detail?.sourceType != null ? (SOURCE_TYPE_MAP[detail.sourceType] ?? detail.sourceType) : DASH }}
            </span>
          </div>
          <div class="field-row">
            <span class="field-label">地域</span>
            <span class="field-value">{{ display(detail?.regionCode) }}</span>
          </div>
          <div class="field-row">
            <span class="field-label">变式关系</span>
            <span class="field-value">{{ display(detail?.variantRelation) }}</span>
          </div>
          <div class="field-row">
            <span class="field-label">母题</span>
            <span class="field-value">{{ display(detail?.motherQuestionId) }}</span>
          </div>
          <div class="field-row">
            <span class="field-label">标注完整度</span>
            <span class="field-value">
              {{ detail?.annotateStatus != null ? (ANNOTATE_STATUS_MAP[detail.annotateStatus] ?? detail.annotateStatus) : DASH }}
            </span>
          </div>
          <div class="field-row">
            <span class="field-label">导入来源</span>
            <span class="field-value">{{ display(detail?.importSource) }}</span>
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
  border-left: 4px solid #1e8a8a;
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

.field-empty {
  font-size: 13px;
  color: #c9cdd4;
}

.readonly-tag {
  margin-right: 2px;
}
</style>
