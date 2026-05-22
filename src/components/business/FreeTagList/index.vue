<script setup lang="ts">
import { computed } from 'vue'

// FreeTag 单条结构（来自 BE 段②契约 — biz_free_tag 字典化）
export interface FreeTagItem {
  id: number
  name: string
  position: number
}

// list 模式 = 题库列表卡片 — position 0 大蓝，>=1 mini 三色循环（蓝/绿/橙）
// detail 模式 = 详情/抽屉/原卷 — 全 mini，按 position 三色循环（蓝/绿/橙）
type Mode = 'list' | 'detail'

const props = withDefaults(
  defineProps<{
    tags?: FreeTagItem[] | null
    mode?: Mode
  }>(),
  { mode: 'list', tags: () => [] },
)

const CYCLE = ['', 'success', 'warning'] as const  // '' = el-tag 默认蓝；success 绿；warning 橙
type TagType = '' | 'success' | 'warning' | 'info' | 'primary' | 'danger'

// 排序保险：BE 已按 position asc，这里再兜底排一次（防接口顺序错乱）
const sortedTags = computed<FreeTagItem[]>(() => {
  const arr = Array.isArray(props.tags) ? [...props.tags] : []
  return arr.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
})

function resolveType(position: number): TagType {
  if (props.mode === 'list') {
    // list: position 0 蓝；后续 (position-1) % 3 → [蓝, 绿, 橙]
    if (position === 0) return ''
    return CYCLE[(position - 1) % 3]
  }
  // detail: 全部 position % 3 → [蓝, 绿, 橙]
  return CYCLE[position % 3]
}

function resolveSize(position: number): 'large' | 'default' | 'small' {
  if (props.mode === 'list' && position === 0) return 'default'  // medium = el-tag default
  return 'small'  // mini = el-tag small
}
</script>

<template>
  <div v-if="sortedTags.length > 0" class="free-tag-list">
    <el-tag
      v-for="tag in sortedTags"
      :key="tag.id"
      :type="resolveType(tag.position)"
      :size="resolveSize(tag.position)"
      class="free-tag-item"
    >
      {{ tag.name }}
    </el-tag>
  </div>
</template>

<style scoped>
.free-tag-list {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.free-tag-item {
  cursor: default;
  transition: filter 0.18s ease, box-shadow 0.18s ease;
}

.free-tag-item:hover {
  filter: brightness(0.94);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
}
</style>
