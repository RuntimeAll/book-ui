<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowLeft, Check, ShoppingCart, Edit, Star, InfoFilled, Download, Top, Bottom, Delete, Plus, DocumentChecked, Close } from '@element-plus/icons-vue'
import {
  getPaperDetail,
  removeFavorite,
  type PaperDetailVo,
  type PaperSectionVo,
  type PaperSourceQuestion,
  type QuestionItem,
} from '@/api/question/index'
import { updateExamPaper, type UpdatePaperQuestion } from '@/api/paper/index'
import FreeTagList from '@/components/business/FreeTagList/index.vue'
import PaperPreview from '@/components/business/PaperPreview/index.vue'
import QuestionCard from '@/components/business/QuestionCard/index.vue'
import SketchPad from '@/components/business/SketchPad/index.vue'
import FavoriteFolderDrawer from '@/components/FavoriteFolderDrawer/index.vue'
import { useQuestionBasket } from '@/composables/useQuestionBasket'
import { useUserStore } from '@/store/user'
import { getCurrentUser } from '@/api/user'

// ── 路由 ────────────────────────────────────────────────────
const route = useRoute()
const router = useRouter()
const paperId = computed(() => route.params.id as string)

// ── 试题栏 composable（E 段③ — 全局 singleton，跟题库 / 全局 FAB 联动）──
const basket = useQuestionBasket()

// ── owner 判定（PRD-A-005 收尾 C 段）──
// 本人卷 = detail.createBy === 当前登录用户 id（PaperDetailVo.createBy = String）→ 可编辑；
// 公共卷（非本人）→ "编辑试卷"按钮置灰 + tooltip。
const userStore = useUserStore()
const isOwner = computed(() => {
  const uid = userStore.userInfo?.id
  const createBy = detail.value?.createBy
  if (uid == null || createBy == null) return false
  return String(createBy) === String(uid)
})

// ── 卷详情数据（E 段② BE 真接口 POST /teacher/exam/paper/detail） ──
const detail = ref<PaperDetailVo | null>(null)
const loading = ref(false)

// 所有题（flatten — 空状态判断 + basket 操作遍历用）
const allQuestions = computed<PaperSourceQuestion[]>(() => {
  if (!detail.value || !Array.isArray(detail.value.sections)) return []
  return detail.value.sections.flatMap((s) => s.questions || [])
})

// ── 导出 PDF（复用 PaperPreview 预览弹窗内置的 jsPDF 无损导出链路）──
const previewVisible = ref(false)
const exportPaperName = computed(() => detail.value?.paperName || '试卷')
// 按卷内大题顺序 flatten 的题目 id（= 导出/预览显示顺序）
const exportQuestionIds = computed<number[]>(() => allQuestions.value.map((q) => q.id))

function handleExportPaper() {
  if (exportQuestionIds.value.length === 0) {
    ElMessage.warning('试卷暂无题目，无法导出')
    return
  }
  previewVisible.value = true
}

async function loadPaperDetail() {
  loading.value = true
  detail.value = null
  try {
    const res = await getPaperDetail(paperId.value)
    // BE 真响应：response 内层 = PaperDetailVo（advice 解包后 request.post 拿到的）
    if (res && (res as { paperId?: unknown }).paperId) {
      detail.value = res as PaperDetailVo
    } else {
      detail.value = null
      ElMessage.warning('试卷数据加载失败：响应为空')
    }
  } catch (e) {
    console.warn('[paper-detail] POST /teacher/exam/paper/detail failed', e)
    detail.value = null
    ElMessage.warning('试卷数据加载失败（接口需登录态）')
  } finally {
    loading.value = false
  }
}

// ── 中文大题序号（一/二/三/四…）──
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
function sectionLabel(index: number): string {
  return CN_NUM[index] ?? String(index + 1)
}

// 单 section 总分
function sectionTotalScore(section: PaperSectionVo): number {
  if (!section.questions) return 0
  const sum = section.questions.reduce(
    (acc, q) => acc + (Number(q.pqScore ?? q.score ?? 0) || 0),
    0,
  )
  // 去掉小数尾巴（30.0 → 30）
  return Math.round(sum * 100) / 100
}

// 题分（优先 pqScore，没有用 score）
function getQuestionScore(q: PaperSourceQuestion): number | null {
  const s = q.pqScore ?? q.score
  return s == null ? null : Number(s)
}

// ── 题型 ──
function getQuestionTypeLabel(type: number): string {
  const map: Record<number, string> = { 1: '选择题', 4: '填空题', 5: '简答题' }
  return map[type] ?? `题型${type}`
}

function getQuestionTypeTag(type: number): 'success' | 'warning' | 'info' | 'primary' | 'danger' {
  const map: Record<number, 'primary' | 'success' | 'warning'> = { 1: 'primary', 4: 'success', 5: 'warning' }
  return map[type] ?? 'info'
}

// ── 详情按钮 — 路由跳详情独立页（跟题库 question/index.vue:257-269 一致）──
function handleDetail(q: PaperSourceQuestion) {
  // 存 cache 供详情页兜底（接口 500 时从 localStorage 读）
  try {
    const cacheKey = 'book-ui:question-cache-by-id'
    const existing = JSON.parse(localStorage.getItem(cacheKey) || '{}')
    existing[String(q.id)] = q
    localStorage.setItem(cacheKey, JSON.stringify(existing))
  } catch (e) {
    console.warn('[paper-source] detail cache write failed', e)
  }
  router.push(`/question/detail/${q.id}`)
}

// ── 试题栏 toggle ──
async function handleBasketToggle(q: PaperSourceQuestion) {
  if (basket.isLoading(q.id)) return
  if (basket.basketIds.value.has(q.id)) {
    await basket.remove(q.id)
  } else {
    await basket.add(q)
  }
}

// ── 草稿纸 ──────────────────────────────────────────────────
const sketchVisible = ref(false)
function handleDraft() {
  sketchVisible.value = true
}

// ── 收藏（用户 2026-06-05 重修：对齐题库范式，走收藏目录抽屉 + 真态 isFavorite）──
// source 页题目现已带后端 isFavorite（PaperDetailServiceImpl LEFT JOIN biz_question_favorite），
// 故与题库一致：未收藏→弹收藏目录抽屉(addFavorite 选夹)，已收藏→直接 removeFavorite。星标反映真态、可持久。
const favDrawerVisible = ref(false)
const favDrawerQuestionId = ref<number>(0)

// 在 detail.sections[].questions[] 里按 id 定位题对象并 patch isFavorite（Vue3 深响应，直接改触发重渲染）
function patchFavorite(id: number, val: boolean) {
  for (const sec of detail.value?.sections ?? []) {
    const q = (sec.questions || []).find((x) => x.id === id)
    if (q) {
      q.isFavorite = val
      return
    }
  }
}

function handleFavorite(q: PaperSourceQuestion) {
  if (q.isFavorite) {
    // 已收藏 → 直接取消（乐观更新 + 异步调 API）
    patchFavorite(q.id, false)
    ElMessage.success('已取消收藏')
    removeFavorite(q.id).catch((e) => {
      console.warn('[source] removeFavorite failed (local state already updated)', e)
    })
  } else {
    // 未收藏 → 弹收藏目录抽屉（与题库一致）
    favDrawerQuestionId.value = q.id
    favDrawerVisible.value = true
  }
}

function handleFavDrawerSuccess(_folderId: number | string | undefined) {
  if (favDrawerQuestionId.value) patchFavorite(favDrawerQuestionId.value, true)
}

function goBack() {
  router.back()
}

// ══════════════════════════════════════════════════════════════
// PRD-A-006 — 查看 ⇄ 编辑 双态（编辑能力并入本页，废弃 editExisting.vue）
// 编辑态复用查看态题卡骨架（同 .source-question-card），仅右上操作区从
// 草稿/收藏/试题栏 换成 上移/下移/删除 + 分值（用户视觉铁则：禁另起一套卡）。
// ══════════════════════════════════════════════════════════════
type ViewMode = 'view' | 'edit'
const mode = ref<ViewMode>('view')

interface EditRow extends PaperSourceQuestion {
  _sectionId: number // 所属大题（新增题落默认 section）
  _score: number // 本地编辑分值
}
const editRows = ref<EditRow[]>([])
const editPaperName = ref<string>('')
const defaultSectionId = ref<number>(0)
const saving = ref(false)
const addDialogVisible = ref(false)

const totalScore = computed<number>(() =>
  editRows.value.reduce((sum, r) => sum + (Number(r._score) || 0), 0),
)
const paperQuestionIds = computed<Set<number>>(
  () => new Set(editRows.value.map((r) => r.id)),
)

// 从当前 detail 构建编辑行（flatten 大题，保留各自 sectionId + 单题分）
function buildEditRowsFromDetail() {
  const sections = detail.value?.sections ?? []
  if (sections.length > 0) defaultSectionId.value = sections[0].sectionId
  const rows: EditRow[] = []
  sections.forEach((sec) => {
    ;(sec.questions || []).forEach((q) => {
      rows.push({ ...q, _sectionId: sec.sectionId, _score: Number(q.pqScore ?? q.score ?? 0) })
    })
  })
  rows.sort((a, b) => Number(a.sortNum ?? a.sort ?? 0) - Number(b.sortNum ?? b.sort ?? 0))
  editRows.value = rows
  editPaperName.value = detail.value?.paperName || ''
}

// PRD-A-007：编辑按钮改指新两栏工作台（不再原地切 source.vue 内联编辑态）
function enterEdit() {
  if (!detail.value || !isOwner.value) return
  router.push(`/papers/workbench/${paperId.value}`)
}

function cancelEdit() {
  mode.value = 'view'
  editRows.value = []
}

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

// 增题（从试题栏挑，复用 useQuestionBasket，禁重造）
function openAddDialog() {
  addDialogVisible.value = true
}
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
    { ...(q as PaperSourceQuestion), _sectionId: defaultSectionId.value, _score: Number(q.score ?? 0) },
  ]
  ElMessage.success('已添加到试卷')
}

// 保存（调 update，owner 校验沿用；成功回查看态刷新；失败阻断不显示假已保存态）
async function handleSave() {
  if (editRows.value.length === 0) {
    ElMessage.warning('试卷至少需要 1 道题')
    return
  }
  if (!editPaperName.value.trim()) {
    ElMessage.warning('请输入试卷名称')
    return
  }
  saving.value = true
  try {
    const questions: UpdatePaperQuestion[] = editRows.value.map((r, i) => ({
      questionId: r.id,
      sectionId: r._sectionId,
      sort: i + 1,
      score: Number(r._score) || 0,
    }))
    await updateExamPaper({
      paperId: Number(paperId.value),
      name: editPaperName.value.trim(),
      questions,
    })
    ElMessage.success('保存成功')
    mode.value = 'view'
    editRows.value = []
    await loadPaperDetail()
  } catch (e: unknown) {
    const msg = (e as { message?: string })?.message || '保存失败，请稍后重试'
    ElMessage.error(`保存失败：${msg}`)
    console.warn('[paper-source] save failed', e)
  } finally {
    saving.value = false
  }
}

// PRD-A-007：编辑试卷 → 跳新两栏工作台
function handleEditPaper() {
  enterEdit()
}

onMounted(async () => {
  // owner 判定依赖 userInfo —— 刷新进详情页时内存态丢失，先兜底拉一次。
  if (!userStore.userInfo) {
    try {
      const info = await getCurrentUser()
      if (info) userStore.setUserInfo(info)
    } catch (e) {
      console.warn('[paper-source] getCurrentUser 兜底失败', e)
    }
  }
  await loadPaperDetail()
  // PRD-A-006：旧路由 /papers/edit/:id 重定向带 ?edit=1 → 自动进编辑态（owner 才生效）
  if (route.query.edit === '1' && isOwner.value) {
    enterEdit()
  }
})

// SPA 内 route.params.id 变化（从一个卷详情直接跳另一个卷）时重新加载 ——
// 否则 vue-router 复用本组件、onMounted 不重跑，detail 停留旧卷，
// 题目列表与 isOwner（编辑按钮显隐）全错（PRD-A-005 G6 回归暴露）。
// 切卷时回查看态、丢弃未保存的编辑行（PRD-A-006）。
watch(paperId, async () => {
  mode.value = 'view'
  editRows.value = []
  await loadPaperDetail()
})
</script>

<template>
  <div class="source-page">
    <!-- 顶部导航栏（PRD-A-006 双态：查看 / 编辑）-->
    <div class="source-topbar">
      <el-button link class="back-btn" @click="goBack">
        <el-icon><ArrowLeft /></el-icon>
        <span>返回</span>
      </el-button>

      <!-- ══ 查看态顶栏 ══ -->
      <template v-if="mode === 'view'">
        <div class="topbar-info">
          <span class="topbar-title">{{ detail?.paperName || '原卷预览' }}</span>
          <el-tag v-if="detail?.examYear" type="info" size="small">{{ detail.examYear }}</el-tag>
        </div>
        <div class="topbar-actions">
          <el-tooltip
            :disabled="!detail || isOwner"
            content="公共试卷不可编辑"
            placement="bottom"
          >
            <!-- 公共卷锁死：非本人卷 disabled + tooltip（span 包裹保证 disabled 按钮仍能触发 tooltip）-->
            <span>
              <el-button
                class="topbar-edit-btn"
                :disabled="!detail || !isOwner"
                @click="handleEditPaper"
              >
                <el-icon><Edit /></el-icon>
                <span>编辑试卷</span>
              </el-button>
            </span>
          </el-tooltip>
          <el-button
            type="primary"
            class="topbar-export-btn"
            :disabled="!detail || allQuestions.length === 0"
            @click="handleExportPaper"
          >
            <el-icon><Download /></el-icon>
            <span>导出 PDF</span>
          </el-button>
        </div>
      </template>

      <!-- ══ 编辑态顶栏（卷名输入居中、操作靠右）══ -->
      <template v-else>
        <div class="topbar-edit-name">
          <el-input
            v-model="editPaperName"
            placeholder="请输入试卷名称"
            class="edit-name-input"
            size="default"
          />
        </div>
        <div class="topbar-actions">
          <div class="edit-stat-pill">
            <span class="stat-num">{{ editRows.length }}</span><span class="stat-unit">题</span>
            <span class="stat-sep">·</span>
            <span class="stat-num total">{{ totalScore }}</span><span class="stat-unit">分</span>
          </div>
          <el-button @click="openAddDialog">
            <el-icon><Plus /></el-icon><span>增题</span>
          </el-button>
          <el-button @click="cancelEdit">
            <el-icon><Close /></el-icon><span>取消</span>
          </el-button>
          <el-button type="primary" :loading="saving" @click="handleSave">
            <el-icon><DocumentChecked /></el-icon><span>保存</span>
          </el-button>
        </div>
      </template>
    </div>

    <!-- 内容区 -->
    <div class="source-body">
      <div v-if="loading" class="source-loading">
        <el-skeleton :rows="12" animated style="max-width: 900px; margin: 0 auto;" />
      </div>

      <div v-else-if="!detail || allQuestions.length === 0" class="source-empty">
        <el-empty description="暂无题目数据（接口需登录态 / 试卷不存在）">
          <el-button type="primary" @click="goBack">返回</el-button>
        </el-empty>
      </div>

      <div v-else class="question-list">
        <!-- ══ 查看态：卷头 + 大题分组（PRD-A-006 view 分支）══ -->
        <template v-if="mode === 'view'">
        <!-- ══ 卷头区 ══ -->
        <div class="paper-header">
          <h2 class="paper-title">{{ detail.paperName }}</h2>
          <div class="paper-meta">
            <span v-if="detail.examYear" class="meta-chip meta-chip--year">{{ detail.examYear }}年</span>
            <span class="meta-chip">总分 <strong>{{ detail.score }}</strong></span>
            <span class="meta-chip">时长 <strong>{{ detail.suggestTime }}</strong> 分钟</span>
            <span class="meta-chip">共 <strong>{{ detail.questionCount }}</strong> 题</span>
          </div>
        </div>

        <!-- ══ 大题分组区 ══ -->
        <section
          v-for="(section, sIdx) in detail.sections"
          :key="section.sectionId"
          class="paper-section"
        >
          <!-- 大题标题 -->
          <h3 class="section-title">
            {{ sectionLabel(sIdx) }}、{{ section.title }}
            <span class="section-sub">（共 {{ section.questions?.length ?? 0 }} 题，共 {{ sectionTotalScore(section) }} 分）</span>
          </h3>

          <!-- 题目卡片 — misikt 风格：顶 meta + 题干 + 底 meta -->
          <div
            v-for="q in section.questions"
            :key="q.id"
            class="source-question-card"
            :class="{ 'in-basket': basket.basketIds.value.has(q.id) }"
          >
            <!-- ══ 顶部 meta 行：难度 + 知识点 + (右) 草稿/收藏/+试题栏 ══ -->
            <div class="q-meta-top">
              <div class="q-meta-top-left">
                <span class="meta-label">难度:</span>
                <el-rate
                  :model-value="q.difficult ?? 0"
                  :max="4"
                  disabled
                  class="meta-rate"
                />
                <span class="meta-label">知识点:</span>
                <el-tag
                  v-if="q.questionKnowledges && q.questionKnowledges.length > 0"
                  type="primary"
                  size="small"
                  class="primary-knowledge-tag"
                >
                  {{ q.questionKnowledges[0].knowledgeName || q.questionKnowledges[0].knowledgeId }}
                </el-tag>
                <span v-else class="knowledge-empty">暂无</span>
              </div>
              <div class="q-meta-top-right">
                <el-button size="small" link class="action-icon-btn" @click="handleDraft">
                  <el-icon><Edit /></el-icon>草稿
                </el-button>
                <el-button
                  size="small"
                  link
                  class="action-icon-btn"
                  :class="{ 'is-fav': q.isFavorite }"
                  @click="handleFavorite(q)"
                >
                  <el-icon><Star /></el-icon>{{ q.isFavorite ? '已收藏' : '收藏' }}
                </el-button>
                <el-button
                  size="small"
                  class="action-basket-btn"
                  :class="{ 'action-basket-btn--added': basket.basketIds.value.has(q.id) }"
                  :type="basket.basketIds.value.has(q.id) ? undefined : 'primary'"
                  :plain="!basket.basketIds.value.has(q.id)"
                  :loading="basket.isLoading(q.id)"
                  @click="handleBasketToggle(q)"
                >
                  <el-icon v-if="basket.basketIds.value.has(q.id)"><Check /></el-icon>
                  <el-icon v-else><ShoppingCart /></el-icon>
                  {{ basket.basketIds.value.has(q.id) ? '已在试题栏' : '+ 试题栏' }}
                </el-button>
              </div>
            </div>

            <!-- ══ 题干区（题号 + 类型 + 分 + 题干图/文）══ -->
            <div class="q-stem-area">
              <div class="q-stem-header">
                <span class="q-num">{{ q.sortNum ?? q.sort ?? '' }}.</span>
                <span class="q-type-tag" :class="`q-type--${getQuestionTypeTag(q.questionType)}`">
                  {{ getQuestionTypeLabel(q.questionType) }}
                </span>
                <span v-if="getQuestionScore(q) != null" class="q-score">
                  {{ getQuestionScore(q) }} 分
                </span>
              </div>
              <div class="q-stem-body">
                <img
                  v-if="q.stemImg"
                  :src="q.stemImg"
                  class="q-stem-img"
                  alt="题干"
                  referrerpolicy="no-referrer"
                  loading="lazy"
                  @error="(e: Event) => ((e.target as HTMLImageElement).style.display='none')"
                />
                <p v-else-if="q.stemText" class="q-stem-text">{{ q.stemText }}</p>
                <p v-else class="q-stem-placeholder">（题目 ID: {{ q.id }}）</p>
              </div>
            </div>

            <!-- ══ 底部 meta 行：来源 + freeTags + (右) 详情 link ══ -->
            <div class="q-meta-bottom">
              <div class="q-meta-bottom-left">
                <span v-if="q.examPaperName" class="source-text">
                  来源: {{ q.examPaperName }}{{ q.examYear ? ` · ${q.examYear}年` : '' }}
                </span>
                <FreeTagList
                  v-if="q.freeTags && q.freeTags.length > 0"
                  :tags="q.freeTags"
                  mode="detail"
                  class="bottom-freetag-list"
                />
              </div>
              <div class="q-meta-bottom-right">
                <el-button
                  size="small"
                  link
                  type="primary"
                  class="detail-link-btn"
                  @click="handleDetail(q)"
                >
                  <el-icon><InfoFilled /></el-icon>
                  详情
                </el-button>
              </div>
            </div>
          </div>
        </section>
        </template>

        <!-- ══ 编辑态：平铺题列表（PRD-A-006 edit 分支，复用查看题卡骨架 .source-question-card）══ -->
        <template v-else>
          <div
            v-for="(row, idx) in editRows"
            :key="row.id"
            class="source-question-card edit-card"
          >
            <!-- 顶部 meta 行：左 难度+知识点（同查看）/ 右 题号+排序+删除 -->
            <div class="q-meta-top">
              <div class="q-meta-top-left">
                <span class="meta-label">难度:</span>
                <el-rate :model-value="row.difficult ?? 0" :max="4" disabled class="meta-rate" />
                <span class="meta-label">知识点:</span>
                <el-tag
                  v-if="row.questionKnowledges && row.questionKnowledges.length > 0"
                  type="primary"
                  size="small"
                  class="primary-knowledge-tag"
                >
                  {{ row.questionKnowledges[0].knowledgeName || row.questionKnowledges[0].knowledgeId }}
                </el-tag>
                <span v-else class="knowledge-empty">暂无</span>
              </div>
              <div class="q-meta-top-right edit-ops">
                <span class="edit-row-index">{{ idx + 1 }}</span>
                <el-button size="small" circle :disabled="idx === 0" @click="moveUp(idx)">
                  <el-icon><Top /></el-icon>
                </el-button>
                <el-button size="small" circle :disabled="idx === editRows.length - 1" @click="moveDown(idx)">
                  <el-icon><Bottom /></el-icon>
                </el-button>
                <el-button size="small" type="danger" plain circle @click="deleteRow(idx)">
                  <el-icon><Delete /></el-icon>
                </el-button>
              </div>
            </div>

            <!-- 题干区（同查看骨架）-->
            <div class="q-stem-area">
              <div class="q-stem-header">
                <span class="q-type-tag" :class="`q-type--${getQuestionTypeTag(row.questionType)}`">
                  {{ getQuestionTypeLabel(row.questionType) }}
                </span>
              </div>
              <div class="q-stem-body">
                <img
                  v-if="row.stemImg"
                  :src="row.stemImg"
                  class="q-stem-img"
                  alt="题干"
                  referrerpolicy="no-referrer"
                  loading="lazy"
                  @error="(e: Event) => ((e.target as HTMLImageElement).style.display='none')"
                />
                <p v-else-if="row.stemText" class="q-stem-text">{{ row.stemText }}</p>
                <p v-else class="q-stem-placeholder">（题目 ID: {{ row.id }}）</p>
              </div>
            </div>

            <!-- 底部 meta 行：左 来源 / 右 分值编辑 -->
            <div class="q-meta-bottom edit-bottom">
              <div class="q-meta-bottom-left">
                <span v-if="row.examPaperName" class="source-text">
                  来源: {{ row.examPaperName }}{{ row.examYear ? ` · ${row.examYear}年` : '' }}
                </span>
              </div>
              <div class="q-meta-bottom-right edit-score">
                <span class="row-score-label">分值</span>
                <el-input-number
                  v-model="row._score"
                  :min="0"
                  :max="100"
                  :step="1"
                  size="small"
                  controls-position="right"
                  style="width: 110px;"
                />
                <span class="row-score-unit">分</span>
              </div>
            </div>
          </div>

          <el-empty
            v-if="editRows.length === 0"
            description="试卷暂无题目，点「增题」从试题栏添加"
          >
            <el-button type="primary" @click="openAddDialog">增题</el-button>
          </el-empty>
        </template>
      </div>
    </div>

    <!-- 导出 PDF：复用 PaperPreview 干净打印版预览（自带答案/解析勾选 + jsPDF 无损导出按钮） -->
    <PaperPreview
      :visible="previewVisible"
      :paper-name="exportPaperName"
      :ids="exportQuestionIds"
      @update:visible="previewVisible = $event"
    />

    <!-- 增题弹窗（编辑态）：从试题栏挑（复用 useQuestionBasket + 共享 QuestionCard，禁重造）-->
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
        <div v-for="q in addableBasketItems" :key="q.id" class="add-item">
          <div class="add-item-card">
            <QuestionCard :question="q" :actions="[]" />
          </div>
          <el-button type="primary" size="small" @click="addQuestionFromBasket(q)">
            <el-icon><Plus /></el-icon>添加
          </el-button>
        </div>
      </el-scrollbar>
      <template #footer>
        <el-button @click="addDialogVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 收藏目录抽屉（与题库一致：未收藏题点收藏 → 选目录）-->
    <FavoriteFolderDrawer
      v-model="favDrawerVisible"
      :question-id="favDrawerQuestionId"
      @success="handleFavDrawerSuccess"
    />

    <!-- 草稿纸（覆盖式涂画）-->
    <SketchPad v-model:visible="sketchVisible" />
  </div>
</template>

<style scoped>
.source-page {
  min-height: 100vh;
  background: #f0f2f5;
  display: flex;
  flex-direction: column;
}

/* ── 顶部导航栏 ── */
.source-topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 24px;
  background: #fff;
  border-bottom: 1px solid #f2f3f5;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
  position: sticky;
  top: 0;
  z-index: 100;
}

.back-btn {
  color: #4e5969;
  font-size: 14px;
  gap: 4px;
}

.back-btn:hover {
  color: #4080ff;
}

.topbar-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.topbar-title {
  font-size: 16px;
  font-weight: 600;
  color: #1d2129;
}

.topbar-export-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

/* ── 内容区 ── */
.source-body {
  padding: 16px 24px;
  max-width: 1000px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}

.source-loading,
.source-empty {
  display: flex;
  justify-content: center;
  padding: 40px 0;
}

/* ── 卷头 ── */
.paper-header {
  background: #fff;
  border-radius: 10px;
  padding: 22px 24px;
  margin-bottom: 14px;
  border: 1px solid #f2f3f5;
  text-align: center;
}

.paper-title {
  font-size: 22px;
  font-weight: 700;
  color: #1d2129;
  margin: 0 0 12px;
  line-height: 1.4;
}

.paper-meta {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 13px;
  color: #4e5969;
}

.meta-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: #f2f3f5;
  border-radius: 14px;
  color: #4e5969;
}

.meta-chip strong {
  color: #1d2129;
  font-weight: 600;
}

.meta-chip--year {
  background: #e8f0ff;
  color: #3564d0;
  font-weight: 500;
}

/* ── 大题分组 ── */
.paper-section {
  margin-bottom: 18px;
}

.section-title {
  font-size: 16px;
  font-weight: 700;
  color: #1d2129;
  margin: 0 0 10px;
  padding: 10px 14px;
  background: #fff;
  border-left: 4px solid #4080ff;
  border-radius: 4px;
  border: 1px solid #f2f3f5;
  border-left-width: 4px;
}

.section-sub {
  font-size: 13px;
  font-weight: 400;
  color: #86909c;
  margin-left: 4px;
}

/* ── 题目卡片 ── */
.source-question-card {
  background: #fff;
  border-radius: 10px;
  border: 1px solid #f2f3f5;
  padding: 16px 20px;
  margin-bottom: 10px;
  transition: all 0.2s;
}

.source-question-card:hover {
  box-shadow: 0 4px 16px rgba(64, 128, 255, 0.1);
  border-color: #d0e2ff;
}

.source-question-card.in-basket {
  border-left: 3px solid #34c38f;
  background: #f8fffe;
}

/* ── 顶部 meta 行（misikt 风格：左 难度+知识点 / 右 草稿+收藏+试题栏） ── */
.q-meta-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  gap: 8px;
  flex-wrap: wrap;
  padding-bottom: 10px;
  border-bottom: 1px solid #f7f8fa;
}

.q-meta-top-left {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.q-meta-top-right {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.meta-label {
  font-size: 12px;
  color: #86909c;
  font-weight: 500;
}

.meta-rate {
  height: 18px;
}

:deep(.meta-rate .el-rate__item) {
  font-size: 15px;
}

.primary-knowledge-tag {
  font-size: 12px;
}

.knowledge-empty {
  font-size: 12px;
  color: #c9cdd4;
}

.action-icon-btn {
  font-size: 13px;
  color: #4e5969;
  padding: 0 4px;
  gap: 2px;
}

.action-icon-btn:hover {
  color: #4080ff;
}

.action-icon-btn.is-fav {
  color: #f7ba1e;
}

.action-basket-btn {
  border-radius: 5px;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  transition: all 0.2s ease;
}

.action-basket-btn--added {
  color: #86909c !important;
  border-color: #c9cdd4 !important;
  background: #f7f8fa !important;
}

.action-basket-btn--added:hover {
  color: #f56c6c !important;
  border-color: #f56c6c !important;
  background: #fff5f5 !important;
}

/* ── 题干区（题号融入 stem-header）── */
.q-stem-area {
  min-height: 80px;
}

.q-stem-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.q-num {
  font-size: 15px;
  font-weight: 700;
  color: #1d2129;
}

.q-type-tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
}

.q-type--primary {
  background: #e8f0ff;
  color: #3564d0;
}

.q-type--success {
  background: #e8fff0;
  color: #0d7a4a;
}

.q-type--warning {
  background: #fff7e6;
  color: #b45309;
}

.q-type--info {
  background: #f0f0f0;
  color: #6b7280;
}

.q-type--danger {
  background: #fff0f0;
  color: #d32f2f;
}

.q-score {
  font-size: 12px;
  color: #b45309;
  background: #fff7e6;
  padding: 2px 7px;
  border-radius: 4px;
  font-weight: 600;
}

.q-stem-img {
  max-width: 100%;
  height: auto;
  display: block;
}

.q-stem-text {
  font-size: 14px;
  line-height: 1.7;
  color: #1d2129;
  margin: 0;
  white-space: pre-wrap;
}

.q-stem-placeholder {
  font-size: 13px;
  color: #c9cdd4;
  margin: 0;
}

/* ── 底部 meta 行（misikt 风格：左 来源+freeTags / 右 详情 link） ── */
.q-meta-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid #f7f8fa;
  flex-wrap: wrap;
}

.q-meta-bottom-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  flex: 1;
  min-width: 0;
}

.q-meta-bottom-right {
  flex-shrink: 0;
}

.source-text {
  font-size: 12px;
  color: #86909c;
}

.bottom-freetag-list {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
}

.detail-link-btn {
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

/* ══ PRD-A-006 编辑态：顶栏 + 题卡操作（复用查看骨架，仅叠操作）══ */
/* 操作区统一靠右（查看 + 编辑 双态）*/
.topbar-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 编辑态卷名输入（占中段）*/
.topbar-edit-name {
  flex: 1;
  max-width: 480px;
}

.edit-name-input :deep(.el-input__inner) {
  font-size: 16px;
  font-weight: 600;
}

/* 编辑态题数·分 统计 pill */
.edit-stat-pill {
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

/* 编辑态题卡右上操作区（题号 + 排序 + 删除）*/
.edit-ops {
  gap: 6px;
}

.edit-row-index {
  width: 24px;
  height: 24px;
  background: linear-gradient(135deg, #4080ff, #3370e8);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: 4px;
}

/* 编辑态题卡底部分值 */
.edit-score {
  display: flex;
  align-items: center;
  gap: 8px;
}

.row-score-label,
.row-score-unit {
  font-size: 13px;
  color: #4e5969;
}

/* 增题弹窗候选项 */
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
