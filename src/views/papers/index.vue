<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Search, Star } from '@element-plus/icons-vue'
import { useRouter } from 'vue-router'
import {
  getPaperLazyTree,
  getPaperPage,
  type PaperTreeNode,
  type PaperListItem,
} from '@/api/paper/index'

// ── 路由 ────────────────────────────────────────────────────
const router = useRouter()

// ── 教材选择（占位，不可改 — PRD §2 "其他留空按钮"）────────
const TEXTBOOK_OPTIONS = [
  { label: '浙教新版', value: 'zhejiao-new' },
]
const selectedTextbook = ref('zhejiao-new')

// ── 左侧目录树关键字筛选框（占位，输入不响应 — PRD §2 不在范围）
const treeFilterKeyword = ref('')

// ── 章节树 ──────────────────────────────────────────────────
const treeData = ref<PaperTreeNode[]>([])
const treeLoading = ref(false)
const currentSubjectId = ref<string>('')

async function loadTree() {
  treeLoading.value = true
  try {
    const result = await getPaperLazyTree()
    treeData.value = Array.isArray(result) ? result : []
  } catch (e) {
    console.warn('[paper-tree] lazyTree failed', e)
    treeData.value = []
  } finally {
    treeLoading.value = false
  }
}

function handleNodeClick(data: PaperTreeNode) {
  currentSubjectId.value = data.id
  pageParams.subjectId = data.id
  pageParams.pageIndex = 1
  fetchPapers()
}

// ── 搜索框（顶部）─────────────────────────────────────────
const searchName = ref('')
const searchLoading = ref(false)

function onSearch() {
  pageParams.name = searchName.value.trim()
  pageParams.pageIndex = 1
  fetchPapers()
}

// ── 卷列表 + 分页 ────────────────────────────────────────
const papers = ref<PaperListItem[]>([])
const listLoading = ref(false)
const total = ref(0)

const pageParams = reactive({
  name: '',
  subjectId: '',
  pageIndex: 1,
  pageSize: 10,
})

async function fetchPapers() {
  listLoading.value = true
  searchLoading.value = true
  try {
    const result = await getPaperPage({
      name: pageParams.name || '',
      subjectId: pageParams.subjectId || '',
      pageIndex: pageParams.pageIndex,
      pageSize: pageParams.pageSize,
    })
    if (result && Array.isArray(result.list)) {
      papers.value = result.list
      total.value = result.total ?? 0
    } else {
      papers.value = []
      total.value = 0
    }
  } catch (e) {
    console.warn('[paper-list] page failed', e)
    papers.value = []
    total.value = 0
  } finally {
    listLoading.value = false
    searchLoading.value = false
  }
}

function handlePageChange(p: number) {
  pageParams.pageIndex = p
  fetchPapers()
}

function handleSizeChange(s: number) {
  pageParams.pageSize = s
  pageParams.pageIndex = 1
  fetchPapers()
}

// ── 业务动作 ──────────────────────────────────────────────
function handleView(item: PaperListItem) {
  router.push(`/papers/source/${item.id}`)
}

function handleNotOpen() {
  ElMessage.info('暂未开放')
}

// ── 生命周期 ──────────────────────────────────────────────
onMounted(() => {
  loadTree()
  fetchPapers()
})
</script>

<template>
  <div class="papers-page">
    <!-- 左侧目录区 -->
    <aside class="paper-sidebar">
      <div class="sidebar-title">卷库目录</div>
      <!-- 教材选择（占位不可改）-->
      <el-select
        v-model="selectedTextbook"
        class="sidebar-select"
        size="default"
        @change="handleNotOpen"
      >
        <el-option
          v-for="opt in TEXTBOOK_OPTIONS"
          :key="opt.value"
          :label="opt.label"
          :value="opt.value"
        />
      </el-select>
      <!-- 关键字筛选（占位，无响应）-->
      <el-input
        v-model="treeFilterKeyword"
        class="sidebar-filter"
        placeholder="输入关键字筛选"
        size="default"
        clearable
        @change="handleNotOpen"
      />
      <!-- 树 -->
      <div v-loading="treeLoading" class="tree-wrap">
        <el-tree
          :data="treeData"
          node-key="id"
          :props="{ children: 'children', label: 'title' }"
          highlight-current
          :expand-on-click-node="false"
          @node-click="handleNodeClick"
        />
      </div>
    </aside>

    <!-- 中间主区 -->
    <section class="paper-main">
      <!-- 顶部搜索条 -->
      <div class="search-bar">
        <el-input
          v-model="searchName"
          placeholder="输入试卷名字"
          class="search-input"
          clearable
          @keyup.enter="onSearch"
        />
        <el-button type="primary" :loading="searchLoading" class="search-btn" @click="onSearch">
          <el-icon><Search /></el-icon>
          <span>查询</span>
        </el-button>
      </div>

      <!-- 卷列表 -->
      <div v-loading="listLoading" class="paper-list">
        <div
          v-for="item in papers"
          :key="item.id"
          class="paper-card"
        >
          <div class="paper-card-row1">
            <div class="paper-card-title-area">
              <el-icon class="paper-star" @click="handleNotOpen"><Star /></el-icon>
              <span class="paper-name" @click="handleView(item)">{{ item.name }}</span>
            </div>
            <div class="paper-card-actions">
              <el-link type="primary" :underline="false" @click="handleView(item)">查看</el-link>
              <el-link type="primary" :underline="false" @click="handleNotOpen">加入试卷篮</el-link>
            </div>
          </div>
          <div class="paper-card-row2">
            <div class="paper-field"><span class="paper-field-label">总分</span><span class="paper-field-colon">:</span><span class="paper-field-value">{{ item.score }}</span></div>
            <div class="paper-field"><span class="paper-field-label">时长</span><span class="paper-field-colon">:</span><span class="paper-field-value">{{ item.suggestTime ?? '' }} 分钟</span></div>
            <div class="paper-field"><span class="paper-field-label">题目数</span><span class="paper-field-colon">:</span><span class="paper-field-value">{{ item.questionCount }}</span></div>
            <div class="paper-field"><span class="paper-field-label">创建时间</span><span class="paper-field-colon">:</span><span class="paper-field-value">{{ item.createTime }}</span></div>
          </div>
        </div>
        <el-empty v-if="!listLoading && papers.length === 0" description="暂无试卷" />
      </div>

      <!-- 分页器 -->
      <div class="pagination-wrap">
        <el-pagination
          background
          layout="total, sizes, prev, pager, next, jumper"
          :total="total"
          :current-page="pageParams.pageIndex"
          :page-size="pageParams.pageSize"
          :page-sizes="[10, 20, 50]"
          @current-change="handlePageChange"
          @size-change="handleSizeChange"
        />
      </div>
    </section>

    <!-- 全局试题栏 FAB 已挂 AppLayout（E 段③' 决策）— 卷库页面不再独立挂浮按钮 -->
    <!-- "试卷篮"卡片内 el-link 保留 handleNotOpen 行为（F 卡范围，本卡不动）-->
  </div>
</template>

<style scoped>
.papers-page {
  display: flex;
  min-height: calc(100vh - 60px);
  background: #f0f2f5;
  position: relative;
}

/* ── 左侧目录 ─────────────────────────────── */
.paper-sidebar {
  width: 300px;
  flex-shrink: 0;
  background: #ffffff;
  padding: 16px 12px;
  border-right: 1px solid #ebeef5;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sidebar-title {
  font-size: 14px;
  font-weight: 600;
  color: #303133;
  padding: 0 4px;
  margin-bottom: 4px;
}

.sidebar-select {
  width: 100%;
}

.sidebar-filter {
  width: 100%;
}

.tree-wrap {
  flex: 1;
  overflow-y: auto;
  padding-top: 4px;
}

:deep(.el-tree-node__content) {
  height: 32px;
  font-size: 13px;
}

:deep(.el-tree-node.is-current > .el-tree-node__content) {
  background-color: #ecf5ff;
  color: #409eff;
}

/* ── 中间主区 ─────────────────────────────── */
.paper-main {
  flex: 1;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.search-bar {
  display: flex;
  gap: 10px;
  align-items: center;
}

.search-input {
  width: 260px;
}

.search-btn {
  padding: 0 18px;
}

/* ── 卷列表 ───────────────────────────────── */
.paper-list {
  flex: 1;
  background: #ffffff;
  border-radius: 4px;
  min-height: 200px;
}

.paper-card {
  padding: 16px 20px;
  border-bottom: 1px solid #ebeef5;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: #ffffff;
  transition: background 0.15s ease;
}

.paper-card:last-child {
  border-bottom: none;
}

.paper-card:hover {
  background: #fafcff;
}

.paper-card-row1 {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.paper-card-title-area {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.paper-star {
  font-size: 16px;
  color: #c0c4cc;
  cursor: pointer;
  transition: color 0.15s ease;
}

.paper-star:hover {
  color: #409eff;
}

.paper-name {
  font-size: 14px;
  font-weight: 600;
  color: #409eff;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.paper-name:hover {
  text-decoration: underline;
}

.paper-card-actions {
  display: flex;
  gap: 16px;
  flex-shrink: 0;
}

.paper-card-row2 {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  color: #606266;
  font-size: 13px;
}

.paper-field {
  display: flex;
  align-items: center;
}

.paper-field-label {
  color: #909399;
}

.paper-field-colon {
  margin-right: 8px;
  margin-left: 0;
  color: #909399;
}

.paper-field-value {
  color: #303133;
}

/* ── 分页器 ───────────────────────────────── */
.pagination-wrap {
  display: flex;
  justify-content: flex-start;
  padding: 12px 0;
  background: #ffffff;
  border-radius: 4px;
  padding-left: 20px;
}

/* 右侧浮动按钮已删 — 全局 <QuestionBasket /> 挂 AppLayout 接管 */
</style>
