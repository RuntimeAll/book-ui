<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import request from '@/http/request'
import type { QuestionItem, QuestionDetail } from '@/api/question/index'

// ── Props / Emits ────────────────────────────────────────────
const props = defineProps<{
  visible: boolean
  questionId: number | null
  // 可选：传入已有的题目数据（从列表缓存），避免额外请求接口
  questionData?: QuestionItem | null
}>()

const emit = defineEmits<{
  (e: 'update:visible', val: boolean): void
}>()

// ── 本地状态 ─────────────────────────────────────────────────
const loading = ref(false)
const fetchedDetail = ref<QuestionDetail | null>(null)

// 优先用传入的 questionData，其次用接口返回的 fetchedDetail
const detail = computed<QuestionItem | QuestionDetail | null>(
  () => fetchedDetail.value ?? props.questionData ?? null,
)

// ── 拉详情（尝试多个端点）────────────────────────────────────
async function loadDetail(id: number) {
  // 如果已有列表数据，不需要额外请求
  if (props.questionData) {
    fetchedDetail.value = null
    return
  }

  loading.value = true
  fetchedDetail.value = null
  try {
    // 尝试 GET /teacher/question/{id}
    const res = await request.get<QuestionDetail, QuestionDetail>(`/teacher/question/${id}`)
    if (res && typeof res === 'object' && 'id' in res) {
      fetchedDetail.value = res
    }
  } catch {
    // 500 时尝试 POST selectById
    try {
      const res2 = await request.post<QuestionDetail, QuestionDetail>('/teacher/question/selectById', { id })
      if (res2 && typeof res2 === 'object' && 'id' in res2) {
        fetchedDetail.value = res2
      }
    } catch {
      // 两个端点都失败，detail 将为 null（走 fallback UI）
    }
  } finally {
    loading.value = false
  }
}

// 监听 visible + questionId
watch(
  () => [props.visible, props.questionId] as const,
  ([visible, id]) => {
    if (visible && id !== null && id !== undefined) {
      loadDetail(id)
    }
    if (!visible) {
      fetchedDetail.value = null
    }
  },
  { immediate: true },
)

function close() {
  emit('update:visible', false)
}

function getQuestionTypeLabel(type: number): string {
  const map: Record<number, string> = { 1: '选择题', 4: '填空题', 5: '简答题' }
  return map[type] ?? `题型${type}`
}

function getQuestionTypeTag(type: number): 'success' | 'warning' | 'info' {
  const map: Record<number, 'success' | 'warning' | 'info'> = { 1: 'success', 4: 'warning', 5: 'info' }
  return map[type] ?? 'info'
}
</script>

<template>
  <el-drawer
    :model-value="visible"
    title="题目详情"
    direction="rtl"
    size="560px"
    :before-close="close"
    @closed="close"
  >
    <div v-if="loading" class="detail-loading">
      <el-skeleton :rows="8" animated />
    </div>

    <div v-else-if="!detail" class="detail-empty">
      <el-empty description="详情加载失败，请稍后重试" />
      <p style="text-align:center; color:#909399; font-size:13px;">
        题目 ID: {{ questionId }}
      </p>
    </div>

    <div v-else class="detail-content">
      <!-- 头部信息 -->
      <div class="detail-header">
        <el-tag :type="getQuestionTypeTag(detail.questionType)" style="margin-right:8px;">
          {{ getQuestionTypeLabel(detail.questionType) }}
        </el-tag>
        <el-rate :model-value="detail.difficult ?? 0" :max="4" disabled style="display:inline-flex;" />
        <span style="margin-left:auto; font-size:12px; color:#909399;">ID: {{ detail.id }}</span>
      </div>

      <!-- 题干 -->
      <div class="detail-section">
        <div class="section-label">题干</div>
        <div class="section-body">
          <img
            v-if="detail.stemImg"
            :src="detail.stemImg"
            class="detail-img"
            alt="题干"
            referrerpolicy="no-referrer"
            @error="(e: Event) => ((e.target as HTMLImageElement).style.display='none')"
          />
          <p v-else-if="detail.stemText" class="stem-text">{{ detail.stemText }}</p>
          <span v-else class="no-content">暂无题干</span>
        </div>
      </div>

      <!-- 答案 -->
      <div class="detail-section" v-if="detail.answerImg">
        <div class="section-label">答案</div>
        <div class="section-body">
          <img
            :src="detail.answerImg"
            class="detail-img"
            alt="答案"
            referrerpolicy="no-referrer"
            @error="(e: Event) => ((e.target as HTMLImageElement).style.display='none')"
          />
        </div>
      </div>

      <!-- 解析 -->
      <div class="detail-section" v-if="detail.explainImg">
        <div class="section-label">解析</div>
        <div class="section-body">
          <img
            :src="detail.explainImg"
            class="detail-img"
            alt="解析"
            referrerpolicy="no-referrer"
            @error="(e: Event) => ((e.target as HTMLImageElement).style.display='none')"
          />
        </div>
      </div>

      <!-- 知识点 -->
      <div class="detail-section" v-if="(detail.questionKnowledges?.length ?? 0) > 0">
        <div class="section-label">知识点</div>
        <div class="section-body" style="display:flex; flex-wrap:wrap; gap:6px;">
          <el-tag
            v-for="(k, i) in detail.questionKnowledges"
            :key="i"
            type="info"
            size="small"
          >
            {{ k.knowledgeName || k.knowledgeId }}
          </el-tag>
        </div>
      </div>

      <!-- 附加信息 -->
      <div class="detail-section" v-if="detail.examYear || detail.examPaperName || detail.freeTag">
        <div class="section-label">附加信息</div>
        <div class="section-body">
          <el-descriptions :column="1" size="small" border>
            <el-descriptions-item v-if="detail.examYear" label="考试年份">
              {{ detail.examYear }}
            </el-descriptions-item>
            <el-descriptions-item v-if="detail.examPaperName" label="来源试卷">
              {{ detail.examPaperName }}
            </el-descriptions-item>
            <el-descriptions-item v-if="detail.freeTag" label="自由标签">
              {{ detail.freeTag }}
            </el-descriptions-item>
          </el-descriptions>
        </div>
      </div>
    </div>

    <template #footer>
      <el-button @click="close">关闭</el-button>
    </template>
  </el-drawer>
</template>

<style scoped>
.detail-loading,
.detail-empty {
  padding: 20px;
}

.detail-content {
  padding: 0 4px;
}

.detail-header {
  display: flex;
  align-items: center;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid #f0f0f0;
}

.detail-section {
  margin-bottom: 20px;
}

.section-label {
  font-size: 13px;
  font-weight: 600;
  color: #606266;
  margin-bottom: 8px;
  padding-left: 8px;
  border-left: 3px solid #409eff;
}

.section-body {
  padding-left: 8px;
}

.detail-img {
  max-width: 100%;
  display: block;
  border-radius: 4px;
}

.stem-text {
  font-size: 14px;
  color: #303133;
  line-height: 1.7;
  margin: 0;
}

.no-content {
  font-size: 13px;
  color: #c0c4cc;
}
</style>
