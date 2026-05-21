<script setup lang="ts">
/**
 * SearchWrap — 筛选条包裹器
 * 对齐 vue-element-plus-admin 模板 Search 组件接口（kailong321200875）
 * 采用 slot-based 实现（模板原版依赖完整 Form schema 体系，本项目按需简化）
 *
 * 接口对齐：
 *   - showSearch / showReset（对应模板 showSearch / showReset）
 *   - searchLoading / resetLoading（对应模板 searchLoading / resetLoading）
 *   - layout: 'inline' | 'bottom'（对应模板 layout）
 *   - emit: 'search' | 'reset'（对齐模板 emit）
 *
 * slots:
 *   default — 筛选项（el-select / el-input 等）
 *   action  — 可选：自定义操作按钮区（不传则用内置查询/重置）
 *
 * defineOptions({ name: 'SearchWrap' }) 避免与 Element Plus Search 图标冲突
 */
import { useDesign } from '@/hooks/web/useDesign'
import { Search } from '@element-plus/icons-vue'

defineOptions({ name: 'SearchWrap' })

const { getPrefixCls } = useDesign()
const prefixCls = getPrefixCls('search')

interface Props {
  showSearch?: boolean
  showReset?: boolean
  searchLoading?: boolean
  resetLoading?: boolean
  layout?: 'inline' | 'bottom'
}

withDefaults(defineProps<Props>(), {
  showSearch: true,
  showReset: true,
  searchLoading: false,
  resetLoading: false,
  layout: 'inline'
})

const emit = defineEmits<{
  search: []
  reset: []
}>()
</script>

<template>
  <div :class="[prefixCls]">
    <!-- 筛选项 slot -->
    <div :class="`${prefixCls}__items`">
      <slot />
    </div>

    <!-- 操作按钮区 -->
    <div :class="`${prefixCls}__actions`">
      <slot name="action">
        <el-button
          v-if="showSearch"
          type="primary"
          :loading="searchLoading"
          @click="emit('search')"
        >
          <el-icon v-if="!searchLoading"><Search /></el-icon>
          查询
        </el-button>
        <el-button
          v-if="showReset"
          :loading="resetLoading"
          @click="emit('reset')"
        >
          <el-icon><Refresh /></el-icon>
          重置
        </el-button>
      </slot>
    </div>
  </div>
</template>

<style scoped>
.v-search {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  background: #ffffff;
  border-radius: 8px;
  padding: 14px 16px;
  border: 1px solid var(--el-border-color-lighter, #f2f3f5);
  box-shadow: 0 2px 8px 0 rgba(64, 128, 255, 0.04);
  margin-bottom: 12px;
}

.v-search__items {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  flex: 1;
}

.v-search__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
</style>
