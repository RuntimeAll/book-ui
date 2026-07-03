<script setup lang="ts">
/**
 * ReplaceQuestionDialog — 换一题检索弹窗（PRD-A-007 Wave4 改动②）
 *
 * props:
 *   visible      — v-model 控制显隐
 *   question     — 当前被换的题（用于预填筛选条件：subjectId/questionType/difficult）
 *   excludeIds   — 本卷已有题 id，对应行禁选并显示"已在卷中"
 *
 * emits:
 *   update:visible  — 关闭弹窗
 *   select(q)       — 老师点"选用"后触发，携带选中的 QuestionItem
 */
import { ref, watch, computed } from 'vue'
import { questionPage } from '@/api/question/index'
import type { QuestionItem } from '@/api/question/index'
import QuestionContent from '@/components/business/QuestionContent/index.vue'
import { useDictStore, DICT_QUESTION_TYPE, type ElTagColorType } from '@/store/dict'

// ── props / emits ────────────────────────────────────────────
// PRD-A-013 T2 — 雪花 ID 全 string
interface CurrentQuestion {
  id: string
  subjectId?: string
  questionType?: number
  difficult?: number | null
  questionKnowledges?: { knowledgeName?: string; knowledgeId?: string | number }[]
}

const props = defineProps<{
  visible: boolean
  question: CurrentQuestion
  excludeIds: string[]
}>()

const emit = defineEmits<{
  'update:visible': [v: boolean]
  select: [q: QuestionItem]
}>()

// ── 筛选条件 ─────────────────────────────────────────────────
const filterType = ref<number | ''>('')     // '' = 全部
const filterDiff = ref<number | ''>('')     // '' = 全部
const filterKeyword = ref('')
// 考点（knowledgeId）：换一题默认锁定被换题的考点，检索同考点候选。
// BE questionPage 的 subjectId 走 biz_question_knowledge JOIN（= 按知识点匹配），
// 故把被换题考点的 knowledgeId 当 subjectId 喂进去即可（题库章节过滤同此机制）。
const filterKnowledgeId = ref('')           // '' = 不限考点
const filterKnowledgeName = ref('')         // 展示用

// ── 分页 / 列表 ───────────────────────────────────────────────
const loading = ref(false)
const list = ref<QuestionItem[]>([])
const total = ref(0)
const currentPage = ref(1)
const PAGE_SIZE = 6

async function doSearch() {
  loading.value = true
  try {
    // ⚠️ 不 seed 试卷题自带的 subjectId（那是分类树前缀 id 如 3001002 公共卷库分类，过滤必返 0）。
    // 但「换一题」要找同考点的题 → 用被换题的考点 knowledgeId 当 subjectId（BE subjectId 走
    // biz_question_knowledge JOIN，按知识点匹配，同题库章节过滤机制）。考点 + 题型 + 难度三维检索。
    const params = {
      pageIndex: currentPage.value,
      pageSize: PAGE_SIZE,
      notTaskQuestion: 0,
      notUsedQuestion: 0,
      ...(filterKnowledgeId.value ? { subjectId: filterKnowledgeId.value } : {}),
      ...(filterType.value !== '' ? { questionType: Number(filterType.value) } : {}),
      ...(filterDiff.value !== '' ? { difficult: Number(filterDiff.value) } : {}),
      ...(filterKeyword.value.trim() ? { keyWord: filterKeyword.value.trim() } : {}),
    }
    const res = await questionPage(params)
    if (res && res.list) {
      list.value = res.list
      total.value = res.total ?? 0
    } else {
      list.value = []
      total.value = 0
    }
  } catch (e) {
    console.warn('[ReplaceQuestionDialog] questionPage failed', e)
    list.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

// visible 打开时用 props.question 预填并发起首次检索。
// 🔴 immediate 必须开：workbench 用 v-if="replaceTargetRow" 控制本组件挂载，首次点「换一题」时
// 组件刚挂载、props.visible 初值已是 true（同 tick 设置），非 immediate watch 监听不到「变化」→
// doSearch 永不触发 → 首次打开恒「暂无匹配题目」。immediate 让挂载即跑一次（回调内 if(v) 守卫，
// 常驻 visible=false 态不会误搜）。
// ⚠️ 本块必须放在 doSearch 及其依赖的 ref（currentPage/loading/list）之后 —— immediate 会在 setup
// 期间同步执行 doSearch，提前定义会撞 const TDZ（Cannot access 'currentPage' before initialization）。
watch(
  () => props.visible,
  (v) => {
    if (v) {
      filterType.value = props.question.questionType ?? ''
      filterDiff.value = props.question.difficult ?? ''
      filterKeyword.value = ''
      // 默认锁定被换题的第一个考点（同考点换题）；老师可点标签的 × 放宽到不限考点
      const k0 = props.question.questionKnowledges?.[0]
      filterKnowledgeId.value = k0?.knowledgeId != null ? String(k0.knowledgeId) : ''
      filterKnowledgeName.value = k0?.knowledgeName || ''
      currentPage.value = 1
      doSearch()
    }
  },
  { immediate: true },
)

function handleSearch() {
  currentPage.value = 1
  doSearch()
}

// 放宽考点限制（× 标签）→ 不限考点重搜
function clearKnowledge() {
  filterKnowledgeId.value = ''
  filterKnowledgeName.value = ''
  currentPage.value = 1
  doSearch()
}

function handlePageChange(page: number) {
  currentPage.value = page
  doSearch()
}

// ── 选用 ─────────────────────────────────────────────────────
function handleSelect(q: QuestionItem) {
  emit('select', q)
  emit('update:visible', false)
}

function handleClose() {
  emit('update:visible', false)
}

// ── 辅助：题型 / 难度标签 ─────────────────────────────────────
// 题型 label 走字典 SSOT（biz_question_type，超管可维护，含全 8 类）。
const dict = useDictStore()
dict.load(DICT_QUESTION_TYPE)
function typeLabel(t: number): string {
  return dict.label(DICT_QUESTION_TYPE, t) || `题型${t}`
}

function typeTagColor(t: number): ElTagColorType {
  // 徽标颜色走字典 list_class（biz_question_type，超管可维护）
  return dict.tagType(DICT_QUESTION_TYPE, t, 'info')
}

// 是否已在卷中
const excludeSet = computed(() => new Set(props.excludeIds))
// PRD-A-013 T2 — id 雪花 string
function isInPaper(id: string) {
  return excludeSet.value.has(id)
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    title="换一题 — 选择替换题目"
    width="700px"
    top="8vh"
    :close-on-click-modal="false"
    destroy-on-close
    @update:model-value="handleClose"
  >
    <!-- 筛选行 -->
    <div class="rqd-filter-row">
      <!-- 考点锁定标签：默认锁被换题考点，× 放宽到不限考点 -->
      <el-tag
        v-if="filterKnowledgeName"
        type="primary"
        closable
        class="rqd-knowledge-tag"
        @close="clearKnowledge"
      >
        考点：{{ filterKnowledgeName }}
      </el-tag>
      <el-select
        v-model="filterType"
        placeholder="全部题型"
        size="small"
        style="width: 110px;"
        clearable
      >
        <el-option label="选择题" :value="1" />
        <el-option label="填空题" :value="4" />
        <el-option label="简答题" :value="5" />
      </el-select>

      <el-select
        v-model="filterDiff"
        placeholder="全部难度"
        size="small"
        style="width: 110px;"
        clearable
      >
        <el-option label="★" :value="1" />
        <el-option label="★★" :value="2" />
        <el-option label="★★★" :value="3" />
        <el-option label="★★★★" :value="4" />
      </el-select>

      <el-input
        v-model="filterKeyword"
        placeholder="关键词搜索"
        size="small"
        style="flex: 1; min-width: 120px;"
        clearable
        @keyup.enter="handleSearch"
      />

      <el-button type="primary" size="small" @click="handleSearch">搜索</el-button>
    </div>

    <!-- 列表区 -->
    <div v-loading="loading" class="rqd-list">
      <div v-if="!loading && list.length === 0" class="rqd-empty">
        暂无匹配题目
      </div>

      <div
        v-for="q in list"
        :key="q.id"
        class="rqd-item"
        :class="{ 'rqd-item--inpaper': isInPaper(q.id) }"
      >
        <!-- 左侧：meta + 题干 -->
        <div class="rqd-item-body">
          <div class="rqd-item-meta">
            <el-tag :type="typeTagColor(q.questionType)" size="small">
              {{ typeLabel(q.questionType) }}
            </el-tag>
            <el-rate
              :model-value="q.difficult ?? 0"
              :max="4"
              disabled
              class="rqd-rate"
            />
            <span
              v-if="q.questionKnowledges && q.questionKnowledges.length > 0"
              class="rqd-knowledge"
            >
              {{ q.questionKnowledges[0].knowledgeName || q.questionKnowledges[0].knowledgeId }}
            </span>
          </div>

          <!-- 题干（富文本/图片/占位统一走 QuestionContent） -->
          <div class="rqd-stem">
            <QuestionContent
              :text="q.stemText"
              :img-url="q.stemImg"
              alt="题干"
              img-max-height="100px"
            />
          </div>
        </div>

        <!-- 右侧：操作按钮 -->
        <div class="rqd-item-action">
          <el-button
            v-if="isInPaper(q.id)"
            size="small"
            disabled
          >
            已在卷中
          </el-button>
          <el-button
            v-else
            size="small"
            type="primary"
            @click="handleSelect(q)"
          >
            选用
          </el-button>
        </div>
      </div>
    </div>

    <!-- 分页 -->
    <div v-if="total > 0" class="rqd-pagination">
      <el-pagination
        :current-page="currentPage"
        :page-size="PAGE_SIZE"
        :total="total"
        layout="prev, pager, next"
        small
        @current-change="handlePageChange"
      />
    </div>
  </el-dialog>
</template>

<style scoped>
/* 筛选行 */
.rqd-filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}

/* 列表区 */
.rqd-list {
  min-height: 200px;
  max-height: 420px;
  overflow-y: auto;
}

.rqd-empty {
  text-align: center;
  color: #c9cdd4;
  padding: 40px 0;
  font-size: 13px;
}

/* 每条题目 */
.rqd-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid #f2f3f5;
  border-radius: 8px;
  margin-bottom: 8px;
  background: #fff;
  transition: border-color 0.15s;
}

.rqd-item:hover {
  border-color: #d0e2ff;
}

.rqd-item--inpaper {
  background: #fafafa;
  opacity: 0.75;
}

.rqd-item-body {
  flex: 1;
  min-width: 0;
}

.rqd-item-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.rqd-rate {
  height: 16px;
}

:deep(.rqd-rate .el-rate__item) {
  font-size: 14px;
}

.rqd-knowledge {
  font-size: 12px;
  color: #1E8A8A;
  background: #f0f5ff;
  border-radius: 4px;
  padding: 1px 6px;
}

/* 题干 */
.rqd-stem {
  width: 100%;
}

.rqd-stem-img {
  max-width: 100%;
  max-height: 100px;
  height: auto;
  display: block;
  object-fit: contain;
}

.rqd-stem-text {
  font-size: 13px;
  color: #1d2129;
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.rqd-stem-placeholder {
  font-size: 13px;
  color: #c9cdd4;
}

/* 操作按钮 */
.rqd-item-action {
  flex-shrink: 0;
  padding-top: 2px;
}

/* 分页 */
.rqd-pagination {
  display: flex;
  justify-content: center;
  padding-top: 12px;
}
</style>
