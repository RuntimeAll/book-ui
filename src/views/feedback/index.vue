<script setup lang="ts">
/**
 * PRD-004 课后反馈单列表页（/desk/feedback）。
 * 单表 CRUD 最小版：列表 = 标题/学生/日期/更新时间 + 操作（编辑/导出 PNG/删除）。
 * 「新建反馈单」→ 编辑页（/desk/feedback/edit）。导出 PNG → 预览弹窗（家长直发）。
 */
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  pageSheets,
  deleteSheet,
  exportPng,
  downloadArtifact,
  type FeedbackSheetBrief,
} from '@/api/teacher/feedback'

const router = useRouter()

const rows = ref<FeedbackSheetBrief[]>([])
const loading = ref(false)
const keyword = ref('')

// —— PNG 预览弹窗 ——
const pngVisible = ref(false)
const pngUrl = ref('')
const pngName = ref('')
const pngLoading = ref(false)

async function load() {
  loading.value = true
  try {
    const res = await pageSheets({ keyword: keyword.value || undefined })
    rows.value = res?.rows ?? []
  } catch {
    rows.value = []
  } finally {
    loading.value = false
  }
}

function goCreate() {
  router.push('/desk/feedback/edit')
}

function goEdit(id: string) {
  router.push(`/desk/feedback/edit/${id}`)
}

async function onDelete(row: FeedbackSheetBrief) {
  try {
    await ElMessageBox.confirm(`确认删除反馈单「${row.title || '未命名'}」？`, '删除确认', {
      type: 'warning',
    })
  } catch {
    return
  }
  await deleteSheet(row.id)
  ElMessage.success('已删除')
  load()
}

async function onExport(row: FeedbackSheetBrief) {
  pngLoading.value = true
  try {
    const res = await exportPng(row.id)
    const blob = await downloadArtifact(res.file)
    if (pngUrl.value) URL.revokeObjectURL(pngUrl.value)
    pngUrl.value = URL.createObjectURL(blob)
    pngName.value = (row.title || 'feedback') + '.png'
    pngVisible.value = true
  } catch {
    ElMessage.error('导出失败')
  } finally {
    pngLoading.value = false
  }
}

function downloadPng() {
  const a = document.createElement('a')
  a.href = pngUrl.value
  a.download = pngName.value
  a.click()
}

onMounted(load)
</script>

<template>
  <div class="fb-list">
    <div class="fb-bar">
      <h2 class="fb-title">课后反馈单</h2>
      <el-input
        v-model="keyword"
        placeholder="搜标题"
        clearable
        class="fb-search"
        @keyup.enter="load"
        @clear="load"
      />
      <el-button @click="load">查询</el-button>
      <el-button type="primary" @click="goCreate">＋ 新建反馈单</el-button>
    </div>

    <el-table v-loading="loading" :data="rows" empty-text="暂无反馈单，点右上角新建" border>
      <el-table-column label="标题" min-width="240">
        <template #default="{ row }">
          <a class="fb-link" @click="goEdit(row.id)">{{ row.title || '未命名反馈单' }}</a>
        </template>
      </el-table-column>
      <el-table-column label="学生" width="130">
        <template #default="{ row }">{{ row.targetName || '—' }}</template>
      </el-table-column>
      <el-table-column label="上课日期" width="130">
        <template #default="{ row }">{{ row.lessonDate || '—' }}</template>
      </el-table-column>
      <el-table-column label="更新时间" width="180">
        <template #default="{ row }">{{ row.updateTime || row.createTime || '—' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="230" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="goEdit(row.id)">编辑</el-button>
          <el-button link type="success" :loading="pngLoading" @click="onExport(row)">导出 PNG</el-button>
          <el-button link type="danger" @click="onDelete(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="pngVisible" title="家长版预览（可直接发微信）" width="680px">
      <div class="fb-png-preview">
        <img v-if="pngUrl" :src="pngUrl" alt="反馈单 PNG" />
      </div>
      <template #footer>
        <el-button @click="pngVisible = false">关闭</el-button>
        <el-button type="primary" @click="downloadPng">下载 PNG</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.fb-list { padding: 4px 2px; }
.fb-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.fb-title { font-size: 18px; font-weight: 800; color: #1c3330; margin: 0; }
.fb-search { width: 200px; margin-left: auto; }
.fb-link { color: #0e9285; cursor: pointer; font-weight: 600; }
.fb-link:hover { text-decoration: underline; }
.fb-png-preview { text-align: center; max-height: 60vh; overflow: auto; background: #f4f7f7; padding: 12px; border-radius: 8px; }
.fb-png-preview img { max-width: 100%; box-shadow: 0 2px 12px rgba(0, 0, 0, .12); border-radius: 4px; }
</style>
