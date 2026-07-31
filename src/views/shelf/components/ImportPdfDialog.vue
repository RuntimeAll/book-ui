<script setup lang="ts">
/**
 * ImportPdfDialog — PDF 直录「待解析书」。
 *
 * 手上有一本 PDF（教辅扫描件/电子书）先原样入架占位：上传 PDF → BE 建 bookType=pdf_pending 的书，
 * 渲首页做封面 + 记页数。后续再走录题/拆书管线把它解析成有结构的书。
 *
 * 前端只做三件事：选 PDF（校验后缀 + ≤100MB）、书名（默认取文件名去后缀）、年级（选填）。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { UploadFilled } from '@element-plus/icons-vue'
import type { UploadFile, UploadRawFile } from 'element-plus'
import { importBookPdf, type BookImportPdfResult } from '@/api/shelf'
import { useDictStore, DICT_EDU_GRADE } from '@/store/dict'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  /** 导入成功：书架页据此刷新列表 */
  (e: 'imported', book: BookImportPdfResult): void
}>()

const dialogVisible = computed({
  get: () => props.visible,
  set: (v: boolean) => emit('update:visible', v),
})

const dict = useDictStore()
/** 年级下拉复用页面同源字典（biz_edu_grade），value 取中文名直接写 grade 文本列 */
const gradeOptions = computed(() => dict.list(DICT_EDU_GRADE))

const MAX_MB = 100

const rawFile = ref<UploadRawFile | null>(null)
const fileName = ref('')
const title = ref('')
const grade = ref('')
const submitting = ref(false)

/** 文件名去后缀 = 默认书名（用户可改；已手动改过就不覆盖） */
function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '').trim()
}

function validFile(file: File): boolean {
  if (!/\.pdf$/i.test(file.name)) {
    ElMessage.warning('只支持 PDF 文件')
    return false
  }
  if (file.size > MAX_MB * 1024 * 1024) {
    ElMessage.warning(`文件超过 ${MAX_MB}MB，请先压缩或拆分`)
    return false
  }
  return true
}

function onFileChange(file: UploadFile) {
  if (!file.raw) return
  if (!validFile(file.raw)) {
    // 校验不过不留残影：清掉刚选的文件
    rawFile.value = null
    fileName.value = ''
    return
  }
  const prevDefault = fileName.value ? stripExt(fileName.value) : ''
  rawFile.value = file.raw
  fileName.value = file.name
  // 书名为空 or 还是上一个文件的默认值 → 跟着新文件走；用户手改过则保留
  if (!title.value.trim() || title.value.trim() === prevDefault) {
    title.value = stripExt(file.name)
  }
}

function onFileRemove() {
  rawFile.value = null
  fileName.value = ''
}

/** auto-upload=false 已不会触发真上传，这里双保险拦一道 */
function beforeUpload() {
  return false
}

function reset() {
  rawFile.value = null
  fileName.value = ''
  title.value = ''
  grade.value = ''
}

async function onSubmit() {
  if (!rawFile.value) {
    ElMessage.warning('请先选择 PDF 文件')
    return
  }
  const t = title.value.trim()
  if (!t) {
    ElMessage.warning('请填写书名')
    return
  }
  submitting.value = true
  try {
    const res = await importBookPdf({
      file: rawFile.value,
      title: t,
      grade: grade.value || undefined,
    })
    ElMessage.success(`已导入「${res?.title || t}」${res?.pdfPages ? `（${res.pdfPages} 页）` : ''}`)
    emit('imported', res)
    dialogVisible.value = false
    reset()
  } catch (e) {
    console.warn('[shelf][import-pdf] 导入失败:', e)
    // 错误 toast 由 http 拦截器统一弹，这里不重复
  } finally {
    submitting.value = false
  }
}

watch(
  () => props.visible,
  (open) => {
    if (open) void dict.load(DICT_EDU_GRADE)
  },
)
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    title="导入 PDF"
    width="520px"
    style="max-width: 92vw"
    :close-on-click-modal="false"
  >
    <div class="ip-body">
      <el-upload
        drag
        :auto-upload="false"
        accept=".pdf,application/pdf"
        :limit="1"
        :on-change="onFileChange"
        :on-remove="onFileRemove"
        :before-upload="beforeUpload"
        class="ip-upload"
      >
        <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
        <div class="el-upload__text">将 PDF 拖到此处，或<em>点击选择</em></div>
        <template #tip>
          <div class="el-upload__tip">仅支持 PDF，单个文件不超过 {{ MAX_MB }}MB</div>
        </template>
      </el-upload>

      <el-form label-width="56px" class="ip-form">
        <el-form-item label="书名">
          <el-input v-model="title" placeholder="默认取文件名" maxlength="80" clearable />
        </el-form-item>
        <el-form-item label="年级">
          <el-select v-model="grade" placeholder="选填" clearable class="ip-grade">
            <el-option
              v-for="g in gradeOptions"
              :key="g.dictValue"
              :label="g.dictLabel"
              :value="g.dictLabel"
            />
          </el-select>
        </el-form-item>
      </el-form>

      <p class="ip-note">导入后先以「待解析」入架（可在线看 PDF、挂网盘链接），后续再走管线解析成有结构的书。</p>
    </div>

    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="submitting" :disabled="!rawFile" @click="onSubmit">
        导入
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.ip-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.ip-upload {
  width: 100%;
}
.ip-upload :deep(.el-upload),
.ip-upload :deep(.el-upload-dragger) {
  width: 100%;
}
.ip-form {
  margin-top: 4px;
}
.ip-grade {
  width: 100%;
}
.ip-note {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.6;
  margin: 0;
}
</style>
