<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowLeft, Download } from '@element-plus/icons-vue'
import { useQuestionBasket } from '@/composables/useQuestionBasket'
import { createExamPaper } from '@/api/paper'

const router = useRouter()
const basket = useQuestionBasket()

const paperName = ref('未命名草稿')
const submitting = ref(false)

const itemCount = computed(() => basket.items.value.length)
const isEmpty = computed(() => itemCount.value === 0)

// QuestionItem.questionType 口径（src/api/question/index.ts:42）：1=选择 / 4=填空 / 5=简答。
// 2=判断 / 3=应用 是 misikt 较少出现的类型，保留兜底覆盖。
function questionTypeLabel(type: number): string {
  if (type === 1) return '选择题'
  if (type === 2) return '判断题'
  if (type === 3) return '应用题'
  if (type === 4) return '填空题'
  if (type === 5) return '简答题'
  return `类型${type}`
}

async function handleRemove(id: number) {
  await basket.remove(id)
}

async function handleCreate() {
  if (isEmpty.value) {
    ElMessage.warning('请先在试题栏添加题目')
    return
  }
  const trimmedName = paperName.value.trim()
  if (!trimmedName) {
    ElMessage.warning('请输入试卷名称')
    return
  }
  submitting.value = true
  try {
    const result = await createExamPaper({
      name: trimmedName,
      questionIds: basket.items.value.map(q => q.id),
    })
    if (!result || !result.paperId) {
      ElMessage.error('创建失败：服务器未返回试卷 ID')
      return
    }
    ElMessage.success(`已创建试卷《${trimmedName}》— ${result.questionCount} 题`)
    await basket.clear()
    router.push(`/papers/source/${result.paperId}`)
  } catch (e) {
    console.error('[compose] createExamPaper failed', e)
    ElMessage.error('创建失败，请稍后重试')
  } finally {
    submitting.value = false
  }
}

// Q 卡用户验收发现 PDF 简单 html2canvas 输出 ≠ misikt 真站效果（无图片 / 无 LaTeX / 无分组 / 无答案勾选）。
// 拍板：本卡 disabled 占位，专立 Q' 子卡做完整试卷预览模态 + LaTeX + 分组 + PDF。
function handleExportPdf() {
  ElMessage.info('PDF 导出功能由 Q\' 子卡交付（预览模态 + LaTeX + 分组）')
}

async function handleClear() {
  if (isEmpty.value) return
  try {
    await ElMessageBox.confirm('清空将移除当前试题栏中所有题目，确认？', '清空确认', {
      confirmButtonText: '确定清空',
      cancelButtonText: '取消',
      type: 'warning',
    })
    await basket.clear()
  } catch {
    // 取消
  }
}

function handleBack() {
  router.push('/question/index')
}
</script>

<template>
  <div class="compose-workbench">
    <!-- 顶部工具栏 -->
    <div class="toolbar">
      <div class="toolbar-left">
        <el-button link @click="handleBack">
          <el-icon><ArrowLeft /></el-icon>
          返回题库
        </el-button>
        <h2 class="page-title">组卷工作台</h2>
      </div>
      <div class="toolbar-right">
        <span class="meta">共 <b>{{ itemCount }}</b> 题</span>
        <el-button
          size="small"
          :disabled="isEmpty"
          @click="handleClear"
        >
          清空试题栏
        </el-button>
      </div>
    </div>

    <!-- 试卷名称输入 -->
    <div class="name-section">
      <label>试卷名称</label>
      <el-input
        v-model="paperName"
        placeholder="未命名草稿"
        maxlength="200"
        clearable
        size="large"
        class="name-input"
      />
    </div>

    <!-- 题目预览列表 -->
    <div class="questions-section">
      <div class="section-header">
        <span class="section-title">{{ paperName.trim() || '未命名草稿' }}</span>
        <span class="section-meta">共 {{ itemCount }} 题</span>
      </div>
      <div v-if="isEmpty" class="empty-state">
        <el-empty description="试题栏为空，请先到题库挑选题目">
          <el-button type="primary" @click="handleBack">去题库选题</el-button>
        </el-empty>
      </div>
      <ol v-else class="question-list">
        <li
          v-for="(q, idx) in basket.items.value"
          :key="q.id"
          class="question-item"
        >
          <div class="q-head">
            <span class="q-no">{{ idx + 1 }}</span>
            <el-tag size="small" type="info">{{ questionTypeLabel(q.questionType) }}</el-tag>
            <span class="q-id">#{{ q.id }}</span>
            <div class="q-actions">
              <el-button
                size="small"
                link
                type="danger"
                @click="handleRemove(q.id)"
              >
                移除
              </el-button>
            </div>
          </div>
          <div class="q-stem">
            <!-- 题干 HTML（含 LaTeX 原文，Q' 卡再上 MathJax 渲染） — v-html 不 stripHtml，避免内容被剥光 -->
            <div v-if="q.stemText" class="stem-text" v-html="q.stemText"></div>
            <img v-if="q.stemImg" :src="q.stemImg" alt="题图" class="stem-img" />
            <span v-if="!q.stemText && !q.stemImg" class="q-stem-placeholder">
              题干数据缺失（LS 缓存未含完整字段）
            </span>
          </div>
        </li>
      </ol>
    </div>

    <!-- 底部操作栏 -->
    <div class="footer">
      <el-tooltip content="预览模态 + LaTeX 渲染 + 分组打印由 Q' 子卡交付" placement="top">
        <el-button
          size="large"
          disabled
          @click="handleExportPdf"
        >
          <el-icon><Download /></el-icon>
          导出 PDF（开发中）
        </el-button>
      </el-tooltip>
      <el-button
        type="primary"
        size="large"
        :loading="submitting"
        :disabled="isEmpty"
        @click="handleCreate"
      >
        创建试卷
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.compose-workbench {
  max-width: 1100px;
  margin: 20px auto;
  padding: 0 20px 40px;
}

.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid #e8eaec;
  margin-bottom: 20px;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.page-title {
  font-size: 18px;
  font-weight: 600;
  color: #1d2129;
  margin: 0;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.toolbar-right .meta {
  color: #4e5969;
  font-size: 13px;
}

.toolbar-right .meta b {
  color: #4080ff;
  font-weight: 600;
  font-size: 15px;
}

.name-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 24px;
  background: #fff;
  padding: 16px 20px;
  border-radius: 8px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
}

.name-section label {
  font-size: 13px;
  color: #86909c;
  font-weight: 500;
}

.questions-section {
  background: #fff;
  border-radius: 8px;
  padding: 16px 20px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
  margin-bottom: 80px;
}

.section-header {
  padding-bottom: 12px;
  border-bottom: 1px solid #f0f1f3;
  margin-bottom: 12px;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: #1d2129;
}

.section-meta {
  font-size: 12px;
  color: #86909c;
}

.empty-state {
  padding: 40px 0;
}

.question-list {
  list-style: none;
  padding: 0;
  margin: 0;
  counter-reset: q-counter;
}

.question-item {
  padding: 14px 0;
  border-bottom: 1px dashed #f0f1f3;
}

.question-item:last-child {
  border-bottom: none;
}

.q-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.q-no {
  background: #4080ff;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  border-radius: 50%;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.q-id {
  color: #c9cdd4;
  font-size: 12px;
}

.q-actions {
  margin-left: auto;
}

.q-stem {
  color: #4e5969;
  font-size: 14px;
  line-height: 1.7;
  padding-left: 32px;
}

.stem-text {
  word-break: break-word;
}

.stem-text :deep(p) {
  margin: 0;
}

.stem-text :deep(img) {
  max-width: 100%;
  max-height: 200px;
  border-radius: 4px;
  vertical-align: middle;
}

.stem-img {
  display: block;
  max-width: 100%;
  max-height: 240px;
  border-radius: 4px;
  margin-top: 6px;
}

.q-stem-placeholder {
  color: #c9cdd4;
  font-style: italic;
  font-size: 13px;
}

.footer {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  background: #fff;
  box-shadow: 0 -2px 12px rgba(0, 0, 0, 0.06);
  padding: 16px 24px;
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  z-index: 50;
}
</style>
