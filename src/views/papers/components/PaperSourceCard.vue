<script setup lang="ts">
/**
 * PRD-A-010 T3 — 原卷查看态题卡（纯结构性抽取，行为不变）
 *
 * 抽离自 source.vue 查看态 .source-question-card（顶 meta + 题干 + 底 meta）。
 * 🔴 纯结构搬运：模板输出/样式/交互照搬，对父级 handler 的直接调用改 emit。
 *
 * 试题栏状态由父组件传入（inBasket / basketLoading），父持 useQuestionBasket
 * 全局单例（memory project_shared_components：试题栏共享，禁多处各自实现）。
 * 草稿/收藏/详情/试题栏 toggle 动作 emit 给父级原函数接住，行为零变化。
 *
 * getQuestionTypeLabel / getQuestionTypeTag / getQuestionScore 是纯函数，随卡迁入。
 */
import { computed } from 'vue'
import { Check, ShoppingCart, Edit, Star, InfoFilled } from '@element-plus/icons-vue'
import FreeTagList from '@/components/business/FreeTagList/index.vue'
import QuestionContent from '@/components/business/QuestionContent/index.vue'
import QuestionBlockRender from '@/components/business/QuestionBlockRender/index.vue'
import { parseBlockDoc } from '@/utils/blockSchema'
import type { PaperSourceQuestion } from '@/api/question/index'

const props = defineProps<{
  q: PaperSourceQuestion
  /** 该题是否已在试题栏（父 basket.basketIds.value.has(q.id)）*/
  inBasket: boolean
  /** 试题栏该题操作 loading（父 basket.isLoading(q.id)）*/
  basketLoading: boolean
}>()

// PRD-A-015 — 结构化题：blockJson 能解析成非空文档则走 QuestionBlockRender 网格渲染
// （选项/图片/公式与题库·详情·PDF 四端一致 = 同源渲染组件）；老题（无 blockJson）回落扁平 QuestionContent。
const parsedBlock = computed(() => parseBlockDoc(props.q.blockJson))

const emit = defineEmits<{
  (e: 'draft'): void
  (e: 'favorite', q: PaperSourceQuestion): void
  (e: 'basket-toggle', q: PaperSourceQuestion): void
  (e: 'detail', q: PaperSourceQuestion): void
}>()

// ── 纯函数（逐字搬自 source.vue）──
function getQuestionTypeLabel(type: number): string {
  const map: Record<number, string> = { 1: '选择题', 4: '填空题', 5: '简答题' }
  return map[type] ?? `题型${type}`
}

function getQuestionTypeTag(type: number): 'success' | 'warning' | 'info' | 'primary' | 'danger' {
  const map: Record<number, 'primary' | 'success' | 'warning'> = { 1: 'primary', 4: 'success', 5: 'warning' }
  return map[type] ?? 'info'
}

function getQuestionScore(q: PaperSourceQuestion): number | null {
  const s = q.pqScore ?? q.score
  return s == null ? null : Number(s)
}
</script>

<template>
  <div
    class="source-question-card"
    :class="{ 'in-basket': inBasket }"
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
        <el-button size="small" link class="action-icon-btn" @click="emit('draft')">
          <el-icon><Edit /></el-icon>草稿
        </el-button>
        <el-button
          size="small"
          link
          class="action-icon-btn"
          :class="{ 'is-fav': q.isFavorite }"
          @click="emit('favorite', q)"
        >
          <el-icon><Star /></el-icon>{{ q.isFavorite ? '已收藏' : '收藏' }}
        </el-button>
        <el-button
          size="small"
          class="action-basket-btn"
          :class="{ 'action-basket-btn--added': inBasket }"
          :type="inBasket ? undefined : 'primary'"
          :plain="!inBasket"
          :loading="basketLoading"
          @click="emit('basket-toggle', q)"
        >
          <el-icon v-if="inBasket"><Check /></el-icon>
          <el-icon v-else><ShoppingCart /></el-icon>
          {{ inBasket ? '已在试题栏' : '+ 试题栏' }}
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
      <!-- 题干内容：结构化题(blockJson)走 QuestionBlockRender 网格(题干+选项+图)；老题回落 QuestionContent 扁平 -->
      <div class="q-stem-body">
        <QuestionBlockRender
          v-if="parsedBlock"
          :doc="parsedBlock"
        />
        <QuestionContent
          v-else
          :text="q.stemText"
          :img-url="q.stemImg"
          alt="题干"
        />
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
          @click="emit('detail', q)"
        >
          <el-icon><InfoFilled /></el-icon>
          详情
        </el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ── 题目卡片（逐字搬自 source.vue 查看态题卡）── */
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
  color: #1E8A8A;
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
</style>
