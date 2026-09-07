<script setup lang="ts">
/**
 * QuestionBasket — 试题栏全局浮动按钮 + dialog 容器
 *
 * 设计：基于 useQuestionBasket composable（module-scoped singleton），
 * 在 AppLayout 全局挂载一次，任意页面调 add/remove 实时联动 FAB 角标 + dialog 列表。
 *
 * 抽离自第十二波前的 src/views/question/index.vue（模板行 766-892 / style 1265-1410）。
 */
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'

import { ShoppingCart, Delete, DocumentAdd, Close, ZoomIn } from '@element-plus/icons-vue'
import { useQuestionBasket } from '@/composables/useQuestionBasket'
import { useBasketQuestionPreview } from '@/composables/useBasketQuestionPreview'
import { parseBlockDoc } from '@/utils/blockSchema'
import QuestionBlockRender from '@/components/business/QuestionBlockRender/index.vue'
import { useDictStore, DICT_QUESTION_TYPE } from '@/store/dict'
// 放大预览复用题库/组卷工作台共享题卡组件（actions=[] 关掉操作按钮，纯展示题干大图 + meta），不另造预览渲染。
import QuestionCard from '@/components/business/QuestionCard/index.vue'
import QuestionContent from '@/components/business/QuestionContent/index.vue'

const basket = useQuestionBasket()
const router = useRouter()
const composing = ref(false)

async function handleGoCompose() {
  if (basket.count.value === 0) {
    ElMessage.warning('试题栏为空，请先加题')
    return
  }
  composing.value = true
  try {
    basket.closeDialog()
    await router.push('/papers/workbench')
  } finally {
    composing.value = false
  }
}

async function handleClearBasket() {
  try { await basket.clear() } catch { /* 状态层已显示错误。 */ }
}
async function handleRemoveBasket(id: string) {
  try { await basket.remove(id) } catch { /* 状态层已显示错误。 */ }
}
async function refreshBasket(page?: number) {
  try { await basket.syncFromServer(page) } catch { /* 面板展示错误。 */ }
}

// PRD-C-204：题型标签读字典 SSOT
const dict = useDictStore()
dict.load(DICT_QUESTION_TYPE)
function getQuestionTypeLabel(type: number): string {
  return dict.label(DICT_QUESTION_TYPE, type) || `题型${type}`
}

function getQuestionTypeTag(type: number): 'success' | 'warning' | 'info' | 'primary' | 'danger' {
  // 徽标颜色走字典 list_class（biz_question_type，超管可维护）
  return dict.tagType(DICT_QUESTION_TYPE, type, 'info') as 'success' | 'warning' | 'info' | 'primary' | 'danger'
}

const { explainState, previewVisible, previewItem, previewDetail, toggleExplain, openPreview } =
  useBasketQuestionPreview()
</script>

<template>
  <!-- ── FAB 试题栏浮动按钮 ── -->
  <!-- J 卡 段① 修：el-badge 改包整个 .basket-fab + 加 :offset 把角标贴到按钮右上角内侧，
       不再嵌在 fab-inner 内部导致角标位置偏离按钮主体 -->
  <el-badge
    class="basket-fab-badge"
    :value="basket.count.value > 99 ? '99+' : basket.count.value"
    :hidden="basket.count.value === 0"
    :offset="[-10, 8]"
    type="danger"
  >
    <div
      class="basket-fab"
      :class="{ 'has-items': basket.count.value > 0 }"
      @click="basket.openDialog()"
    >
      <div class="fab-inner">
        <el-icon :size="20" color="#fff"><ShoppingCart /></el-icon>
        <span class="fab-label">试题栏</span>
      </div>
    </div>
  </el-badge>

  <!-- ── 试题栏 dialog ── -->
  <el-dialog
    v-model="basket.dialogVisible.value"
    width="720px"
    style="max-width: 92vw"
    :close-on-click-modal="false"
    class="basket-dialog"
  >
    <template #header>
      <div class="basket-dialog-header">
        <div class="basket-dialog-title-area">
          <el-icon color="#1E8A8A" :size="18"><ShoppingCart /></el-icon>
          <span class="basket-dialog-title">试题栏</span>
          <el-tag type="primary" size="small" round>{{ basket.count.value }} 题</el-tag>
        </div>
      </div>
    </template>

    <div v-loading="basket.loading.value" class="basket-dialog-body">
      <el-alert v-if="basket.error.value" :title="basket.error.value" type="error" :closable="false">
        <el-button link @click="refreshBasket()">重试</el-button>
      </el-alert>
      <el-empty
        v-if="!basket.loading.value && !basket.error.value && basket.count.value === 0"
        description="试题栏为空，请先在题库中加题"
      >
        <template #image>
          <el-icon style="font-size: 48px; color: #c9cdd4;"><ShoppingCart /></el-icon>
        </template>
      </el-empty>
      <el-scrollbar max-height="380px">
        <div class="basket-list">
        <div
          v-for="item in basket.items.value"
          :key="item.entryKey"
          class="basket-item"
          :data-item-id="item.entryKey"
        >
          <div class="basket-item-header">
            <span class="type-tag" :class="`type-tag--${getQuestionTypeTag(item.questionType)}`">
              {{ getQuestionTypeLabel(item.questionType) }}
            </span>
            <el-rate
              :model-value="item.difficult ?? 0"
              :max="4"
              disabled
              size="small"
              style="display:inline-flex; margin-left:6px;"
            />
            <div class="basket-knowledge-tags" v-if="(item.questionKnowledges?.length ?? 0) > 0">
              <el-tag
                v-for="(k, i) in item.questionKnowledges"
                :key="i"
                type="info"
                size="small"
                style="margin-left: 4px;"
              >
                {{ k.knowledgeName || k.knowledgeId }}
              </el-tag>
            </div>
            <div class="basket-item-ops">
              <el-button
                size="small"
                link
                type="primary"
                @click="openPreview(item)"
              >
                <el-icon><ZoomIn /></el-icon>放大
              </el-button>
              <el-button
                size="small"
                link
                @click="toggleExplain(item)"
              >
                {{ explainState[item.entryKey]?.open ? '收起解析' : '解析' }}
              </el-button>
              <el-button
                size="small"
                link
                type="danger"
                :loading="basket.isLoading(item.entryKey)"
                @click="handleRemoveBasket(item.entryKey)"
              >
                <el-icon><Close /></el-icon>移除
              </el-button>
            </div>
          </div>
          <!-- 题干（点击放大）— 富文本/图片/占位统一走 QuestionContent -->
          <div class="basket-item-stem" style="cursor: zoom-in;" @click="openPreview(item)">
            <QuestionBlockRender v-if="parseBlockDoc(item.blockJson)" :doc="parseBlockDoc(item.blockJson)!" />
            <QuestionContent
              v-else
              :text="item.stemTextContent ?? item.stemText"
              :img-url="item.stemImg"
              alt="题干（点击放大）"
              img-max-height="112px"
            />
          </div>
          <!-- 展开解析区（懒加载，富文本/图片统一走 QuestionContent）-->
          <div v-if="explainState[item.entryKey]?.open" class="basket-item-explain">
            <el-skeleton v-if="explainState[item.entryKey]?.loading" :rows="2" animated />
            <template v-else>
              <QuestionBlockRender v-if="parseBlockDoc(item.analyzeBlockJson)" :doc="parseBlockDoc(item.analyzeBlockJson)!" />
              <QuestionContent
                v-else-if="explainState[item.entryKey]?.img || explainState[item.entryKey]?.text"
                :text="explainState[item.entryKey]?.text || null"
                :img-url="explainState[item.entryKey]?.img || null"
                alt="解析"
              />
              <span v-else class="basket-explain-empty">暂无解析</span>
            </template>
          </div>
        </div>
        </div>
      </el-scrollbar>
      <el-pagination v-if="basket.count.value > basket.pageSize" small layout="prev, pager, next"
        :total="basket.count.value" :page-size="basket.pageSize" :current-page="basket.pageIndex.value"
        @current-change="refreshBasket" />
    </div>

    <template #footer>
      <div class="basket-footer">
        <div class="basket-footer-left">
          <el-button
            :disabled="basket.items.value.length === 0"
            @click="handleClearBasket"
          >
            <el-icon><Delete /></el-icon>清空
          </el-button>
        </div>
        <div class="basket-footer-right">
          <el-button @click="basket.closeDialog()">关闭</el-button>
          <el-button
            type="primary"
            :loading="composing"
            :disabled="basket.items.value.length === 0"
            class="compose-btn-footer"
            @click="handleGoCompose"
          >
            <el-icon><DocumentAdd /></el-icon>
            组卷（{{ basket.count.value }} 题）
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>

  <!-- ── 放大预览 dialog（复用 QuestionCard 渲染完整题目 + 懒加载答案/解析图）── -->
  <el-dialog
    v-model="previewVisible"
    width="760px"
    style="max-width: 94vw"
    :close-on-click-modal="true"
    class="basket-preview-dialog"
    append-to-body
  >
    <template #header>
      <div class="basket-preview-header">
        <el-icon color="#1E8A8A" :size="18"><ZoomIn /></el-icon>
        <span class="basket-preview-title">题目预览</span>
      </div>
    </template>
    <div v-if="previewItem" class="basket-preview-body">
      <!-- 复用共享题卡：actions=[] 关掉草稿/收藏/试题栏/详情，纯展示题干大图 + meta -->
      <QuestionCard :question="previewItem" :actions="[]" />
      <!-- 答案 / 解析（懒加载，富文本/图片统一走 QuestionContent）-->
      <div class="basket-preview-detail">
        <el-skeleton v-if="previewDetail.loading" :rows="3" animated />
        <template v-else>
          <div
            v-if="previewItem.answerBlockJson || previewDetail.answerImg || previewDetail.answerText"
            class="basket-preview-block"
          >
            <span class="basket-preview-label">【答案】</span>
            <QuestionBlockRender v-if="parseBlockDoc(previewItem.answerBlockJson)" :doc="parseBlockDoc(previewItem.answerBlockJson)!" />
            <QuestionContent
              v-else
              :text="previewDetail.answerText || null"
              :img-url="previewDetail.answerImg || null"
              alt="答案"
            />
          </div>
          <div
            v-if="previewItem.analyzeBlockJson || previewDetail.explainImg || previewDetail.explainText"
            class="basket-preview-block"
          >
            <span class="basket-preview-label">【解析】</span>
            <QuestionBlockRender v-if="parseBlockDoc(previewItem.analyzeBlockJson)" :doc="parseBlockDoc(previewItem.analyzeBlockJson)!" />
            <QuestionContent
              v-else
              :text="previewDetail.explainText || null"
              :img-url="previewDetail.explainImg || null"
              alt="解析"
            />
          </div>
          <span
            v-if="!previewItem.answerBlockJson && !previewItem.analyzeBlockJson && !previewDetail.answerImg && !previewDetail.answerText && !previewDetail.explainImg && !previewDetail.explainText"
            class="basket-preview-empty"
          >
            暂无答案 / 解析
          </span>
        </template>
      </div>
    </div>
    <template #footer>
      <el-button @click="previewVisible = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
/* ── FAB 浮动按钮 ── */
/* J 卡 段① 修：el-badge wrap 提供 fixed 定位锚点（替换原来 .basket-fab 上的 position:fixed） */
.basket-fab-badge {
  position: fixed;
  bottom: 40px;
  right: 40px;
  z-index: 200;
  line-height: 0; /* 防 el-badge 默认 inline-block 撑高度 */
}

.basket-fab {
  cursor: pointer;
}

.fab-inner {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: linear-gradient(135deg, #1E8A8A, #176E6E);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  box-shadow: 0 8px 24px rgba(30, 138, 138, 0.4);
  transition: all 0.25s ease;
}

.basket-fab:hover .fab-inner {
  transform: translateY(-3px);
  box-shadow: 0 12px 32px rgba(30, 138, 138, 0.5);
}

.fab-label {
  font-size: 11px;
  color: #fff;
  font-weight: 600;
  letter-spacing: 0.3px;
}

.basket-fab.has-items .fab-inner {
  animation: fab-pulse 2s infinite;
}

@keyframes fab-pulse {
  0%, 100% { box-shadow: 0 8px 24px rgba(30, 138, 138, 0.4); }
  50% { box-shadow: 0 8px 30px rgba(30, 138, 138, 0.6); }
}

/* ── 试题栏 dialog ── */
.basket-dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-right: 32px;
}

.basket-dialog-title-area {
  display: flex;
  align-items: center;
  gap: 8px;
}

.basket-dialog-title {
  font-size: 16px;
  font-weight: 700;
  color: #1d2129;
}

.basket-dialog-body {
  min-height: 80px;
  padding: 0 4px;
}

.basket-item {
  padding: 10px 0;
  border-bottom: 1px solid #EDF2F2;
}

.basket-item:last-child {
  border-bottom: none;
}

/* PRD-A-017 批2e 拖拽重排：手柄 + sortable 拖拽态（青系冷浅，与设计语言一致） */
.drag-handle {
  display: inline-flex;
  align-items: center;
  color: #9dafad;
  cursor: grab;
  padding: 0 2px;
  flex-shrink: 0;
  touch-action: none;
  user-select: none;
  transition: color 0.15s;
}
.drag-handle:hover {
  color: #1e8a8a;
}
.drag-handle:active {
  cursor: grabbing;
}
/* sortable 拖拽态：占位幽灵半透 + 抬起项加阴影 */
.basket-item-ghost {
  opacity: 0.4;
  background: #f5f8f8;
}
.basket-item-chosen {
  box-shadow: 0 2px 6px rgba(20, 60, 58, 0.05), 0 12px 28px -12px rgba(20, 60, 58, 0.16);
  background: #fff;
}

.basket-item-header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}

.basket-knowledge-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.basket-item-ops {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

.basket-item-stem {
  font-size: 13px;
  color: #303133;
  padding-left: 2px;
}

.stem-img-small {
  max-width: 100%;
  max-height: 112px;
  display: block;
  border-radius: 4px;
  cursor: zoom-in;
  transition: opacity 0.15s;
}

.stem-img-small:hover {
  opacity: 0.85;
}

.basket-stem-text {
  font-size: 13px;
  color: #1d2129;
  line-height: 1.5;
  cursor: zoom-in;
}

.basket-item-explain {
  margin-top: 8px;
  padding: 8px 10px;
  background: #fafbfc;
  border-radius: 6px;
}

.basket-explain-img {
  max-width: 100%;
  display: block;
}

.basket-explain-empty {
  font-size: 12px;
  color: #c9cdd4;
}

.basket-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.basket-footer-left {
  display: flex;
}

.basket-footer-right {
  display: flex;
  gap: 8px;
}

/* ── 放大预览 dialog ── */
.basket-preview-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.basket-preview-title {
  font-size: 16px;
  font-weight: 700;
  color: #1D2A2E;
}

.basket-preview-body {
  max-height: 70vh;
  overflow-y: auto;
}

.basket-preview-detail {
  margin-top: 8px;
}

.basket-preview-block {
  margin-top: 12px;
  padding: 10px 12px;
  background: #F5F8F8;
  border-left: 3px solid #1E8A8A;
  border-radius: 6px;
}

.basket-preview-label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: #1D2A2E;
  margin-bottom: 6px;
}

.basket-preview-img {
  max-width: 100%;
  height: auto;
  display: block;
  border-radius: 4px;
}

.basket-preview-empty {
  font-size: 13px;
  color: #A6B2B6;
}

.compose-btn-footer {
  background: linear-gradient(135deg, #1E8A8A, #176E6E);
  border: none;
  box-shadow: 0 2px 6px rgba(30, 138, 138, 0.3);
  transition: all 0.2s;
}

.compose-btn-footer:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(30, 138, 138, 0.45);
}

/* ── 题型 tag ── */
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
  /* DESIGN.md 青系：teal-50 底 + teal-700 字（替换原偏蓝 #e8f0ff/#3564d0） */
  background: #E6F2F2;
  color: #176E6E;
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

.type-tag--danger {
  background: #ffece8;
  color: #f56c6c;
}

.stem-placeholder {
  font-size: 12px;
  color: #c9cdd4;
}
</style>
