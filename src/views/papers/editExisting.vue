<script setup lang="ts">
/**
 * 试卷编辑页（PRD-A-005 T4）— 编辑「已存在试卷」。
 *
 * 区别于 /papers/edit（自动组卷工作台，读 localStorage paperDraft）：
 * 本页走 /papers/edit/:id，加载真实试卷详情（getPaperDetail），支持：
 *   - 题目排序（↑↓ 按钮，全局列表移位）
 *   - 删题
 *   - 增题（复用试题栏 useQuestionBasket + 共享题卡 QuestionCard，禁重造）
 *   - 每题分值编辑 + 试卷名编辑
 * 保存调 POST /teacher/exam/paper/update（契约 manual），保存成功后重新拉详情刷新。
 *
 * 复用：QuestionCard（共享题卡）/ useQuestionBasket（试题栏 singleton）/ getCurrentUser（onMounted 兜底）。
 * 题图沿用 PNG 无损（QuestionCard 内部 referrerpolicy + onerror，不压缩）。
 */
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowLeft, Top, Bottom, Delete, Plus, DocumentChecked } from '@element-plus/icons-vue'
import {
  getPaperDetail,
  type PaperDetailVo,
  type PaperSourceQuestion,
  type QuestionItem,
} from '@/api/question/index'
import { updateExamPaper, type UpdatePaperQuestion } from '@/api/paper/index'
import { useQuestionBasket } from '@/composables/useQuestionBasket'
import { useUserStore } from '@/store/user'
import { getCurrentUser } from '@/api/user/index'
import QuestionCard from '@/components/business/QuestionCard/index.vue'

// ── 路由 ─────────────────────────────────────────────────────
const route = useRoute()
const router = useRouter()
const paperId = computed<number>(() => Number(route.params.id))

// ── 试题栏（增题来源，全局 singleton）──────────────────────────
const basket = useQuestionBasket()
const userStore = useUserStore()

// ── 本地可编辑 state ──────────────────────────────────────────
// 编辑行：在 PaperSourceQuestion 基础上确保 sectionId / 单题分 _score 本地可改
interface EditRow extends PaperSourceQuestion {
  _sectionId: number // 所属大题（新增题落默认 section）
  _score: number // 本地编辑分值
}

const paperName = ref<string>('')
const editRows = ref<EditRow[]>([])
const loading = ref(false)
const saving = ref(false)

// 增题弹窗
const addDialogVisible = ref(false)

// 默认 sectionId（新增题挂到第一个大题；无大题时兜底 0，BE 自建）
const defaultSectionId = ref<number>(0)

// ── 派生 ─────────────────────────────────────────────────────
const totalScore = computed<number>(() =>
  editRows.value.reduce((sum, r) => sum + (Number(r._score) || 0), 0),
)

// 已在试卷内的题 id（增题弹窗里据此置灰「已添加」）
const paperQuestionIds = computed<Set<number>>(
  () => new Set(editRows.value.map((r) => r.id)),
)

// ── 加载详情 ─────────────────────────────────────────────────
async function loadDetail() {
  if (!paperId.value) {
    ElMessage.error('缺少试卷 ID')
    return
  }
  loading.value = true
  try {
    const res = (await getPaperDetail(paperId.value)) as PaperDetailVo | null
    if (!res || !res.paperId) {
      ElMessage.warning('试卷数据加载失败')
      return
    }
    paperName.value = res.paperName || ''
    const sections = Array.isArray(res.sections) ? res.sections : []
    if (sections.length > 0) {
      defaultSectionId.value = sections[0].sectionId
    }
    // flatten 所有大题的题，保留各自 sectionId / 单题分
    const rows: EditRow[] = []
    sections.forEach((sec) => {
      (sec.questions || []).forEach((q) => {
        rows.push({
          ...q,
          _sectionId: sec.sectionId,
          _score: Number(q.pqScore ?? q.score ?? 0),
        })
      })
    })
    // 按原始 sort/sortNum 排（BE 一般已排好，兜底再排一次）
    rows.sort((a, b) => (Number(a.sortNum ?? a.sort ?? 0)) - (Number(b.sortNum ?? b.sort ?? 0)))
    editRows.value = rows
  } catch (e) {
    console.warn('[papers/editExisting] loadDetail failed', e)
  } finally {
    loading.value = false
  }
}

// ── 排序 / 删除 ───────────────────────────────────────────────
function moveUp(idx: number) {
  if (idx <= 0) return
  const arr = [...editRows.value]
  ;[arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]]
  editRows.value = arr
}

function moveDown(idx: number) {
  if (idx >= editRows.value.length - 1) return
  const arr = [...editRows.value]
  ;[arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]]
  editRows.value = arr
}

function deleteRow(idx: number) {
  const arr = [...editRows.value]
  arr.splice(idx, 1)
  editRows.value = arr
  ElMessage.success('已移除该题')
}

// ── 增题（从试题栏挑）────────────────────────────────────────
function openAddDialog() {
  addDialogVisible.value = true
}

// 试题栏里、且尚未在卷内的题
const addableBasketItems = computed<QuestionItem[]>(() =>
  basket.items.value.filter((q) => !paperQuestionIds.value.has(q.id)),
)

function addQuestionFromBasket(q: QuestionItem) {
  if (paperQuestionIds.value.has(q.id)) {
    ElMessage.info('该题已在试卷中')
    return
  }
  editRows.value = [
    ...editRows.value,
    {
      ...(q as PaperSourceQuestion),
      _sectionId: defaultSectionId.value,
      _score: Number(q.score ?? 0),
    },
  ]
  ElMessage.success('已添加到试卷')
}

// ── 保存 ─────────────────────────────────────────────────────
async function handleSave() {
  if (editRows.value.length === 0) {
    ElMessage.warning('试卷至少需要 1 道题')
    return
  }
  if (!paperName.value.trim()) {
    ElMessage.warning('请输入试卷名称')
    return
  }
  saving.value = true
  try {
    // sort 按当前列表顺序重排（1-based）
    const questions: UpdatePaperQuestion[] = editRows.value.map((r, i) => ({
      questionId: r.id,
      sectionId: r._sectionId,
      sort: i + 1,
      score: Number(r._score) || 0,
    }))
    const updated = (await updateExamPaper({
      paperId: paperId.value,
      name: paperName.value.trim(),
      questions,
    })) as PaperDetailVo | null
    // 仅成功（code===1，拦截器已拆出 response）才提示成功 + 刷新已保存态；
    // 失败时拦截器已 Promise.reject，直接走 catch，绝不到这里。
    ElMessage.success('保存成功')
    // 保存后刷新详情：优先用返回 VO，缺失则重拉
    if (updated && updated.paperId) {
      paperName.value = updated.paperName || paperName.value
      const sections = Array.isArray(updated.sections) ? updated.sections : []
      if (sections.length > 0) defaultSectionId.value = sections[0].sectionId
      const rows: EditRow[] = []
      sections.forEach((sec) => {
        (sec.questions || []).forEach((q) => {
          rows.push({
            ...q,
            _sectionId: sec.sectionId,
            _score: Number(q.pqScore ?? q.score ?? 0),
          })
        })
      })
      rows.sort((a, b) => (Number(a.sortNum ?? a.sort ?? 0)) - (Number(b.sortNum ?? b.sort ?? 0)))
      editRows.value = rows
    } else {
      await loadDetail()
    }
  } catch (e: any) {
    // 🔴 保存失败（BE code!==1 / HTTP 错误 / 网络异常）= 阻断式报错，绝不吞。
    // 拦截器对 code!==1 已弹过一次 message，这里兜底再确保用户看到失败原因；
    // 不更新任何「已保存」态：editRows / paperName 保持当前内存编辑值 → 可直接重试保存。
    const msg = e?.message || '保存失败，请稍后重试'
    ElMessage.error(`保存失败：${msg}`)
    console.warn('[papers/editExisting] save failed', e)
  } finally {
    saving.value = false
  }
}

function goBack() {
  if (paperId.value) {
    router.push(`/papers/source/${paperId.value}`)
  } else {
    router.push('/papers/index')
  }
}

// ── 生命周期 ──────────────────────────────────────────────────
onMounted(async () => {
  // userInfo 内存态不持久化 → 业务页 onMounted 兜底拉当前用户回填 store
  if (!userStore.userInfo) {
    try {
      const info = await getCurrentUser()
      if (info) userStore.setUserInfo(info)
    } catch (e) {
      console.warn('[papers/editExisting] getCurrentUser fallback failed', e)
    }
  }
  await loadDetail()
})
</script>

<template>
  <div v-loading="loading" class="paper-edit-existing">
    <!-- 顶栏 -->
    <div class="top-bar">
      <el-button size="small" class="back-btn" @click="goBack">
        <el-icon><ArrowLeft /></el-icon>返回
      </el-button>
      <div class="top-bar-center">
        <el-input
          v-model="paperName"
          placeholder="请输入试卷名称"
          class="title-input"
          size="default"
        />
      </div>
      <div class="top-bar-right">
        <div class="stat-pill">
          <span class="stat-num">{{ editRows.length }}</span><span class="stat-unit">题</span>
          <span class="stat-sep">·</span>
          <span class="stat-num total">{{ totalScore }}</span><span class="stat-unit">分</span>
        </div>
        <el-button @click="openAddDialog">
          <el-icon><Plus /></el-icon>增题
        </el-button>
        <el-button type="primary" :loading="saving" @click="handleSave">
          <el-icon><DocumentChecked /></el-icon>保存
        </el-button>
      </div>
    </div>

    <!-- 题列表 -->
    <div class="edit-body">
      <el-empty
        v-if="!loading && editRows.length === 0"
        description="试卷暂无题目，点击「增题」从试题栏添加"
      >
        <el-button type="primary" @click="openAddDialog">增题</el-button>
      </el-empty>

      <div
        v-for="(row, idx) in editRows"
        :key="row.id"
        class="edit-row"
      >
        <!-- 题号 + 排序/删除 列 -->
        <div class="row-ops">
          <span class="row-index">{{ idx + 1 }}</span>
          <el-button
            size="small"
            circle
            :disabled="idx === 0"
            @click="moveUp(idx)"
          >
            <el-icon><Top /></el-icon>
          </el-button>
          <el-button
            size="small"
            circle
            :disabled="idx === editRows.length - 1"
            @click="moveDown(idx)"
          >
            <el-icon><Bottom /></el-icon>
          </el-button>
          <el-button
            size="small"
            type="danger"
            plain
            circle
            @click="deleteRow(idx)"
          >
            <el-icon><Delete /></el-icon>
          </el-button>
        </div>

        <!-- 题卡（复用共享组件，仅展示，操作按钮全关）-->
        <div class="row-card">
          <QuestionCard :question="row" :actions="[]" />
          <div class="row-score">
            <span class="row-score-label">分值</span>
            <el-input-number
              v-model="row._score"
              :min="0"
              :max="100"
              :step="1"
              size="small"
              controls-position="right"
              style="width: 100px;"
            />
            <span class="row-score-unit">分</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 增题弹窗：从试题栏挑 -->
    <el-dialog
      v-model="addDialogVisible"
      title="从试题栏增题"
      width="70%"
      :close-on-click-modal="false"
    >
      <el-empty
        v-if="basket.items.value.length === 0"
        description="试题栏为空，请先在题库中加题到试题栏"
      />
      <el-alert
        v-else-if="addableBasketItems.length === 0"
        type="info"
        :closable="false"
        title="试题栏内题目均已在本试卷中"
        show-icon
      />
      <el-scrollbar v-else max-height="500px">
        <div
          v-for="q in addableBasketItems"
          :key="q.id"
          class="add-item"
        >
          <div class="add-item-card">
            <QuestionCard :question="q" :actions="[]" />
          </div>
          <el-button
            type="primary"
            size="small"
            @click="addQuestionFromBasket(q)"
          >
            <el-icon><Plus /></el-icon>添加
          </el-button>
        </div>
      </el-scrollbar>

      <template #footer>
        <el-button @click="addDialogVisible = false">关闭</el-button>
        <el-button type="primary" @click="basket.openDialog()">打开试题栏管理</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.paper-edit-existing {
  min-height: 100vh;
  background: #f0f2f5;
}

/* 顶栏 */
.top-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 24px;
  height: 56px;
  background: #fff;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
  position: sticky;
  top: 0;
  z-index: 100;
}

.back-btn {
  display: flex;
  align-items: center;
  gap: 3px;
}

.top-bar-center {
  flex: 1;
  max-width: 480px;
}

.title-input :deep(.el-input__inner) {
  font-size: 16px;
  font-weight: 600;
}

.top-bar-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.stat-pill {
  display: flex;
  align-items: baseline;
  gap: 3px;
  background: #f8f9ff;
  border: 1px solid #e8f0ff;
  border-radius: 8px;
  padding: 6px 14px;
}

.stat-num {
  font-size: 18px;
  font-weight: 700;
  color: #1d2129;
}

.stat-num.total {
  color: #4080ff;
}

.stat-unit {
  font-size: 12px;
  color: #86909c;
}

.stat-sep {
  margin: 0 6px;
  color: #c9cdd4;
}

/* 题列表 */
.edit-body {
  padding: 16px 24px;
}

.edit-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 12px;
}

.row-ops {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding-top: 12px;
  flex-shrink: 0;
  width: 44px;
}

.row-index {
  width: 26px;
  height: 26px;
  background: linear-gradient(135deg, #4080ff, #3370e8);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.row-card {
  flex: 1;
  min-width: 0;
  background: #fff;
  border-radius: 10px;
  border: 1px solid #f2f3f5;
  padding: 4px 12px 12px;
}

.row-score {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 4px 0;
  border-top: 1px dashed #f2f3f5;
  margin-top: 4px;
}

.row-score-label,
.row-score-unit {
  font-size: 13px;
  color: #4e5969;
}

/* 增题弹窗 */
.add-item {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.add-item-card {
  flex: 1;
  min-width: 0;
}
</style>
