<script setup lang="ts">
/**
 * KnowledgeAside — 左栏「考点列表」(PRD-001 T3)
 *
 * 展示工作台聚合出的考点（按命中题数 desc），支持本地关键字过滤 +
 * 多选 toggle（选中的 knowledgeId 数组通过 v-model:selected 上抛）。
 * 纯展示组件：不发请求，过滤在内存里算。
 */
import { computed, ref } from 'vue'
import { Search } from '@element-plus/icons-vue'
import type { KnowledgeGroup } from '@/composables/useBasketWorkbench'

const props = withDefaults(
  defineProps<{
    /** 考点聚合（调用方已按 count desc 排好） */
    groups: KnowledgeGroup[]
    /** 数据加载中 */
    loading?: boolean
  }>(),
  {
    loading: false,
  },
)

/** 选中的 knowledge id 多选数组 */
const selected = defineModel<string[]>('selected', { default: () => [] })

/** 本地搜索关键字（仅按 group.name 包含过滤，不发请求） */
const keyword = ref('')

/** 过滤后的考点列表 */
const filteredGroups = computed<KnowledgeGroup[]>(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw)
    return props.groups
  return props.groups.filter(g => g.name.toLowerCase().includes(kw))
})

/** 选中集合（O(1) 查询用） */
const selectedSet = computed<Set<string>>(() => new Set(selected.value))

function isSelected(id: string): boolean {
  return selectedSet.value.has(id)
}

/** toggle 选中：赋新数组触发响应 */
function toggle(id: string): void {
  if (selectedSet.value.has(id))
    selected.value = selected.value.filter(x => x !== id)
  else
    selected.value = [...selected.value, id]
}

/** 清除全部筛选 */
function clearSelected(): void {
  selected.value = []
}
</script>

<template>
  <div class="knowledge-aside">
    <!-- 顶部标题区 -->
    <div class="ka-header">
      <div class="ka-title-row">
        <span class="ka-title">考点</span>
        <el-tag size="small" type="info" effect="plain">
          共 {{ groups.length }} 考点
        </el-tag>
        <el-button
          v-if="selected.length > 0"
          class="ka-clear"
          link
          type="primary"
          size="small"
          @click="clearSelected"
        >
          清除筛选
        </el-button>
      </div>
      <el-input
        v-model="keyword"
        class="ka-search"
        :prefix-icon="Search"
        placeholder="搜索考点"
        clearable
        size="default"
      />
    </div>

    <!-- 列表区 -->
    <div class="ka-body">
      <el-skeleton v-if="loading" :rows="6" animated class="ka-skeleton" />

      <el-empty
        v-else-if="groups.length === 0"
        description="暂无考点（先在卷库加入试卷篮）"
        :image-size="80"
        class="ka-empty"
      />

      <ul v-else class="ka-list">
        <li
          v-for="g in filteredGroups"
          :key="g.id"
          class="ka-item"
          :class="{ 'is-selected': isSelected(g.id) }"
          @click="toggle(g.id)"
        >
          <span class="ka-item-name" :title="g.name">{{ g.name }}</span>
          <span class="ka-item-count">{{ g.count }}</span>
        </li>
        <li v-if="filteredGroups.length === 0" class="ka-no-match">
          无匹配考点
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.knowledge-aside {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #fff;
  border-radius: 10px;
  border: 1px solid #f2f3f5;
  overflow: hidden;
}

.ka-header {
  padding: 14px 14px 10px;
  border-bottom: 1px solid #f2f3f5;
}

.ka-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.ka-title {
  font-size: 15px;
  font-weight: 600;
  color: #1d2129;
}

.ka-clear {
  margin-left: auto;
}

.ka-search {
  width: 100%;
}

.ka-body {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}

.ka-skeleton {
  padding: 10px;
}

.ka-empty {
  padding-top: 24px;
}

.ka-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.ka-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 10px 9px 12px;
  margin-bottom: 2px;
  border-radius: 8px;
  border-left: 3px solid transparent;
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s, border-color 0.15s;
}

.ka-item:hover {
  background: #f7f8fa;
}

.ka-item.is-selected {
  background: #ecf2ff;
  border-left-color: #1E8A8A;
}

.ka-item-name {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  color: #1d2129;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ka-item.is-selected .ka-item-name {
  color: #1E8A8A;
  font-weight: 600;
}

.ka-item-count {
  flex-shrink: 0;
  min-width: 22px;
  height: 20px;
  padding: 0 6px;
  line-height: 20px;
  text-align: center;
  font-size: 12px;
  color: #86909c;
  background: #f2f3f5;
  border-radius: 10px;
}

.ka-item.is-selected .ka-item-count {
  color: #fff;
  background: #1E8A8A;
}

.ka-no-match {
  list-style: none;
  padding: 20px 0;
  text-align: center;
  font-size: 13px;
  color: #86909c;
}
</style>
