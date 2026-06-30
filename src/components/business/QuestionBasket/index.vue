<script setup lang="ts">
/**
 * QuestionBasket — 试题栏全局浮动按钮 + dialog 容器
 *
 * 设计：基于 useQuestionBasket composable（module-scoped singleton），
 * 在 AppLayout 全局挂载一次，任意页面调 add/remove 实时联动 FAB 角标 + dialog 列表。
 *
 * 抽离自第十二波前的 src/views/question/index.vue（模板行 766-892 / style 1265-1410）。
 */
import { ref, reactive, nextTick, watch, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import Sortable from 'sortablejs'
import { ShoppingCart, Delete, DocumentAdd, Close, ZoomIn, Rank } from '@element-plus/icons-vue'
import { useQuestionBasket } from '@/composables/useQuestionBasket'
import { getQuestionDetail, type QuestionItem } from '@/api/question/index'
import { useDictStore, DICT_QUESTION_TYPE } from '@/store/dict'
// 放大预览复用题库/组卷工作台共享题卡组件（actions=[] 关掉操作按钮，纯展示题干大图 + meta），不另造预览渲染。
import QuestionCard from '@/components/business/QuestionCard/index.vue'
import QuestionContent from '@/components/business/QuestionContent/index.vue'

const basket = useQuestionBasket()
const router = useRouter()
const composing = ref(false)

// Q 卡段③ — "去组卷"改为跳工作台路由（原 composeAndDownload 走 /papers/edit 老逻辑作废）。
// 工作台读 basket.items.value，无需 paperDraft LS 中转。
async function handleGoCompose() {
  if (basket.count.value === 0) {
    ElMessage.warning('试题栏为空，请先加题')
    return
  }
  composing.value = true
  try {
    basket.closeDialog()
    await router.push('/question/compose')
  } finally {
    composing.value = false
  }
}

function handleClearBasket() {
  basket.clear()
}

// PRD-A-013 T2 — id 雪花 string
function handleRemoveBasket(id: string) {
  basket.remove(id)
}

// ── PRD-A-017 批2e：试题栏可拖拽重排（复用 ArtifactPanel 的 sortablejs 范式）──
//   手柄 .drag-handle 拖动 .basket-item；drop 后按新 DOM 顺序读各项 data-item-id → 调
//   basket.reorder 回写顺序（落 LS，不只动 DOM）。dialog 关闭时列表 DOM 销毁 → 重开再 init。
const listEl = ref<HTMLElement | null>(null)
let sortable: Sortable | null = null

function onBasketDrop() {
  const root = listEl.value
  if (!root) return
  const orderedIds: string[] = []
  root.querySelectorAll<HTMLElement>('[data-item-id]').forEach((el) => {
    const id = el.dataset.itemId
    if (id) orderedIds.push(id)
  })
  basket.reorder(orderedIds)
}

function initBasketSortable() {
  if (sortable || !listEl.value) return
  sortable = Sortable.create(listEl.value, {
    handle: '.drag-handle',
    animation: 160,
    ghostClass: 'basket-item-ghost',
    chosenClass: 'basket-item-chosen',
    draggable: '.basket-item',
    onEnd: onBasketDrop,
  })
}

// dialog 开 → 等列表渲染后 init；关 → 销毁（重开重建，避免持有已卸载节点）
watch(
  () => basket.dialogVisible.value,
  (open) => {
    if (open) {
      void nextTick(() => initBasketSortable())
    } else {
      sortable?.destroy()
      sortable = null
    }
  },
)

onBeforeUnmount(() => {
  sortable?.destroy()
  sortable = null
})

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

// ── 展开解析（用户 2026-06-04 拍板实现）：toggle 显示该题解析；item 自带 explainImg/explain 优先，
//    无则懒加载 getQuestionDetail 补取（试题栏 item 来自列表，可能不含解析）──
// PRD-A-013 T2 — key 雪花 string
// 兼容富文本：img = 解析图 URL（misikt 老题），text = 解析文本（AI 入库题）
const explainState = reactive<Record<string, { open: boolean; img: string; text: string; loading: boolean }>>({})

async function toggleExplain(item: QuestionItem) {
  const id = item.id
  if (!explainState[id]) explainState[id] = { open: false, img: '', text: '', loading: false }
  const st = explainState[id]
  st.open = !st.open
  if (st.open && !st.img && !st.text && !st.loading) {
    const own = (item as { explainImg?: string }).explainImg
    const ownText = (item as { explain?: string }).explain
    if (ownText) { st.text = ownText; return }
    if (own) { st.img = own; return }
    st.loading = true
    try {
      const res = await getQuestionDetail(id)
      const d = res as { explainImg?: string; explain?: string }
      st.text = d?.explain ?? ''
      st.img = d?.explainImg ?? ''
    } catch (e) {
      console.warn('[basket] load explain failed', e)
      st.img = ''
      st.text = ''
    } finally {
      st.loading = false
    }
  }
}

// ── 放大预览（压缩题卡后的兼容入口）：点题卡/放大按钮打开 el-dialog，
//    复用 QuestionCard 渲染完整题干大图 + meta；答案/解析（图/文）懒加载 getQuestionDetail 补取。──
const previewVisible = ref(false)
const previewItem = ref<QuestionItem | null>(null)
const previewDetail = reactive<{
  answerImg: string; answerText: string
  explainImg: string; explainText: string
  loading: boolean
}>({
  answerImg: '', answerText: '',
  explainImg: '', explainText: '',
  loading: false,
})

async function openPreview(item: QuestionItem) {
  previewItem.value = item
  previewDetail.answerImg = (item as { answerImg?: string }).answerImg ?? ''
  previewDetail.answerText = (item as { answer?: string }).answer ?? ''
  previewDetail.explainImg = (item as { explainImg?: string }).explainImg ?? ''
  previewDetail.explainText = (item as { explain?: string }).explain ?? ''
  previewVisible.value = true
  // 列表来的 item 可能不含答案/解析（图/文）→ 懒加载详情补取
  const needLoad = !previewDetail.answerImg && !previewDetail.answerText
    || !previewDetail.explainImg && !previewDetail.explainText
  if (needLoad) {
    previewDetail.loading = true
    try {
      const res = await getQuestionDetail(item.id)
      const d = res as { answerImg?: string; answer?: string; explainImg?: string; explain?: string }
      if (!previewDetail.answerImg) previewDetail.answerImg = d?.answerImg ?? ''
      if (!previewDetail.answerText) previewDetail.answerText = d?.answer ?? ''
      if (!previewDetail.explainImg) previewDetail.explainImg = d?.explainImg ?? ''
      if (!previewDetail.explainText) previewDetail.explainText = d?.explain ?? ''
    } catch (e) {
      console.warn('[basket] load preview detail failed', e)
    } finally {
      previewDetail.loading = false
    }
  }
}
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
          <el-tag type="primary" size="small" round>{{ basket.items.value.length }} 题</el-tag>
        </div>
      </div>
    </template>

    <div class="basket-dialog-body">
      <el-empty
        v-if="basket.items.value.length === 0"
        description="试题栏为空，请先在题库中加题"
      >
        <template #image>
          <el-icon style="font-size: 48px; color: #c9cdd4;"><ShoppingCart /></el-icon>
        </template>
      </el-empty>
      <el-scrollbar max-height="380px">
        <div ref="listEl" class="basket-list">
        <div
          v-for="item in basket.items.value"
          :key="item.id"
          class="basket-item"
          :data-item-id="item.id"
        >
          <div class="basket-item-header">
            <!-- 拖手柄：按住可拖动重排（仅本手柄触发拖拽，不影响项内按钮） -->
            <span
              v-if="basket.items.value.length > 1"
              class="drag-handle"
              title="拖动调整顺序"
              aria-label="拖动调整顺序"
            >
              <el-icon><Rank /></el-icon>
            </span>
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
                {{ explainState[item.id]?.open ? '收起解析' : '解析' }}
              </el-button>
              <el-button
                size="small"
                link
                type="danger"
                @click="handleRemoveBasket(item.id)"
              >
                <el-icon><Close /></el-icon>移除
              </el-button>
            </div>
          </div>
          <!-- 题干（点击放大）— 富文本/图片/占位统一走 QuestionContent -->
          <div class="basket-item-stem" style="cursor: zoom-in;" @click="openPreview(item)">
            <QuestionContent
              :text="item.stemText"
              :img-url="item.stemImg"
              alt="题干（点击放大）"
              img-max-height="112px"
            />
          </div>
          <!-- 展开解析区（懒加载，富文本/图片统一走 QuestionContent）-->
          <div v-if="explainState[item.id]?.open" class="basket-item-explain">
            <el-skeleton v-if="explainState[item.id]?.loading" :rows="2" animated />
            <template v-else>
              <QuestionContent
                v-if="explainState[item.id]?.img || explainState[item.id]?.text"
                :text="explainState[item.id]?.text || null"
                :img-url="explainState[item.id]?.img || null"
                alt="解析"
              />
              <span v-else class="basket-explain-empty">暂无解析</span>
            </template>
          </div>
        </div>
        </div>
      </el-scrollbar>
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
            组卷（{{ basket.items.value.length }} 题）
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
            v-if="previewDetail.answerImg || previewDetail.answerText"
            class="basket-preview-block"
          >
            <span class="basket-preview-label">【答案】</span>
            <QuestionContent
              :text="previewDetail.answerText || null"
              :img-url="previewDetail.answerImg || null"
              alt="答案"
            />
          </div>
          <div
            v-if="previewDetail.explainImg || previewDetail.explainText"
            class="basket-preview-block"
          >
            <span class="basket-preview-label">【解析】</span>
            <QuestionContent
              :text="previewDetail.explainText || null"
              :img-url="previewDetail.explainImg || null"
              alt="解析"
            />
          </div>
          <span
            v-if="!previewDetail.answerImg && !previewDetail.answerText && !previewDetail.explainImg && !previewDetail.explainText"
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
