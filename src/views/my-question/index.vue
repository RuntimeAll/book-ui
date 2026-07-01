<script setup lang="ts">
// PRD-C-009「我的题库」：克隆 views/question/index.vue，功能/样式一致，
// 唯一差异 = pageParams 恒带 mine:true（owner 由后端 LoginHelper 定）+ 进入默认无 subject 过滤
// （老师自己的题跨多章节，默认选首节点会几乎空 → 改为先全量展示自己的题，点树仍可过滤）。
// 血缘展示（母题关系等）暂不做（QuestionCard 列表本就不展示血缘，无需额外隐藏）。
import { ref, reactive, computed } from 'vue'
import { useDictStore, DICT_QUESTION_TYPE, DICT_QUESTION_DIFFICULTY } from '@/store/dict'
import { ElMessage } from 'element-plus'
import { Search, Document, Plus, ArrowDown, Crop, Upload } from '@element-plus/icons-vue'
import {
  questionPage,
  removeFavorite,
  type QuestionItem,
  type QuestionPageParams,
  type QuestionPageResult,
} from '@/api/question/index'
import { useRouter } from 'vue-router'
import { useQuestionBasket } from '@/composables/useQuestionBasket'
import { useAbortableRequest } from '@/composables/useAbortableRequest'
import FavoriteFolderDrawer from '@/components/FavoriteFolderDrawer/index.vue'
import SearchWrap from '@/components/SearchWrap/index.vue'
import QuestionCard from '@/components/business/QuestionCard/index.vue'
import SketchPad from '@/components/business/SketchPad/index.vue'
import BatchUploadDialog from '@/views/ingest/components/BatchUploadDialog.vue'
import SubjectDirectory from '@/components/business/SubjectDirectory/index.vue'

// ── 路由 ────────────────────────────────────────────────────
const router = useRouter()

// ── 试题栏（全局 singleton composable，FAB+dialog 由 AppLayout 挂的 <QuestionBasket /> 渲染） ──
const basket = useQuestionBasket()

// ── 题库目录（SubjectDirectory 收放筛选组件，mine + 默认全部）──
// mine=true：目录树过滤 mine_visible；autoSelect=false：默认「全部我的题」不按教材过滤
// （老师的题跨章节，默认落某教材会几乎空）。用户点教材/章节 emit subjectId 才过滤；点「全部」回 null。
function onDirSelect(subjectId: string | null) {
  pageParams.subjectId = subjectId ?? undefined
  pageParams.pageIndex = 1
  fetchQuestions()
}

// PRD-A-002 — 进入框选录题全屏页（路A）
function goIngestFrame() {
  router.push('/ingest/frame')
}

// PRD-A-002 路B — 批量上传弹层
const batchUploadVisible = ref(false)

// 录题下拉：framedraw=框选录题(路A) / batch=批量上传(路B)
function handleIngestCommand(command: string) {
  if (command === 'frame') {
    goIngestFrame()
  } else if (command === 'batch') {
    batchUploadVisible.value = true
  }
}

// ── 筛选条 ──────────────────────────────────────────────────
// PRD-C-204：题型读字典 SSOT（biz_question_type），不再硬编码
const dict = useDictStore()
dict.load(DICT_QUESTION_TYPE)
dict.load(DICT_QUESTION_DIFFICULTY)
const QUESTION_TYPES = computed(() => [
  { label: '全部题型', value: '' as number | '' },
  ...dict.list(DICT_QUESTION_TYPE).map((d) => ({ label: d.dictLabel, value: Number(d.dictValue) })),
])

// 难度过滤走字典 SSOT（biz_question_difficulty，基础/中等/较难/压轴），不再硬编码「N星」
const DIFFICULTY_OPTIONS = computed(() => [
  { label: '全部难度', value: '' as number | '' },
  ...dict.list(DICT_QUESTION_DIFFICULTY).map((d) => ({ label: d.dictLabel, value: Number(d.dictValue) })),
])

const filter = reactive({
  questionType: '' as number | '',
  difficulty: '' as number | '',
  keyWord: '',
})

const searchLoading = ref(false)
const resetLoading = ref(false)

function onSearch() {
  pageParams.questionType = filter.questionType !== '' ? Number(filter.questionType) : undefined
  pageParams.difficult = filter.difficulty !== '' ? Number(filter.difficulty) : undefined
  pageParams.keyWord = filter.keyWord || undefined
  pageParams.pageIndex = 1
  fetchQuestions()
}

function onReset() {
  filter.questionType = ''
  filter.difficulty = ''
  filter.keyWord = ''
  pageParams.questionType = undefined
  pageParams.difficult = undefined
  pageParams.keyWord = undefined
  pageParams.subjectId = undefined
  pageParams.pageIndex = 1
  // subjectId 置空即回到「全部自己的题」（目录面板状态由 SubjectDirectory 自管，重置只清查询过滤）
  fetchQuestions()
}

// ── 题目列表 ─────────────────────────────────────────────────
const questions = ref<QuestionItem[]>([])
const listLoading = ref(false)
const total = ref(0)

// 🔴 mine:true 恒带 —— owner 由后端 LoginHelper 定，前端只传开关。
const pageParams = reactive<QuestionPageParams>({
  pageIndex: 1,
  pageSize: 10,
  notTaskQuestion: 0,
  notUsedQuestion: 0,
  mine: true,
})

const { run: runAbortable } = useAbortableRequest<QuestionPageResult>()

const emptyDescription = computed(() => {
  if (pageParams.subjectId) return '该章节下你还没有题目'
  return '你还没有自己的题目，去「举一反三」生成一组试试'
})

async function fetchQuestions() {
  listLoading.value = true
  try {
    const result = await runAbortable((signal) => questionPage(pageParams, { signal }))
    if (result === null) {
      return
    }
    const res = result as unknown as Record<string, unknown>
    if (res && Array.isArray(res['list'])) {
      questions.value = res['list'] as QuestionItem[]
      total.value = (res['total'] as number) ?? 0
    } else if (Array.isArray(result)) {
      questions.value = result as unknown as QuestionItem[]
      total.value = (result as unknown as unknown[]).length
    } else {
      questions.value = []
      total.value = 0
    }
  } catch (e) {
    console.warn('[my-question] page failed', e)
    questions.value = []
  } finally {
    listLoading.value = false
  }
}

function handlePageChange(page: number) {
  pageParams.pageIndex = page
  fetchQuestions()
}

// ── 收藏状态 ─────────────────────────────────────────────────
function setQuestionFavorite(qid: string, fav: boolean) {
  const q = questions.value.find((it) => it.id === qid)
  if (q) q.isFavorite = fav
}

// ── 试题栏 toggle ────────────────────────────────────────────
async function handleBasketToggle(question: QuestionItem) {
  if (basket.isLoading(question.id)) return
  if (basket.basketIds.value.has(question.id)) {
    await basket.remove(question.id)
  } else {
    await basket.add(question)
  }
}

// ── 草稿纸 ──────────────────────────────────────────────────
const sketchVisible = ref(false)

function handleDraft(_q: QuestionItem) {
  sketchVisible.value = true
}

const favoriteLoading = reactive<Set<string>>(new Set())

// ── 收藏抽屉 ──────────────────────────────────────────────────
const favDrawerVisible = ref(false)
const favDrawerQuestionId = ref<string>('')

function handleFavorite(q: QuestionItem) {
  if (favoriteLoading.has(q.id)) return
  if (q.isFavorite) {
    handleRemoveFavorite(q)
  } else {
    favDrawerQuestionId.value = q.id
    favDrawerVisible.value = true
  }
}

function handleRemoveFavorite(q: QuestionItem) {
  if (favoriteLoading.has(q.id)) return
  setQuestionFavorite(q.id, false)
  ElMessage.success('已取消收藏')
  removeFavorite(q.id).catch((e) => {
    console.warn('[favorite] removeFavorite API failed (local state already updated):', e)
  })
}

function handleFavDrawerSuccess(_folderId: string | undefined) {
  if (favDrawerQuestionId.value) {
    setQuestionFavorite(favDrawerQuestionId.value, true)
  }
}

function handleEdit(q: QuestionItem) {
  router.push(`/question/editor/${q.id}`)
}

function handleDetail(q: QuestionItem) {
  // 复用题库详情页（血缘展示在详情页，列表页不展示）
  try {
    const cacheKey = 'book-ui:question-cache-by-id'
    const existing: Record<string, QuestionItem> = JSON.parse(localStorage.getItem(cacheKey) || '{}')
    existing[String(q.id)] = q
    localStorage.setItem(cacheKey, JSON.stringify(existing))
  } catch (e) {
    console.warn('[detail] cache write failed', e)
  }
  router.push(`/question/detail/${q.id}`)
}

// ── 初始化 ───────────────────────────────────────────────────
// 首屏由 <SubjectDirectory> 挂载后 emit('select') 驱动（恢复缓存或按页面默认 → onDirSelect → fetchQuestions），
// 与题库页一致，避免重复请求。
</script>

<template>
  <div class="question-page">
    <el-container style="height: 100%; min-height: calc(100vh - 60px);">

      <!-- ══ 左侧题库目录（可选过滤器，默认「全部我的题」）══ -->
      <el-aside width="280px" class="tree-aside">
        <SubjectDirectory :mine="true" :auto-select="false" @select="onDirSelect" />
      </el-aside>

      <!-- ══ 右侧内容区 ══ -->
      <el-main class="content-main">

        <SearchWrap
          :search-loading="searchLoading"
          :reset-loading="resetLoading"
          @search="onSearch"
          @reset="onReset"
        >
          <div class="filter-item">
            <span class="filter-label">题型</span>
            <el-select
              v-model="filter.questionType"
              placeholder="全部题型"
              clearable
              style="width: 120px;"
            >
              <el-option
                v-for="opt in QUESTION_TYPES"
                :key="String(opt.value)"
                :label="opt.label"
                :value="opt.value"
              />
            </el-select>
          </div>

          <div class="filter-item">
            <span class="filter-label">难度</span>
            <el-select
              v-model="filter.difficulty"
              placeholder="全部难度"
              clearable
              style="width: 120px;"
            >
              <el-option
                v-for="opt in DIFFICULTY_OPTIONS"
                :key="String(opt.value)"
                :label="opt.label"
                :value="opt.value"
              />
            </el-select>
          </div>

          <div class="filter-item">
            <span class="filter-label">关键词</span>
            <el-input
              v-model="filter.keyWord"
              placeholder="输入关键词"
              clearable
              style="width: 200px;"
              @keyup.enter="onSearch"
            >
              <template #prefix>
                <el-icon><Search /></el-icon>
              </template>
            </el-input>
          </div>
        </SearchWrap>

        <div class="list-header">
          <div class="list-header-left">
            <span class="list-title">我的题目</span>
            <el-tag v-if="total > 0" type="info" size="small" round style="margin-left: 8px;">
              共 {{ total }} 题
            </el-tag>
          </div>
          <div class="list-header-right">
            <el-dropdown trigger="click" @command="handleIngestCommand">
              <el-button type="primary">
                <el-icon style="margin-right: 4px;"><Plus /></el-icon>
                录题
                <el-icon style="margin-left: 4px;"><ArrowDown /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="frame">
                    <el-icon style="margin-right: 6px;"><Crop /></el-icon>
                    框选录题
                  </el-dropdown-item>
                  <el-dropdown-item command="batch">
                    <el-icon style="margin-right: 6px;"><Upload /></el-icon>
                    批量上传
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>

        <div v-loading="listLoading" class="question-list">
          <el-empty
            v-if="!listLoading && questions.length === 0"
            :description="emptyDescription"
            class="empty-state"
          >
            <template #image>
              <el-icon style="font-size: 56px; color: #c9cdd4;"><Document /></el-icon>
            </template>
          </el-empty>

          <QuestionCard
            v-for="q in questions"
            :key="q.id"
            :question="q"
            :in-basket="basket.basketIds.value.has(q.id)"
            :basket-loading="basket.isLoading(q.id)"
            :is-favorite="!!q.isFavorite"
            :favorite-loading="favoriteLoading.has(q.id)"
            :actions="['edit', 'draft', 'favorite', 'basket', 'detail']"
            @draft="handleDraft"
            @favorite="handleFavorite"
            @basket-toggle="handleBasketToggle"
            @detail="handleDetail"
            @edit="handleEdit"
          />
        </div>

        <div class="pagination-wrap">
          <el-pagination
            v-model:current-page="pageParams.pageIndex"
            :page-size="pageParams.pageSize"
            :total="total"
            layout="total, prev, pager, next, jumper"
            background
            @current-change="handlePageChange"
          />
        </div>
      </el-main>
    </el-container>

    <FavoriteFolderDrawer
      v-model="favDrawerVisible"
      :question-id="favDrawerQuestionId"
      @success="handleFavDrawerSuccess"
    />

    <SketchPad v-model:visible="sketchVisible" />

    <!-- PRD-A-002 路B — 批量上传录题弹层 -->
    <BatchUploadDialog v-model:visible="batchUploadVisible" />
  </div>
</template>

<style scoped>
.question-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
}

.tree-aside {
  background: transparent;
  overflow-y: auto;
  padding: 12px 8px 12px 12px;
  position: sticky;
  top: 0;
  height: calc(100vh - 60px);
  flex-shrink: 0;
}

.tree-content-wrap {
  height: 100%;
}

.tree-content-wrap :deep(.el-card__body) {
  padding: 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: calc(100% - 56px);
  overflow-y: auto;
}

.textbook-select {
  width: 100%;
}

.tree-filter-input {
  width: 100%;
}

.tree-loading {
  padding: 8px 0;
}

.subject-tree {
  flex: 1;
  overflow-y: auto;
}

:deep(.el-tree-node__content) {
  height: 36px;
  border-radius: 6px;
  transition: all 0.15s;
  margin: 1px 2px;
  padding-right: 8px;
}

:deep(.el-tree-node__content:hover) {
  background: rgba(30, 138, 138, 0.06);
}

:deep(.el-tree-node.is-current > .el-tree-node__content) {
  background: rgba(30, 138, 138, 0.1);
  color: #1E8A8A;
  font-weight: 600;
}

:deep(.el-tree-node__expand-icon) {
  transition: transform 0.2s ease;
}

.content-main {
  padding: 12px 20px 16px 8px;
  overflow-y: auto;
  background: #f0f2f5;
}

.filter-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.filter-label {
  font-size: 13px;
  color: #4e5969;
  white-space: nowrap;
  font-weight: 500;
}

.list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  padding: 0 2px;
}

.list-header-left {
  display: flex;
  align-items: center;
}

.list-title {
  font-size: 14px;
  font-weight: 600;
  color: #1d2129;
}

.question-list {
  min-height: 200px;
}

.empty-state {
  margin: 40px 0;
}

.pagination-wrap {
  margin-top: 20px;
  display: flex;
  justify-content: center;
  padding-bottom: 16px;
}
</style>
