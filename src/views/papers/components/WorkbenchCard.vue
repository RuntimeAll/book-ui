<script setup lang="ts">
/**
 * PRD-A-010 T3 — 工作台题卡（纯结构性抽取，行为/数据流不变）
 *
 * 抽离自 workbench.vue 左主栏题卡（原「按题型」「按知识点」两个 template 内
 * 完全重复的题卡块，抽出后两处共用、消除重复）。
 *
 * 🔴 纯结构搬运：模板输出、样式、交互完全照搬，仅把对父级 handler 的直接调用
 * 改为 emit 事件（父级 @move-up / @move-down / @delete / @toggle-explain /
 * @replace / @detail 接住原函数，行为零变化）。
 *
 * 根节点保留 `:id="'wb-q-' + globalIndex"` + class `source-question-card workbench-card`：
 * 父组件 scrollToQuestion 仍按 id 定位并加 `.wb-card-flash`（该 class 留在父组件
 * scoped 样式中，子组件根节点带父 data-v 可命中，行为不变）。
 *
 * getQuestionTypeLabel / getQuestionTypeTag 是无副作用纯函数，随题卡一并迁入。
 */
import { Top, Bottom, Delete, InfoFilled, Refresh } from '@element-plus/icons-vue'
import QuestionContent from '@/components/business/QuestionContent/index.vue'
import { useDictStore, DICT_QUESTION_TYPE } from '@/store/dict'
import type { PaperSourceQuestion } from '@/api/question/index'

// EditRow 结构与 workbench.vue 一致（这里只声明用到的本地视图字段）
// PRD-A-013 T2 — _sectionId 雪花 string（与 workbench.vue 对齐）
interface EditRow extends PaperSourceQuestion {
  _sectionId: string
  _score: number
  _showExplain: boolean
  _replacing: boolean
}

defineProps<{
  row: EditRow
  globalIndex: number
  editRowIndex: number
  /** editRows 总长（上移/下移 disabled 边界判断，与父级 editRows.length 一致）*/
  total: number
}>()

const emit = defineEmits<{
  (e: 'toggle-explain', row: EditRow): void
  (e: 'move-up', idx: number): void
  (e: 'move-down', idx: number): void
  (e: 'delete', idx: number): void
  (e: 'replace', row: EditRow, idx: number): void
  (e: 'detail', row: EditRow): void
}>()

// ── 题型 ── label 走字典 SSOT（biz_question_type，超管可维护，含全 8 类）。
const dict = useDictStore()
dict.load(DICT_QUESTION_TYPE)
function getQuestionTypeLabel(type: number): string {
  return dict.label(DICT_QUESTION_TYPE, type) || `题型${type}`
}

function getQuestionTypeTag(type: number): string {
  // 徽标颜色走字典 list_class（biz_question_type，超管可维护）
  return dict.tagType(DICT_QUESTION_TYPE, type, 'info')
}
</script>

<template>
  <div
    :id="'wb-q-' + globalIndex"
    class="source-question-card workbench-card"
  >
    <!-- 顶部 meta：左(题型标签/难度/考点/来源) / 右(连续序号圆圈) -->
    <div class="q-meta-top">
      <div class="q-meta-top-left">
        <span
          class="q-type-tag"
          :class="`q-type--${getQuestionTypeTag(row.questionType)}`"
        >
          {{ getQuestionTypeLabel(row.questionType) }}
        </span>
        <span class="meta-label">难度:</span>
        <el-rate
          :model-value="row.difficult ?? 0"
          :max="4"
          disabled
          class="meta-rate"
        />
        <template v-if="row.questionKnowledges && row.questionKnowledges.length > 0">
          <span class="meta-label">考点:</span>
          <el-tag type="primary" size="small" class="primary-knowledge-tag">
            {{ row.questionKnowledges[0].knowledgeName || row.questionKnowledges[0].knowledgeId }}
          </el-tag>
        </template>
        <span v-if="row.examPaperName" class="source-text">
          来源: {{ row.examPaperName }}{{ row.examYear ? ` · ${row.examYear}年` : '' }}
        </span>
      </div>
      <!-- 全卷连续序号 -->
      <div class="q-global-num">{{ globalIndex }}</div>
    </div>

    <!-- 题干区（富文本/图片/占位统一走 QuestionContent） -->
    <div class="q-stem-area">
      <QuestionContent
        :text="row.stemText"
        :img-url="row.stemImg"
        alt="题干"
      />
    </div>

    <!-- 解析区（toggle 显示，富文本/图片统一走 QuestionContent） -->
    <div v-if="row._showExplain" class="q-explain-area">
      <div class="explain-label">解析：</div>
      <QuestionContent
        :text="(row as { explain?: string | null }).explain"
        :img-url="row.explainImg"
        alt="解析"
      />
    </div>

    <!-- 底部工具栏（misikt 风格：分值 | 解析 | 上移 | 下移 | 删除 | 换一题 | 详情）-->
    <div class="q-toolbar">
      <!-- 分值 -->
      <div class="toolbar-score">
        <span class="toolbar-label">分值</span>
        <el-input-number
          v-model="row._score"
          :min="0"
          :max="100"
          :step="1"
          size="small"
          controls-position="right"
          style="width: 100px;"
        />
      </div>
      <div class="toolbar-divider" />
      <!-- 解析 toggle -->
      <el-button
        size="small"
        link
        :type="row._showExplain ? 'primary' : 'default'"
        class="toolbar-btn"
        @click="emit('toggle-explain', row)"
      >
        解析
      </el-button>
      <div class="toolbar-divider" />
      <!-- 上移 -->
      <el-button
        size="small"
        link
        class="toolbar-btn"
        :disabled="editRowIndex === 0"
        @click="emit('move-up', editRowIndex)"
      >
        <el-icon><Top /></el-icon>
        上移
      </el-button>
      <!-- 下移 -->
      <el-button
        size="small"
        link
        class="toolbar-btn"
        :disabled="editRowIndex === total - 1"
        @click="emit('move-down', editRowIndex)"
      >
        <el-icon><Bottom /></el-icon>
        下移
      </el-button>
      <!-- 删除 -->
      <el-button
        size="small"
        link
        type="danger"
        class="toolbar-btn"
        @click="emit('delete', editRowIndex)"
      >
        <el-icon><Delete /></el-icon>
        删除
      </el-button>
      <div class="toolbar-divider" />
      <!-- 换一题 -->
      <el-button
        size="small"
        link
        class="toolbar-btn"
        @click="emit('replace', row, editRowIndex)"
      >
        <el-icon><Refresh /></el-icon>
        换一题
      </el-button>
      <!-- 详情 -->
      <el-button
        size="small"
        link
        type="primary"
        class="toolbar-btn"
        @click="emit('detail', row)"
      >
        <el-icon><InfoFilled /></el-icon>
        详情
      </el-button>
    </div>
  </div>
</template>

<style scoped>
/* ── 题目卡片（复用 source.vue .source-question-card 骨架，样式逐字搬自 workbench.vue）── */
.source-question-card {
  background: #fff;
  border-radius: 10px;
  border: 1px solid #f2f3f5;
  padding: 16px 20px;
  margin-bottom: 10px;
  transition: all 0.2s;
}

.source-question-card:hover {
  box-shadow: 0 4px 16px rgba(30, 138, 138, 0.1);
  border-color: #d0e2ff;
}

/* workbench-card 特有：底部工具栏需要更多 padding 空间 */
.workbench-card {
  padding-bottom: 0;
}

/* ── 顶部 meta 行 ── */
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
  flex: 1;
  min-width: 0;
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

.source-text {
  font-size: 12px;
  color: #86909c;
}

/* 全卷连续序号圆圈 */
.q-global-num {
  width: 28px;
  height: 28px;
  background: linear-gradient(135deg, #1E8A8A, #176E6E);
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

/* 题型标签 */
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

/* ── 题干区 ── */
.q-stem-area {
  min-height: 60px;
  margin-bottom: 10px;
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

/* ── 解析区 ── */
.q-explain-area {
  background: #f8fffe;
  border-left: 3px solid #34c38f;
  border-radius: 0 6px 6px 0;
  padding: 10px 14px;
  margin-bottom: 10px;
}

.explain-label {
  font-size: 12px;
  font-weight: 600;
  color: #0d7a4a;
  margin-bottom: 6px;
}

.q-explain-img {
  max-width: 100%;
  height: auto;
  display: block;
}

/* ── 底部工具栏（misikt 风格）── */
/* 默认隐藏，悬停题卡才显示，保留占位不跳高 */
.q-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 10px 0 12px;
  border-top: 1px solid #f7f8fa;
  flex-wrap: wrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s;
}

.workbench-card:hover .q-toolbar {
  opacity: 1;
  pointer-events: auto;
}

.toolbar-score {
  display: flex;
  align-items: center;
  gap: 6px;
}

.toolbar-label {
  font-size: 12px;
  color: #86909c;
}

.toolbar-divider {
  width: 1px;
  height: 16px;
  background: #e4e7ed;
  margin: 0 4px;
  flex-shrink: 0;
}

.toolbar-btn {
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 0 6px;
  height: 28px;
  color: #4e5969;
}

.toolbar-btn:hover {
  color: #1E8A8A;
}
</style>
