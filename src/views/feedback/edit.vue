<script setup lang="ts">
/**
 * PRD-004 课后反馈单编辑页（/desk/feedback/edit/:id?）。
 * 新建态（无 id）：空白起。编辑态（带 id）：加载 getSheet 还原。
 * 五列表格行编辑（所属模块/学习内容/掌握情况/不足点），行增删 + 上下移排序；
 * 顶部学生/日期/标题；「保存」入库；「导出 PNG」先保存再出家长版长图预览。
 */
import { ref, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  getSheet,
  createSheet,
  updateSheet,
  exportPng,
  downloadArtifact,
  type FeedbackRow,
} from '@/api/teacher/feedback'
import { pageTargets, type TargetCardVO } from '@/api/teacher/schedule'

const route = useRoute()
const router = useRouter()

const id = ref<string>((route.params.id as string) || '')
const isEdit = computed(() => !!id.value)

const targetId = ref<string>('')
const title = ref<string>('')
const lessonDate = ref<string>('')
const rows = ref<FeedbackRow[]>([])

const students = ref<TargetCardVO[]>([])
const saving = ref(false)
const exporting = ref(false)

// —— PNG 预览 ——
const pngVisible = ref(false)
const pngUrl = ref('')

function emptyRow(): FeedbackRow {
  return { module: '', content: '', mastery: '', weakness: '' }
}

function addRow() {
  rows.value.push(emptyRow())
}

function delRow(i: number) {
  rows.value.splice(i, 1)
}

function moveUp(i: number) {
  if (i <= 0) return
  const arr = rows.value
  ;[arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]
}

function moveDown(i: number) {
  const arr = rows.value
  if (i >= arr.length - 1) return
  ;[arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]
}

function buildBo() {
  return {
    targetId: targetId.value || null,
    title: title.value,
    lessonDate: lessonDate.value || null,
    rows: rows.value.map((r, idx) => ({
      seq: idx + 1,
      module: r.module || '',
      content: r.content || '',
      mastery: r.mastery || '',
      weakness: r.weakness || '',
      kp_id: r.kp_id ?? null,
    })),
  }
}

async function save(): Promise<boolean> {
  saving.value = true
  try {
    if (isEdit.value) {
      await updateSheet(id.value, buildBo())
    } else {
      const res = await createSheet(buildBo())
      id.value = res.id
      // 建单后地址换到编辑态，避免重复建
      router.replace(`/desk/feedback/edit/${res.id}`)
    }
    ElMessage.success('已保存')
    return true
  } catch {
    ElMessage.error('保存失败')
    return false
  } finally {
    saving.value = false
  }
}

async function onExport() {
  exporting.value = true
  try {
    const ok = await save()
    if (!ok) return
    const res = await exportPng(id.value)
    const blob = await downloadArtifact(res.file)
    if (pngUrl.value) URL.revokeObjectURL(pngUrl.value)
    pngUrl.value = URL.createObjectURL(blob)
    pngVisible.value = true
  } catch {
    ElMessage.error('导出失败')
  } finally {
    exporting.value = false
  }
}

function downloadPng() {
  const a = document.createElement('a')
  a.href = pngUrl.value
  a.download = (title.value || 'feedback') + '.png'
  a.click()
}

function goBack() {
  router.push('/desk/feedback')
}

async function loadStudents() {
  try {
    const res = await pageTargets({ targetType: '0', pageSize: 500 })
    students.value = res?.rows ?? []
  } catch {
    students.value = []
  }
}

async function loadSheet() {
  if (!id.value) {
    rows.value = [emptyRow()]
    lessonDate.value = new Date().toISOString().slice(0, 10)
    return
  }
  try {
    const d = await getSheet(id.value)
    targetId.value = d.targetId || ''
    title.value = d.title || ''
    lessonDate.value = d.lessonDate || ''
    rows.value = (d.rows && d.rows.length ? d.rows : [emptyRow()]).map((r) => ({
      module: r.module || '',
      content: r.content || '',
      mastery: r.mastery || '',
      weakness: r.weakness || '',
      kp_id: r.kp_id ?? null,
    }))
  } catch {
    ElMessage.error('加载失败')
  }
}

onMounted(async () => {
  await Promise.all([loadStudents(), loadSheet()])
})
</script>

<template>
  <div class="fb-edit">
    <div class="fb-head">
      <el-button link @click="goBack">← 返回列表</el-button>
      <h2 class="fb-title">{{ isEdit ? '编辑反馈单' : '新建反馈单' }}</h2>
      <div class="fb-sp" />
      <el-button :loading="saving" @click="save">保存</el-button>
      <el-button type="primary" :loading="exporting" @click="onExport">导出 PNG</el-button>
    </div>

    <div class="fb-meta">
      <el-select v-model="targetId" placeholder="选择学生" clearable filterable class="fb-student">
        <el-option v-for="s in students" :key="s.id" :label="s.name" :value="s.id" />
      </el-select>
      <el-date-picker
        v-model="lessonDate"
        type="date"
        placeholder="上课日期"
        value-format="YYYY-MM-DD"
        class="fb-date"
      />
      <el-input v-model="title" placeholder="标题（如：乐乐七上暑假数学第一节课上课内容）" class="fb-title-inp" />
    </div>

    <table class="fb-table">
      <thead>
        <tr>
          <th style="width: 52px">序号</th>
          <th style="width: 130px">所属模块</th>
          <th>学习内容</th>
          <th style="width: 150px">掌握情况</th>
          <th style="width: 170px">不足点</th>
          <th style="width: 108px">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(r, i) in rows" :key="i">
          <td class="c">{{ i + 1 }}</td>
          <td><input v-model="r.module" class="cell" /></td>
          <td><input v-model="r.content" class="cell" /></td>
          <td><input v-model="r.mastery" class="cell" /></td>
          <td><input v-model="r.weakness" class="cell" /></td>
          <td class="ops">
            <span class="op" title="上移" @click="moveUp(i)">↑</span>
            <span class="op" title="下移" @click="moveDown(i)">↓</span>
            <span class="op del" title="删除" @click="delRow(i)">✕</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="6" class="empty">暂无行，点下方「加一行」</td>
        </tr>
      </tbody>
    </table>

    <div class="fb-add">
      <el-button size="small" @click="addRow">＋ 加一行</el-button>
    </div>

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
.fb-edit { padding: 4px 2px; }
.fb-head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.fb-title { font-size: 18px; font-weight: 800; color: #1c3330; margin: 0; }
.fb-sp { flex: 1; }
.fb-meta { display: flex; gap: 10px; margin-bottom: 14px; }
.fb-student { width: 180px; }
.fb-date { width: 160px; }
.fb-title-inp { flex: 1; }
.fb-table { border-collapse: collapse; width: 100%; font-size: 13px; background: #fff; }
.fb-table th, .fb-table td { border: 1px solid #e2eae8; padding: 6px 8px; text-align: left; }
.fb-table th { background: #f6faf9; font-size: 12.5px; color: #4d6863; font-weight: 700; }
.fb-table td.c { text-align: center; color: #8aa09b; }
.cell { border: none; outline: none; font-size: 13px; color: #1c3330; width: 100%; background: transparent; }
.cell:focus { background: #f0f7f6; }
.ops { white-space: nowrap; text-align: center; }
.op { display: inline-block; cursor: pointer; color: #8aa09b; padding: 0 4px; font-size: 13px; }
.op:hover { color: #0e9285; }
.op.del:hover { color: #e05c4b; }
.empty { text-align: center; color: #8aa09b; padding: 16px; }
.fb-add { margin-top: 10px; }
.fb-png-preview { text-align: center; max-height: 60vh; overflow: auto; background: #f4f7f7; padding: 12px; border-radius: 8px; }
.fb-png-preview img { max-width: 100%; box-shadow: 0 2px 12px rgba(0, 0, 0, .12); border-radius: 4px; }
</style>
