<script setup lang="ts">
/**
 * QuestionCard — 题卡共享组件 (PRD-001 抽离)
 *
 * 背景：题卡原内联在 views/question/index.vue。PRD-001 三栏组卷工作台中栏
 * 需要"同质化题卡"，按 跨模块共享组件清单铁则（禁多处各自实现），抽成此共享组件，
 * 题库列表页 + 卷篮工作台中栏共用。
 *
 * 设计：
 *   - 纯展示 + 事件上抛，不持有任何业务状态（试题栏 / 收藏态由父层传 props + 监听 emit）。
 *   - actions 可配置：题库页用全套 ['draft','favorite','basket','detail']，
 *     工作台中栏只用 ['basket','detail']（misikt 中栏题卡无草稿/收藏）。
 *   - 题干图沿用题库原行为：原图 + referrerpolicy="no-referrer" + onerror 隐藏，
 *     永远 PNG 无损不压缩（记忆铁则）。
 */
import { computed, ref, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { Edit, EditPen, Star, ShoppingCart, Key } from '@element-plus/icons-vue'
import Icon from '@/components/Icon/index.vue'
import FreeTagList from '@/components/business/FreeTagList/index.vue'
import QuestionContent from '@/components/business/QuestionContent/index.vue'
import QuestionBlockRender from '@/components/business/QuestionBlockRender/index.vue'
import { parseBlockDoc } from '@/utils/blockSchema'
import type { QuestionItem } from '@/api/question/index'

// PRD-A-015 — 'edit' 为可选 action（opt-in，默认 actions 不含），仅「我的题库」等本人题场景启用。
type ActionKey = 'draft' | 'favorite' | 'basket' | 'detail' | 'edit'

const props = withDefaults(
  defineProps<{
    question: QuestionItem
    /** 是否已在试题栏 */
    inBasket?: boolean
    /** 试题栏 toggle 进行中（防连点） */
    basketLoading?: boolean
    /** 是否已收藏 */
    isFavorite?: boolean
    /** 收藏操作进行中 */
    favoriteLoading?: boolean
    /** 显示哪些操作按钮 */
    actions?: ActionKey[]
    /** 加入按钮文案（题库="+ 试题栏"，工作台中栏="+ 试题篮"，指向同一蓝色 QuestionBasket） */
    addLabel?: string
  }>(),
  {
    inBasket: false,
    basketLoading: false,
    isFavorite: false,
    favoriteLoading: false,
    actions: () => ['draft', 'favorite', 'basket', 'detail'],
    addLabel: '试题栏',
  },
)

const emit = defineEmits<{
  (e: 'basket-toggle', q: QuestionItem): void
  (e: 'detail', q: QuestionItem): void
  (e: 'favorite', q: QuestionItem): void
  (e: 'draft', q: QuestionItem): void
  (e: 'edit', q: QuestionItem): void
}>()

// PRD-A-015 — 结构化题：blockJson 能解析成非空文档则走 QuestionBlockRender 网格渲染
// （图片/选项/公式与详情/卷库/PDF 四端一致）；老题（无 blockJson）回落扁平 QuestionContent。
const parsedBlock = computed(() => parseBlockDoc(props.question.blockJson))

const showDraft = computed(() => props.actions.includes('draft'))
const showFavorite = computed(() => props.actions.includes('favorite'))
const showBasket = computed(() => props.actions.includes('basket'))
const showDetail = computed(() => props.actions.includes('detail'))
const showEdit = computed(() => props.actions.includes('edit'))

// 🔴 PRD-C-204 列表卡高度受控：仅当题干内容真正溢出 max-height 时才显示底部 fade 遮罩，
// 短题不挂遮罩（否则会盖在正常内容尾部，显脏）。ResizeObserver 兼顾图片异步加载导致的高度变化。
const stemRef = ref<HTMLElement | null>(null)
const stemClamped = ref(false)
let ro: ResizeObserver | null = null

function checkClamp() {
  const el = stemRef.value
  if (!el) return
  // 🔴 PRD-C-204 修：仅当内容**真超过 max-height(320)**才算溢出→挂底部遮罩。
  // 原用 scrollHeight-clientHeight>1 会被 1~3px 行高/descender 亚像素差误触发，
  // 导致短选择题(内容仅~100px)也挂白遮罩、盖住下排 C/D 选项(用户报"白色浮层")。
  // 改为对比 max-height：内容没顶到 320 就没有被裁的内容，不挂遮罩。
  const maxH = parseFloat(getComputedStyle(el).maxHeight)
  stemClamped.value = Number.isFinite(maxH) && el.scrollHeight > maxH + 2
}

onMounted(async () => {
  await nextTick()
  checkClamp()
  if (stemRef.value && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => checkClamp())
    ro.observe(stemRef.value)
  }
})

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
})

// 题目切换（虚拟滚动/分页复用同一组件实例）时重测
watch(() => props.question.id, () => nextTick().then(checkClamp))

function getQuestionTypeLabel(type: number): string {
  const map: Record<number, string> = { 1: '选择题', 2: '判断题', 3: '应用题', 4: '填空题', 5: '简答题' }
  return map[type] ?? `题型${type}`
}

function getQuestionTypeTag(type: number): 'success' | 'warning' | 'info' | 'primary' {
  const map: Record<number, 'primary' | 'success' | 'warning'> = { 1: 'primary', 4: 'success', 5: 'warning' }
  return map[type] ?? 'info'
}
</script>

<template>
  <div class="question-card" :class="{ 'in-basket': inBasket }">
    <!-- ══ 顶部 meta 行 ══ -->
    <div class="card-meta-row">
      <div class="card-meta-left">
        <span class="type-tag" :class="`type-tag--${getQuestionTypeTag(question.questionType)}`">
          {{ getQuestionTypeLabel(question.questionType) }}
        </span>
        <span class="meta-sep">难度:</span>
        <el-rate :model-value="question.difficult ?? 0" :max="4" disabled class="meta-rate" />
        <span class="meta-sep">知识点:</span>
        <el-tag
          v-if="question.questionKnowledges && question.questionKnowledges.length > 0"
          type="primary"
          size="small"
          class="knowledge-primary-tag"
        >
          {{ question.questionKnowledges[0].knowledgeName || question.questionKnowledges[0].knowledgeId }}
        </el-tag>
        <span v-else class="knowledge-empty">暂无</span>
      </div>

      <div class="card-meta-right">
        <el-button
          v-if="showEdit"
          size="small"
          class="action-btn"
          type="primary"
          plain
          @click="emit('edit', question)"
        >
          <el-icon><EditPen /></el-icon>编辑
        </el-button>
        <el-button v-if="showDraft" size="small" class="action-btn" @click="emit('draft', question)">
          <el-icon><Edit /></el-icon>草稿
        </el-button>
        <el-button
          v-if="showFavorite"
          size="small"
          class="action-btn"
          :type="isFavorite ? 'warning' : undefined"
          :loading="favoriteLoading"
          @click="emit('favorite', question)"
        >
          <el-icon><Star /></el-icon>
          {{ isFavorite ? '已收藏' : '收藏' }}
        </el-button>
        <el-button
          v-if="showBasket"
          size="small"
          class="action-btn action-btn--basket"
          :class="{ 'action-btn--basket-added': inBasket }"
          :type="inBasket ? undefined : 'primary'"
          :plain="!inBasket"
          :loading="basketLoading"
          @click="emit('basket-toggle', question)"
        >
          <el-icon v-if="!inBasket"><ShoppingCart /></el-icon>
          {{ inBasket ? '取消' : `+ ${addLabel}` }}
        </el-button>
      </div>
    </div>

    <!-- 题号小字行 -->
    <div class="card-id-row">
      <el-icon :size="11" style="vertical-align: middle; color: #c9cdd4;"><Key /></el-icon>
      <span class="q-id-text">{{ question.id }}</span>
    </div>

    <!-- 题干内容：结构化题(blockJson)走 QuestionBlockRender 网格；老题回落 QuestionContent 扁平 -->
    <div ref="stemRef" class="card-stem" :class="{ 'stem-clamped': stemClamped }">
      <QuestionBlockRender
        v-if="parsedBlock"
        :doc="parsedBlock"
      />
      <QuestionContent
        v-else
        :text="question.stemText"
        :img-url="question.stemImg"
        alt="题干"
        img-max-height="220px"
      />
    </div>

    <!-- ══ 底部 meta 行 ══ -->
    <div class="card-meta-bottom">
      <div class="card-meta-bottom-left">
        <span v-if="question.examPaperName" class="source-text">
          来源: {{ question.examPaperName }}{{ question.examYear ? ` · ${question.examYear}年` : '' }}
        </span>
        <FreeTagList
          v-if="question.freeTags && question.freeTags.length > 0"
          :tags="question.freeTags"
          mode="list"
          class="bottom-freetag-list"
        />
      </div>
      <div v-if="showDetail" class="card-meta-bottom-right">
        <el-button size="small" link type="primary" class="detail-link-btn" @click="emit('detail', question)">
          <Icon icon="ep:view" :size="13" />
          <span style="margin-left: 3px;">详情</span>
        </el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.question-card {
  background: #ffffff;
  border-radius: 10px;
  border: 1px solid #f2f3f5;
  padding: 14px 16px;
  margin-bottom: 10px;
  box-shadow: 0 2px 8px 0 rgba(30, 138, 138, 0.05);
  transition: all 0.2s ease;
  position: relative;
}

.question-card:hover {
  box-shadow: 0 6px 20px 0 rgba(30, 138, 138, 0.12);
  transform: translateY(-1px);
  border-color: #d0e2ff;
}

.question-card.in-basket {
  border-left: 3px solid #34c38f;
  background: #f8fffe;
}

.card-meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  flex-wrap: nowrap;
  gap: 8px;
}

.card-meta-left {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.meta-sep {
  font-size: 12px;
  color: #86909c;
  white-space: nowrap;
  flex-shrink: 0;
}

.meta-rate {
  display: inline-flex !important;
  vertical-align: middle;
  flex-shrink: 0;
}

:deep(.meta-rate .el-rate__icon) {
  font-size: 14px !important;
  margin-right: 1px;
}

.knowledge-primary-tag {
  flex-shrink: 0;
}

.knowledge-empty {
  font-size: 12px;
  color: #c9cdd4;
}

.card-meta-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.type-tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
}

.type-tag--primary {
  background: #e8f0ff;
  color: #3564d0;
}

.type-tag--success {
  background: #e6f9f2;
  color: #1e9e6e;
}

.type-tag--warning {
  background: #fff6e5;
  color: #c47d0e;
}

.type-tag--info {
  background: #f2f3f5;
  color: #86909c;
}

.card-id-row {
  display: flex;
  align-items: center;
  gap: 3px;
  margin-bottom: 6px;
}

.q-id-text {
  font-size: 11px;
  color: #c9cdd4;
}

/* 🔴 PRD-C-204 列表卡高度受控：max-height + overflow:hidden 让每张卡高度整齐，
   长题/大图不再撑爆；底部 fade 渐隐遮罩提示"还有更多，点详情看全"。
   仅列表卡(QuestionCard)限制，详情页(views/question/detail.vue)直接用
   QuestionBlockRender 不经此组件，不受波及、仍显示完整内容。 */
.card-stem {
  position: relative;
  margin-bottom: 8px;
  min-height: 40px;
  max-height: 320px;
  overflow: hidden;
}

/* 底部渐隐遮罩：仅内容真正溢出(stem-clamped)时柔和淡出，提示可点详情看全 */
.card-stem.stem-clamped::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 40px;
  background: linear-gradient(to bottom, rgba(255, 255, 255, 0), #ffffff 92%);
  pointer-events: none;
}

/* 在试题栏的卡背景是 #f8fffe，遮罩同步成该底色避免白边突兀 */
.question-card.in-basket .card-stem.stem-clamped::after {
  background: linear-gradient(to bottom, rgba(248, 255, 254, 0), #f8fffe 92%);
}

/* .stem-img / .stem-text / .stem-placeholder 已迁入 QuestionContent 组件内部，此处删除 */

.card-meta-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #f7f8fa;
  flex-wrap: wrap;
}

.card-meta-bottom-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  flex: 1;
  min-width: 0;
}

.card-meta-bottom-right {
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

.action-btn {
  border-radius: 5px;
  transition: all 0.2s ease;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.action-btn--basket {
  min-width: 80px;
}

.action-btn--basket-added {
  color: #86909c !important;
  border-color: #c9cdd4 !important;
  background: #f7f8fa !important;
  min-width: 60px;
  transition: all 0.2s ease;
}

.action-btn--basket-added:hover {
  color: #f56c6c !important;
  border-color: #f56c6c !important;
  background: #fff5f5 !important;
}

.detail-link-btn {
  font-size: 12px;
  display: inline-flex;
  align-items: center;
}
</style>
