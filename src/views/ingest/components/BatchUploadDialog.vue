<script setup lang="ts">
/**
 * BatchUploadDialog — PRD-A-002 路B「批量上传录题」提交弹层
 *
 * 流程：选一张试卷图 + 绑章节（必选）+ 处理选项 → 「开始拆题」组 FormData
 *   调 createIngestJob 拿 jobId → 关弹层 + 提示「右下角进度球可查看」+ emit('submitted')
 *   通知 IngestFab 立即刷新（球本身也轮询，800ms 内会轮到，emit 只是即时性优化）。
 *
 * 文件目前仅支持图片（jpg/png/webp）；PDF/Word 后续接入（提示文案已留口）。
 */
import { ref, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { UploadFilled } from '@element-plus/icons-vue'
import type { UploadFile, UploadRawFile } from 'element-plus'
import { lazyTree, type SubjectNode } from '@/api/question/index'
import {
  createIngestJob,
  type IngestAnswerMode,
  type IngestCommitMode,
} from '@/api/ingest/index'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'submitted'): void
}>()

const dialogVisible = computed({
  get: () => props.visible,
  set: (v: boolean) => emit('update:visible', v),
})

// ── 文件（手动管理，不自动上传） ────────────────────────────────
const rawFile = ref<UploadRawFile | null>(null)
const fileName = ref('')

function onFileChange(file: UploadFile) {
  if (file.raw) {
    rawFile.value = file.raw
    fileName.value = file.name
  }
}

function onFileRemove() {
  rawFile.value = null
  fileName.value = ''
}

function beforeUpload() {
  // 始终拦截真正上传（auto-upload=false 已不会触发，这里双保险）
  return false
}

// ── 绑定章节（el-tree-select，必选） ────────────────────────────
const treeData = ref<SubjectNode[]>([])
const treeLoading = ref(false)
const selectedSubjectId = ref<string>('')

async function loadTree() {
  if (treeData.value.length > 0) return
  treeLoading.value = true
  try {
    const result = await lazyTree(0, true)
    if (Array.isArray(result)) treeData.value = result
    else if (result && typeof result === 'object') treeData.value = [result as unknown as SubjectNode]
  } catch (e) {
    console.warn('[batch-upload][tree] lazyTree failed', e)
  } finally {
    treeLoading.value = false
  }
}

// ── 处理选项 ────────────────────────────────────────────────
const answerMode = ref<IngestAnswerMode>('from_source')
const commitMode = ref<IngestCommitMode>('review')

// ── 提交 ────────────────────────────────────────────────────
const submitting = ref(false)

const canSubmit = computed(
  () => !!rawFile.value && !!selectedSubjectId.value && !submitting.value,
)

async function handleSubmit() {
  if (!rawFile.value) {
    ElMessage.warning('请先选择一张试卷图片')
    return
  }
  if (!selectedSubjectId.value) {
    ElMessage.warning('请绑定章节（必选）')
    return
  }
  submitting.value = true
  try {
    const form = new FormData()
    form.append('file', rawFile.value)
    form.append('subjectId', selectedSubjectId.value)
    form.append('answerMode', answerMode.value)
    form.append('commitMode', commitMode.value)

    await createIngestJob(form)
    ElMessage.success('已提交，拆题中，右下角进度球可查看')
    dialogVisible.value = false
    emit('submitted')
    // 通知全局 IngestFab 即时刷新（FAB 与本弹层不同父，走 window 事件）
    window.dispatchEvent(new CustomEvent('ingest:job-submitted'))
    resetForm()
  } catch (e) {
    console.warn('[batch-upload] createIngestJob failed', e)
    // 错误 toast 已由 http 拦截器统一弹，这里不重复
  } finally {
    submitting.value = false
  }
}

function resetForm() {
  rawFile.value = null
  fileName.value = ''
  selectedSubjectId.value = ''
  answerMode.value = 'from_source'
  commitMode.value = 'review'
}

// 打开弹层时懒加载章节树
watch(
  () => props.visible,
  (open) => {
    if (open) loadTree()
  },
)
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    title="批量上传录题"
    width="560px"
    style="max-width: 92vw"
    :close-on-click-modal="false"
    class="batch-upload-dialog"
  >
    <div class="batch-body">
      <!-- 上传区（B2：整页走 TextIn OCR，已支持 图片 / PDF / Word docx） -->
      <el-upload
        drag
        :auto-upload="false"
        accept="image/*,.pdf,.docx"
        :limit="1"
        :on-change="onFileChange"
        :on-remove="onFileRemove"
        :before-upload="beforeUpload"
        class="batch-upload"
      >
        <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
        <div class="el-upload__text">
          将试卷文件拖到此处，或<em>点击选择</em>
        </div>
        <template #tip>
          <div class="el-upload__tip">
            支持 图片（jpg / png / webp）、PDF、Word（docx）
          </div>
        </template>
      </el-upload>

      <!-- 绑定章节 -->
      <div class="form-row">
        <label class="form-label">绑定章节<span class="required">*</span></label>
        <el-tree-select
          v-model="selectedSubjectId"
          :data="treeData"
          :props="{ label: 'title', children: 'children' }"
          node-key="id"
          placeholder="请选择章节（必选）"
          check-strictly
          :render-after-expand="false"
          :loading="treeLoading"
          class="full-width"
        />
      </div>

      <!-- 答案解析 -->
      <div class="form-row">
        <label class="form-label">答案解析</label>
        <el-radio-group v-model="answerMode">
          <el-radio value="from_source">原卷自带</el-radio>
          <el-radio value="ai_solve">AI 解题</el-radio>
          <el-radio value="stem_only">只录题</el-radio>
        </el-radio-group>
      </div>

      <!-- 入库方式 -->
      <div class="form-row">
        <label class="form-label">入库方式</label>
        <el-radio-group v-model="commitMode">
          <el-radio value="review">审核后入库</el-radio>
          <el-radio value="direct">直接入库</el-radio>
        </el-radio-group>
      </div>
    </div>

    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button
        type="primary"
        :loading="submitting"
        :disabled="!canSubmit"
        @click="handleSubmit"
      >
        开始拆题
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.batch-body {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.batch-upload {
  width: 100%;
}

.batch-upload :deep(.el-upload),
.batch-upload :deep(.el-upload-dragger) {
  width: 100%;
}

.form-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.form-label {
  font-size: 13px;
  font-weight: 600;
  color: #1d2129;
}

.required {
  color: #f56c6c;
  margin-left: 2px;
}

.full-width {
  width: 100%;
}
</style>
