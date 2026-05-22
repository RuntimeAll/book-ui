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
import { ElMessage } from 'element-plus'
import { ShoppingCart, Delete, DocumentAdd, Close } from '@element-plus/icons-vue'
import { useQuestionBasket } from '@/composables/useQuestionBasket'

const basket = useQuestionBasket()
const composing = ref(false)

async function handleGoCompose() {
  composing.value = true
  try {
    await basket.composeAndDownload()
  } finally {
    composing.value = false
  }
}

function handleClearBasket() {
  basket.clear()
}

function handleRemoveBasket(id: number) {
  basket.remove(id)
}

function getQuestionTypeLabel(type: number): string {
  const map: Record<number, string> = { 1: '选择题', 4: '填空题', 5: '简答题' }
  return map[type] ?? `题型${type}`
}

function getQuestionTypeTag(type: number): 'success' | 'warning' | 'info' | 'primary' | 'danger' {
  const map: Record<number, 'primary' | 'success' | 'warning'> = { 1: 'primary', 4: 'success', 5: 'warning' }
  return map[type] ?? 'info'
}
</script>

<template>
  <!-- ── FAB 试题栏浮动按钮 ── -->
  <div
    class="basket-fab"
    :class="{ 'has-items': basket.count.value > 0 }"
    @click="basket.openDialog()"
  >
    <el-badge
      :value="basket.count.value > 99 ? '99+' : basket.count.value"
      :hidden="basket.count.value === 0"
      type="danger"
    >
      <div class="fab-inner">
        <el-icon :size="20" color="#fff"><ShoppingCart /></el-icon>
        <span class="fab-label">试题栏</span>
      </div>
    </el-badge>
  </div>

  <!-- ── 试题栏 dialog ── -->
  <el-dialog
    v-model="basket.dialogVisible.value"
    width="75%"
    :close-on-click-modal="false"
    class="basket-dialog"
  >
    <template #header>
      <div class="basket-dialog-header">
        <div class="basket-dialog-title-area">
          <el-icon color="#4080ff" :size="18"><ShoppingCart /></el-icon>
          <span class="basket-dialog-title">试题栏</span>
          <el-tag type="primary" size="small" round>{{ basket.items.value.length }} 题</el-tag>
        </div>
        <div class="basket-dialog-actions">
          <el-button size="small" @click="handleClearBasket">
            <el-icon><Delete /></el-icon>清空
          </el-button>
          <el-button
            type="primary"
            size="small"
            :loading="composing"
            :disabled="basket.items.value.length === 0"
            class="compose-btn"
            @click="handleGoCompose"
          >
            <el-icon><DocumentAdd /></el-icon>
            组卷
          </el-button>
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
      <el-scrollbar max-height="460px">
        <div
          v-for="item in basket.items.value"
          :key="item.id"
          class="basket-item"
        >
          <div class="basket-item-header">
            <span class="type-tag" :class="`type-tag--${getQuestionTypeTag(item.questionType)}`">
              {{ getQuestionTypeLabel(item.questionType) }}
            </span>
            <el-rate
              :model-value="item.difficult ?? 0"
              :max="4"
              disabled
              style="display:inline-flex; margin-left:8px;"
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
                @click="ElMessage.info('展开解析功能开发中')"
              >
                展开解析
              </el-button>
              <el-button
                size="small"
                type="danger"
                plain
                @click="handleRemoveBasket(item.id)"
              >
                <el-icon><Close /></el-icon>取消
              </el-button>
            </div>
          </div>
          <div class="basket-item-stem">
            <img
              v-if="item.stemImg"
              :src="item.stemImg"
              class="stem-img-small"
              loading="lazy"
              alt="题干"
              @error="(e: Event) => ((e.target as HTMLImageElement).style.display='none')"
            />
            <span v-else-if="item.stemText" class="basket-stem-text">{{ item.stemText }}</span>
            <span v-else class="stem-placeholder">题 ID: {{ item.id }}</span>
          </div>
        </div>
      </el-scrollbar>
    </div>

    <template #footer>
      <div class="basket-footer">
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
    </template>
  </el-dialog>
</template>

<style scoped>
/* ── FAB 浮动按钮 ── */
.basket-fab {
  position: fixed;
  bottom: 40px;
  right: 40px;
  z-index: 200;
  cursor: pointer;
}

.fab-inner {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: linear-gradient(135deg, #4080ff, #3370e8);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  box-shadow: 0 8px 24px rgba(64, 128, 255, 0.4);
  transition: all 0.25s ease;
}

.basket-fab:hover .fab-inner {
  transform: translateY(-3px);
  box-shadow: 0 12px 32px rgba(64, 128, 255, 0.5);
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
  0%, 100% { box-shadow: 0 8px 24px rgba(64, 128, 255, 0.4); }
  50% { box-shadow: 0 8px 30px rgba(64, 128, 255, 0.6); }
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

.basket-dialog-actions {
  display: flex;
  gap: 8px;
}

.compose-btn {
  background: linear-gradient(135deg, #4080ff, #3370e8);
  border: none;
  box-shadow: 0 2px 6px rgba(64, 128, 255, 0.3);
}

.basket-dialog-body {
  min-height: 100px;
  padding: 0 4px;
}

.basket-item {
  padding: 14px 0;
  border-bottom: 1px solid #f2f3f5;
}

.basket-item:last-child {
  border-bottom: none;
}

.basket-item-header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.basket-knowledge-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.basket-item-ops {
  margin-left: auto;
  display: flex;
  gap: 6px;
}

.basket-item-stem {
  font-size: 13px;
  color: #303133;
  padding-left: 2px;
}

.stem-img-small {
  max-width: 100%;
  max-height: 120px;
  display: block;
  border-radius: 4px;
}

.basket-stem-text {
  font-size: 13px;
  color: #1d2129;
  line-height: 1.5;
}

.basket-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.compose-btn-footer {
  background: linear-gradient(135deg, #4080ff, #3370e8);
  border: none;
  box-shadow: 0 2px 6px rgba(64, 128, 255, 0.3);
  transition: all 0.2s;
}

.compose-btn-footer:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(64, 128, 255, 0.45);
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

.type-tag--danger {
  background: #ffece8;
  color: #f56c6c;
}

.stem-placeholder {
  font-size: 12px;
  color: #c9cdd4;
}
</style>
