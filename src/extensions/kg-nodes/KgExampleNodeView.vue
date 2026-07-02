<!--
  kgExample 自定义节点的 Vue NodeView（生产版）。
  attrs: { qid: string, knowledgeId: string }
  mounted 时按 qid 调 GET /api/teacher/kg/questions?qids={qid}（元信息+富文本兜底）
  并批查 /teacher/question/list?ids=（题块三件套）——题块非空时直接复用题库的
  QuestionBlockRender 结构化渲染（与题库详情页同一渲染层，讲义侧零转换），
  否则回落富文本 v-safe-html（DOMPurify 过滤，全局指令）
-->
<script setup lang="ts">
import { NodeViewWrapper } from '@tiptap/vue-3'
import { ref, onMounted } from 'vue'
import { getKgQuestions } from '@/api/kg/doc'
import type { KgQuestion } from '@/api/kg/doc'
import { questionListByIds } from '@/api/question/index'
import QuestionBlockRender from '@/components/business/QuestionBlockRender/index.vue'
import { parseBlockDoc, type QuestionBlockDoc } from '@/utils/blockSchema'

const props = defineProps<{
  node: { attrs: { qid: string; knowledgeId: string } }
  selected: boolean
}>()

const question = ref<KgQuestion | null>(null)
const stemBlock = ref<QuestionBlockDoc | null>(null)
const answerBlock = ref<QuestionBlockDoc | null>(null)
const analyzeBlock = ref<QuestionBlockDoc | null>(null)
const loading = ref(false)
const errorMsg = ref<string | null>(null)
const explainOpen = ref(false)

onMounted(async () => {
  const qid = props.node.attrs.qid
  if (!qid) return
  loading.value = true
  errorMsg.value = null
  try {
    // 元信息与题块并行拉取；题块失败不算错（回落富文本渲染即可）
    const [list, details] = await Promise.all([
      getKgQuestions([qid]),
      questionListByIds([qid]).catch(() => []),
    ])
    question.value = list[0] ?? null
    if (!question.value) {
      errorMsg.value = `题目未找到（qid=${qid}）`
    }
    const detail = details[0]
    stemBlock.value = parseBlockDoc(detail?.blockJson)
    answerBlock.value = parseBlockDoc(detail?.answerBlockJson)
    analyzeBlock.value = parseBlockDoc(detail?.analyzeBlockJson)
  } catch (e: unknown) {
    errorMsg.value = e instanceof Error ? e.message : '题目加载失败'
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <NodeViewWrapper
    class="kg-example-node"
    :class="{ selected: props.selected }"
    data-drag-handle
  >
    <!-- 加载中 -->
    <div v-if="loading" class="kg-example-loading">
      <span class="kg-example-badge">例题</span>
      <span class="kg-example-loading-text">加载中…</span>
    </div>

    <!-- 加载失败 -->
    <div v-else-if="errorMsg" class="kg-example-error">
      <span class="kg-example-badge error">例题</span>
      <span class="kg-example-error-text">{{ errorMsg }}</span>
      <span class="kg-example-qid">（qid: {{ props.node.attrs.qid }}）</span>
    </div>

    <!-- 渲染题目 -->
    <div v-else-if="question" class="kg-example-content">
      <!-- 标题行 -->
      <div class="kg-example-title-row">
        <span class="kg-example-badge">例题</span>
        <span v-if="question.type" class="kg-example-type">{{ question.type }}</span>
        <span v-if="question.source" class="kg-example-source">{{ question.source }}</span>
      </div>

      <!-- 题干：有题块走题库同款结构化渲染，否则回落富文本（v-safe-html，DOMPurify 过滤） -->
      <QuestionBlockRender v-if="stemBlock" class="kg-example-stem" :doc="stemBlock" />
      <div v-else class="kg-example-stem" v-safe-html="question.stem" />

      <!-- 答案（蓝色，可折叠暂不实现，直接展示） -->
      <div v-if="answerBlock || question.answer" class="kg-example-answer">
        <span class="kg-example-answer-label">答案：</span>
        <QuestionBlockRender v-if="answerBlock" class="kg-example-answer-text" :doc="answerBlock" />
        <span v-else class="kg-example-answer-text" v-safe-html="question.answer" />
      </div>

      <!-- 详解（灰底，可折叠） -->
      <div v-if="analyzeBlock || question.explainText" class="kg-example-explain-wrap">
        <button class="kg-example-explain-toggle" @click.stop="explainOpen = !explainOpen">
          <span>{{ explainOpen ? '▲' : '▼' }}</span>
          <span>{{ explainOpen ? '收起详解' : '展开详解' }}</span>
        </button>
        <template v-if="explainOpen">
          <QuestionBlockRender v-if="analyzeBlock" class="kg-example-explain" :doc="analyzeBlock" />
          <div v-else class="kg-example-explain" v-safe-html="question.explainText" />
        </template>
      </div>
    </div>

    <!-- 空占位（qid 未设置） -->
    <div v-else class="kg-example-placeholder">
      <span class="kg-example-badge">例题</span>
      <span class="kg-example-placeholder-text">qid 未配置</span>
    </div>
  </NodeViewWrapper>
</template>

<style scoped>
.kg-example-node {
  display: block;
  margin: 12px 0;
  border: 1.5px solid #bfdbfe;
  border-radius: 8px;
  padding: 14px 16px;
  background: #f0f7ff;
  cursor: default;
  user-select: none;
}

.kg-example-node.selected {
  outline: 2px solid #2563eb;
}

/* 通用行布局 */
.kg-example-loading,
.kg-example-error,
.kg-example-placeholder {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

/* 标签 */
.kg-example-badge {
  display: inline-block;
  background: #2563eb;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 3px;
  white-space: nowrap;
  flex-shrink: 0;
}

.kg-example-badge.error {
  background: #dc2626;
}

/* 加载 / 错误 / 占位文字 */
.kg-example-loading-text {
  color: #64748b;
  font-style: italic;
}

.kg-example-error-text {
  color: #dc2626;
  font-size: 13px;
}

.kg-example-error .kg-example-qid {
  color: #94a3b8;
  font-size: 11px;
  font-family: monospace;
}

.kg-example-placeholder-text {
  color: #94a3b8;
  font-style: italic;
}

/* 内容区 */
.kg-example-content {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.kg-example-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.kg-example-type {
  font-size: 12px;
  color: #3b82f6;
  background: #dbeafe;
  padding: 1px 6px;
  border-radius: 10px;
}

.kg-example-source {
  font-size: 12px;
  color: #64748b;
  font-style: italic;
}

/* 题干 */
.kg-example-stem {
  font-size: 14px;
  color: #1e293b;
  line-height: 1.8;
}

/* 答案（蓝色） */
.kg-example-answer {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: flex-start;
  font-size: 14px;
  line-height: 1.7;
}

.kg-example-answer-label {
  font-weight: 600;
  color: #1d4ed8;
  white-space: nowrap;
  flex-shrink: 0;
}

.kg-example-answer-text {
  color: #2563eb;
}

/* 详解折叠 */
.kg-example-explain-wrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.kg-example-explain-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: 1px solid #cbd5e1;
  border-radius: 4px;
  padding: 3px 10px;
  font-size: 12px;
  color: #475569;
  cursor: pointer;
  align-self: flex-start;
}

.kg-example-explain-toggle:hover {
  background: #f1f5f9;
  border-color: #94a3b8;
}

.kg-example-explain {
  background: #f1f5f9;
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 13px;
  color: #475569;
  line-height: 1.8;
}
</style>
