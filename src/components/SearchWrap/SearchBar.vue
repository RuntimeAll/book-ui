<script setup lang="ts">
/**
 * Search — 筛选条包裹器
 * 统一 gap + label 风格 + 搜索/重置按钮固定右侧
 * 参考 vue-element-plus-admin Search 组件设计语言
 */
import { Search } from '@element-plus/icons-vue'

interface Props {
  loading?: boolean
  showReset?: boolean
}

withDefaults(defineProps<Props>(), {
  loading: false,
  showReset: true,
})

const emit = defineEmits<{
  search: []
  reset: []
}>()
</script>

<template>
  <div class="search-wrap">
    <!-- 筛选项 slot -->
    <div class="search-items">
      <slot />
    </div>

    <!-- 操作按钮区（固定右侧）-->
    <div class="search-actions">
      <slot name="actions">
        <el-button
          type="primary"
          :loading="loading"
          class="search-btn"
          @click="emit('search')"
        >
          <el-icon v-if="!loading"><Search /></el-icon>
          查询
        </el-button>
        <el-button v-if="showReset" class="reset-btn" @click="emit('reset')">
          <el-icon><Refresh /></el-icon>
          重置
        </el-button>
      </slot>
    </div>
  </div>
</template>

<style scoped>
.search-wrap {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  background: #ffffff;
  border-radius: 8px;
  padding: 14px 16px;
  border: 1px solid #f2f3f5;
  box-shadow: 0 2px 8px 0 rgba(30, 138, 138, 0.04);
  margin-bottom: 12px;
}

.search-items {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  flex: 1;
}

.search-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.search-btn {
  background: linear-gradient(135deg, #1E8A8A, #176E6E);
  border: none;
  box-shadow: 0 2px 6px rgba(30, 138, 138, 0.3);
  transition: all 0.2s;
}

.search-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(30, 138, 138, 0.4);
}

.reset-btn {
  color: #4e5969;
  border-color: #e5e6eb;
  transition: all 0.2s;
}

.reset-btn:hover {
  color: #1E8A8A;
  border-color: #1E8A8A;
}
</style>
