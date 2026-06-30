<script setup lang="ts">
/**
 * PRD-A-010 T3 — 题目详情右侧 sidebar（纯结构性抽取，行为不变）
 *
 * 抽离自 detail.vue 右侧三张 sidebar card：我的备注 / 收录情况 / 题目信息。
 * 🔴 纯结构搬运：模板/样式/交互照搬。数据由父组件 props 传入（父持 API 加载逻辑）：
 *   - 备注：note/notesLoading/noteSaving + noteInput 走 v-model（update:noteInput）
 *   - 收录：sources/sourcesLoading；点收录卡 emit('go-to-source', paperId)
 *   - 题目信息：questionType（题型彩标，纯函数随迁）
 * 保存备注动作 emit('save-note')，父级 saveNote 接住，行为零变化。
 *
 * G6 fix（2026-06-25）：题型标签改读字典 SSOT（biz_question_type），与 QuestionCard 同口径，
 * 覆盖 type 6(作图)/7(计算)/8(证明)；移除本地硬编码 map。
 */
import { Plus } from '@element-plus/icons-vue'
import type { QuestionNote, QuestionSource } from '@/api/question/index'
import { useDictStore, DICT_QUESTION_TYPE } from '@/store/dict'

defineProps<{
  note: QuestionNote | null
  notesLoading: boolean
  noteInput: string
  noteSaving: boolean
  sources: QuestionSource[]
  sourcesLoading: boolean
  questionType: number
}>()

const emit = defineEmits<{
  (e: 'update:noteInput', v: string): void
  (e: 'save-note'): void
  // PRD-A-013 T2 — paperId 雪花 string
  (e: 'go-to-source', paperId: string): void
}>()

// G6 fix：题型标签读字典 SSOT，与 QuestionCard 同口径（biz_question_type 8 类全覆盖）。
// 原硬编码 { 1:'选择题', 4:'填空题', 5:'简答题' } 导致 type 6/7/8 显示「题型N」且 type5 标签
// 与列表卡「解答题」不一致（列表卡走字典，详情侧栏走硬编码）。
const dict = useDictStore()
dict.load(DICT_QUESTION_TYPE)

function getQuestionTypeLabel(type: number): string {
  return dict.label(DICT_QUESTION_TYPE, type) || `题型${type}`
}

function getQuestionTypeTagType(type: number): 'primary' | 'success' | 'warning' | 'info' {
  // 徽标颜色走字典 list_class（biz_question_type，超管可维护）
  return dict.tagType(DICT_QUESTION_TYPE, type, 'info') as 'primary' | 'success' | 'warning' | 'info'
}
</script>

<template>
  <div class="detail-sidebar">
    <!-- 我的备注 card -->
    <div class="sidebar-card">
      <div class="sidebar-card-header">
        <span class="sidebar-card-title">我的备注</span>
      </div>
      <div class="sidebar-card-body" v-loading="notesLoading">
        <div v-if="!note && !notesLoading" class="no-notes">
          还没有备注
        </div>
        <div
          v-else-if="note"
          class="note-item"
        >
          <span class="note-content">{{ note.content }}</span>
          <span class="note-time">{{ note.updateTime }}</span>
        </div>
        <!-- 添加备注 -->
        <div class="note-add">
          <el-input
            :model-value="noteInput"
            type="textarea"
            :rows="2"
            placeholder="输入备注内容..."
            size="small"
            @update:model-value="emit('update:noteInput', $event)"
          />
          <el-button
            type="primary"
            size="small"
            :loading="noteSaving"
            :disabled="!noteInput.trim()"
            class="note-save-btn"
            @click="emit('save-note')"
          >
            <el-icon><Plus /></el-icon>添加
          </el-button>
        </div>
      </div>
    </div>

    <!-- 收录情况 card -->
    <div class="sidebar-card">
      <div class="sidebar-card-header">
        <span class="sidebar-card-title">收录情况</span>
        <el-tag type="info" size="small" round>{{ sources.length }}</el-tag>
      </div>
      <div class="sidebar-card-body" v-loading="sourcesLoading">
        <div v-if="sources.length === 0 && !sourcesLoading" class="no-content">
          暂无收录信息
        </div>
        <div
          v-else
          v-for="src in sources"
          :key="src.examPaperId"
          class="source-item-card"
          @click="emit('go-to-source', src.examPaperId)"
        >
          <span class="source-paper-name">{{ src.examPaperName }}</span>
          <el-tag type="warning" size="small" class="source-tag">来源</el-tag>
          <span v-if="src.examYear" class="source-year">{{ src.examYear }}</span>
        </div>
      </div>
    </div>

    <!-- 题目信息（用户 2026-06-05 重整：加标题不再裸，题型用彩色 tag，移除题目ID）-->
    <div class="sidebar-card">
      <div class="sidebar-card-header">
        <span class="sidebar-card-title">题目信息</span>
      </div>
      <div class="sidebar-card-body">
        <div class="info-row">
          <span class="info-label">题型</span>
          <el-tag
            :type="getQuestionTypeTagType(questionType)"
            size="small"
            effect="light"
            round
          >
            {{ getQuestionTypeLabel(questionType) }}
          </el-tag>
        </div>
      </div>
      <!-- 题目ID 已移除（对老师无意义，用户 2026-06-05 拍板）；
           创建时间已隐藏(2026-06-04): BE createTime 是 misikt 导入占位戳，非真实时间，待录题功能落地再恢复。 -->
    </div>
  </div>
</template>

<style scoped>
/* ── 右侧 sidebar（逐字搬自 detail.vue）── */
.detail-sidebar {
  flex: 3;
  min-width: 240px;
  max-width: 360px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.sidebar-card {
  background: #fff;
  border-radius: 10px;
  border: 1px solid #f2f3f5;
  overflow: hidden;
}

.sidebar-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px 10px;
  border-bottom: 1px solid #f2f3f5;
}

.sidebar-card-title {
  font-size: 14px;
  font-weight: 600;
  color: #1d2129;
}

.sidebar-card-body {
  padding: 12px 14px;
}

.no-notes {
  font-size: 13px;
  color: #c9cdd4;
  text-align: center;
  padding: 8px 0;
}

.note-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px dashed #f2f3f5;
}

.note-content {
  font-size: 13px;
  color: #1d2129;
  line-height: 1.5;
}

.note-time {
  font-size: 11px;
  color: #c9cdd4;
}

.note-add {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}

.note-save-btn {
  align-self: flex-end;
}

.no-content {
  font-size: 13px;
  color: #c9cdd4;
}

/* 收录情况 card */
.source-item-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid #f7f8fa;
  cursor: pointer;
  border-radius: 6px;
  transition: background 0.15s;
  flex-wrap: wrap;
}

.source-item-card:hover {
  background: #f0f6ff;
  padding-left: 4px;
}

.source-item-card:last-child {
  border-bottom: none;
}

.source-paper-name {
  font-size: 13px;
  color: #1d2129;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-tag {
  flex-shrink: 0;
}

.source-year {
  font-size: 12px;
  color: #86909c;
  flex-shrink: 0;
}

/* 题目信息 card —— 单行：左 label / 右彩色 tag */
.info-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.info-label {
  font-size: 13px;
  color: #86909c;
}
</style>
