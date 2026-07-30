<script setup lang="ts">
/**
 * PRD-004 课后反馈单列表页（/desk/feedback）。
 * 单表 CRUD 最小版：列表 = 标题/学生/日期/更新时间 + 操作（编辑/导出 PNG/删除）。
 * 「新建反馈单」→ 编辑页（/desk/feedback/edit）。导出 PNG → 预览弹窗（家长直发）。
 *
 * PRD-015 批4：筛选栏加学生/计划下拉（BE page 支持 targetId/planId），表格加计划/序号列，
 * 工具栏「按计划导出」→ BatchExportDialog（单图/长图，D13）。
 */
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  pageSheets,
  deleteSheet,
  exportPng,
  downloadArtifact,
  type FeedbackSheetBrief,
} from '@/api/teacher/feedback'
import { pageTargets, pagePlans, type TargetCardVO, type PlanVO } from '@/api/teacher/schedule'
import BatchExportDialog from './components/BatchExportDialog.vue'

const router = useRouter()

const rows = ref<FeedbackSheetBrief[]>([])
const loading = ref(false)
const keyword = ref('')

// —— 筛选（学生 / 计划）——
const filterTargetId = ref('')
const filterPlanId = ref('')
const students = ref<TargetCardVO[]>([])
const plans = ref<PlanVO[]>([])
const plansLoading = ref(false)

/** 计划名映射（表格「计划」列显示用；未在候选里的旧计划回退显示 —） */
const planNameMap = computed(() => {
  const m = new Map<string, string>()
  for (const p of plans.value) m.set(String(p.id), p.name)
  return m
})

const selectedPlan = computed(() => {
  const p = plans.value.find((x) => String(x.id) === String(filterPlanId.value))
  return p ? { id: p.id, name: p.name } : null
})

// —— 按计划导出弹窗 ——
const exportVisible = ref(false)

function openPlanExport() {
  if (!filterPlanId.value) {
    ElMessage.warning('请先在上方选中一个课程计划')
    return
  }
  exportVisible.value = true
}

async function loadStudents() {
  try {
    const res = await pageTargets({ targetType: '0', pageSize: 500 })
    students.value = res?.rows ?? []
  } catch {
    students.value = []
  }
}

async function loadPlans() {
  plansLoading.value = true
  try {
    const res = await pagePlans({
      targetType: '0',
      targetId: filterTargetId.value || undefined,
      pageSize: 200,
    })
    plans.value = res?.rows ?? []
  } catch {
    plans.value = []
  } finally {
    plansLoading.value = false
  }
}

/** 换学生 = 计划候选重拉 + 清计划筛选（跨学生的计划选中无意义） */
async function onFilterStudentChange() {
  filterPlanId.value = ''
  await loadPlans()
  await load()
}

// —— PNG 预览弹窗 ——
const pngVisible = ref(false)
const pngUrl = ref('')
const pngName = ref('')
const pngLoading = ref(false)

async function load() {
  loading.value = true
  try {
    const res = await pageSheets({
      keyword: keyword.value || undefined,
      targetId: filterTargetId.value || undefined,
      planId: filterPlanId.value || undefined,
    })
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

onMounted(async () => {
  await Promise.all([loadStudents(), loadPlans()])
  await load()
})
</script>

<template>
  <div class="fb-list">
    <div class="fb-bar">
      <h2 class="fb-title">课后反馈单</h2>
      <el-select
        v-model="filterTargetId"
        placeholder="全部学生"
        clearable
        filterable
        class="fb-filter"
        @change="onFilterStudentChange"
      >
        <el-option v-for="s in students" :key="s.id" :label="s.name" :value="s.id" />
      </el-select>
      <el-select
        v-model="filterPlanId"
        :loading="plansLoading"
        placeholder="全部计划"
        clearable
        filterable
        class="fb-filter wide"
        @change="load"
      >
        <el-option v-for="p in plans" :key="p.id" :label="p.name" :value="p.id" />
      </el-select>
      <el-input
        v-model="keyword"
        placeholder="搜标题"
        clearable
        class="fb-search"
        @keyup.enter="load"
        @clear="load"
      />
      <el-button @click="load">查询</el-button>
      <el-button @click="openPlanExport">按计划导出</el-button>
      <el-button type="primary" @click="goCreate">＋ 新建反馈单</el-button>
    </div>

    <el-table v-loading="loading" :data="rows" empty-text="暂无反馈单，点右上角新建" border>
      <el-table-column label="标题" min-width="240">
        <template #default="{ row }">
          <a class="fb-link" @click="goEdit(row.id)">{{ row.title || '未命名反馈单' }}</a>
        </template>
      </el-table-column>
      <el-table-column label="学生" width="110">
        <template #default="{ row }">{{ row.targetName || '—' }}</template>
      </el-table-column>
      <el-table-column label="计划" min-width="150">
        <template #default="{ row }">
          {{ row.planId ? planNameMap.get(String(row.planId)) || '（其他计划）' : '—' }}
        </template>
      </el-table-column>
      <el-table-column label="序号" width="70" align="center">
        <template #default="{ row }">{{ row.lessonSeq ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="上课日期" width="120">
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

    <!-- PRD-015 D13：按计划导出（单图/长图，记住上次选择） -->
    <BatchExportDialog v-model="exportVisible" :plan="selectedPlan" />
  </div>
</template>

<style scoped>
.fb-list { padding: 4px 2px; }
.fb-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.fb-title { font-size: 18px; font-weight: 800; color: #1c3330; margin: 0; }
.fb-filter { width: 140px; margin-left: auto; }
.fb-filter.wide { width: 190px; margin-left: 0; }
.fb-search { width: 170px; }
.fb-link { color: #0e9285; cursor: pointer; font-weight: 600; }
.fb-link:hover { text-decoration: underline; }
.fb-png-preview { text-align: center; max-height: 60vh; overflow: auto; background: #f4f7f7; padding: 12px; border-radius: 8px; }
.fb-png-preview img { max-width: 100%; box-shadow: 0 2px 12px rgba(0, 0, 0, .12); border-radius: 4px; }
</style>
