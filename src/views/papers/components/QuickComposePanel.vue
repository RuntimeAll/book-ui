<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElLoading, ElMessage, ElMessageBox } from 'element-plus'
import type { PaperSourceQuestion } from '@/api/question/index'
import { createExamPaper } from '@/api/paper/index'

const props = defineProps<{
  questions: PaperSourceQuestion[]
}>()

const router = useRouter()

// 选中题目的 id 集合
const selectedIds = ref<number[]>([])

const isEmpty = computed<boolean>(() => props.questions.length === 0)

function isSelected(id: number): boolean {
  return selectedIds.value.includes(id)
}

function toggle(id: number): void {
  const idx = selectedIds.value.indexOf(id)
  if (idx === -1) {
    selectedIds.value.push(id)
  } else {
    selectedIds.value.splice(idx, 1)
  }
}

function selectAll(): void {
  selectedIds.value = props.questions.map(q => q.id)
}

function clearAll(): void {
  selectedIds.value = []
}

// yyyy-mm-dd（运行时取当天日期）
function todayStr(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

async function handleCompose(): Promise<void> {
  if (selectedIds.value.length === 0) {
    ElMessage.warning('请先选择至少 1 道题')
    return
  }

  let name: string
  try {
    const res = await ElMessageBox.prompt('请输入试卷名称', '生成试卷', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      inputValue: `快速组卷-${todayStr()}`,
      inputValidator: (val: string): boolean | string => {
        const v = (val ?? '').trim()
        if (!v) return '试卷名称不能为空'
        if (v.length > 80) return '试卷名称不能超过 80 字'
        return true
      },
    })
    name = (res.value ?? '').trim()
  } catch {
    // 用户取消
    return
  }

  const ids = [...selectedIds.value]
  const loading = ElLoading.service({
    lock: true,
    text: '正在生成试卷…',
  })
  try {
    const res = await createExamPaper({ name, questionIds: ids })
    loading.close()
    ElMessage.success(`组卷成功，共 ${res.questionCount} 题`)
    router.push(`/papers/source/${res.paperId}`)
  } catch {
    loading.close()
    ElMessageBox.alert('生成试卷失败，请稍后重试。', '提示', {
      confirmButtonText: '我知道了',
      type: 'error',
    })
    // 失败不清空选择
  }
}
</script>

<template>
  <div class="quick-compose-panel">
    <template v-if="isEmpty">
      <el-empty description="先在左/中栏准备题目" :image-size="100" />
      <div class="qc-footer">
        <el-button
          class="compose-submit-btn"
          type="primary"
          disabled
        >
          生成试卷
        </el-button>
      </div>
    </template>

    <template v-else>
      <!-- 顶部统计 + 操作 -->
      <div class="qc-header">
        <span class="qc-count">
          已选 {{ selectedIds.length }} / {{ questions.length }} 题
        </span>
        <div class="qc-actions">
          <el-button size="small" text @click="selectAll">全选</el-button>
          <el-button size="small" text @click="clearAll">清空</el-button>
        </div>
      </div>

      <!-- 题号网格 -->
      <div class="qc-grid">
        <button
          v-for="(q, i) in questions"
          :key="q.id"
          type="button"
          class="qc-cell"
          :class="{ 'qc-cell--active': isSelected(q.id) }"
          @click="toggle(q.id)"
        >
          {{ i + 1 }}
        </button>
      </div>

      <!-- 底部统计 + 主按钮 -->
      <div class="qc-footer">
        <span class="qc-count qc-count--bottom">
          已选 {{ selectedIds.length }} / {{ questions.length }} 题
        </span>
        <el-button
          class="compose-submit-btn"
          type="primary"
          @click="handleCompose"
        >
          生成试卷
        </el-button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.quick-compose-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 16px;
  background: #fff;
  border-radius: 10px;
  box-sizing: border-box;
}

.qc-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.qc-count {
  font-size: 14px;
  color: #1d2129;
  font-weight: 500;
}

.qc-count--bottom {
  color: #86909c;
  font-weight: 400;
}

.qc-actions {
  display: flex;
  gap: 4px;
}

.qc-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  flex: 1 1 auto;
  align-content: flex-start;
  overflow-y: auto;
  padding: 4px 0;
}

.qc-cell {
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  color: #4e5969;
  background: #f7f8fa;
  border: 1px solid #f2f3f5;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
  user-select: none;
}

.qc-cell:hover {
  border-color: #4080ff;
  color: #4080ff;
}

.qc-cell--active {
  background: #4080ff;
  border-color: #4080ff;
  color: #fff;
}

.qc-cell--active:hover {
  color: #fff;
}

.qc-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #f2f3f5;
}

.qc-footer .compose-submit-btn {
  margin-left: auto;
}
</style>
