<script setup lang="ts">
/**
 * PRD-A-014 T2 — 导出配置弹窗
 *
 * 功能：
 *   1. 文件名 input（默认=传入卷名，可改）
 *   2. 卷型 radio 三档（学生卷 / 教师卷含答案解析 / 学生卷+答案页附后）
 *   3. 水印 switch（默认开，文案带老师名+脱敏手机号预览）
 *   4. 赛跑逻辑：提交 → 1s 间隔轮询 ≤10 次
 *      - status='2' → <a download> 触发下载 + 成功 toast + 关弹窗
 *      - 10s 未完  → 关弹窗 + ElNotification（含预计时间 + 去向指引）
 *      - status='3' → 错误提示含 errorMsg
 */
import { ref, computed, onMounted, watch } from 'vue'
import { ElMessage, ElNotification } from 'element-plus'
import { useUserStore } from '@/store/user'
import { getCurrentUser } from '@/api/user'
import {
  submitExport,
  getExportRecord,
  type ExportVariant,
  type ExportRecordVO,
} from '@/api/export'

// ── Props / Emits ─────────────────────────────────────────────────────────────

const props = defineProps<{
  visible: boolean
  /** 卷名（用于文件名默认值） */
  paperName: string
  /** 卷 ID（可选，整卷导出时传） */
  paperId?: string
  /** 当前预览题目 ID 顺序（来自预览） */
  ids: string[]
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
}>()

// ── Store / 用户信息 ──────────────────────────────────────────────────────────

const userStore = useUserStore()

// 🔴 onMounted 兜底：userInfo 是内存态，F5 刷新后会丢（A-002 老坑）
onMounted(async () => {
  if (!userStore.userInfo) {
    try {
      const user = await getCurrentUser()
      userStore.setUserInfo(user)
    } catch (e) {
      console.warn('[ExportConfigDialog] getCurrentUser failed', e)
    }
  }
})

/** 手机号脱敏 138****1234 */
function maskPhone(phone?: string): string {
  if (!phone || phone.length < 7) return phone ?? ''
  return phone.slice(0, 3) + '****' + phone.slice(-4)
}

/** 水印预览文案 */
const watermarkPreview = computed(() => {
  const info = userStore.userInfo
  const name = info?.realName || info?.userName || '教师姓名'
  const phone = maskPhone(info?.phone) || '手机号'
  return `${name}  ${phone}`
})

// ── 表单状态 ──────────────────────────────────────────────────────────────────

const fileName = ref('')
const variant = ref<ExportVariant>('student')
const watermark = ref(true)

// 弹窗打开时重置表单
function resetForm() {
  fileName.value = (props.paperName || '').trim() || '未命名草稿'
  variant.value = 'student'
  watermark.value = true
}

// 监听 visible 变为 true 时重置
watch(
  () => props.visible,
  (vis) => {
    if (vis) resetForm()
  },
)

// ── 赛跑状态 ─────────────────────────────────────────────────────────────────

const submitting = ref(false)
const polling = ref(false)
const pollCount = ref(0)
const MAX_POLL = 10       // 最多 10 次 = 10 秒
const POLL_INTERVAL = 1000 // 1 秒

let pollTimer: ReturnType<typeof setTimeout> | null = null

function clearPoll() {
  if (pollTimer !== null) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
  polling.value = false
  pollCount.value = 0
}

/** 触发浏览器下载 */
function triggerDownload(fileUrl: string, name: string) {
  const a = document.createElement('a')
  a.href = fileUrl
  a.download = name.endsWith('.pdf') ? name : `${name}.pdf`
  a.target = '_blank'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

/** 把 estimatedSeconds 换算成人话 */
function humanizeSeconds(secs: number): string {
  if (secs <= 0) return '稍后'
  if (secs < 60) return `约 ${secs} 秒`
  const min = Math.round(secs / 60)
  return `约 ${min} 分钟`
}

/** 轮询单条记录，直到 done/failed/超次数 */
async function pollRecord(recordId: string, estimatedSeconds: number) {
  polling.value = true
  pollCount.value = 0

  const doOnePoll = async () => {
    if (!polling.value) return // 被外部终止（弹窗关闭）

    pollCount.value++
    let record: ExportRecordVO | null = null
    try {
      record = await getExportRecord(recordId)
    } catch (e) {
      // 请求失败：继续轮询（网络抖动），但不超总次数
      console.warn('[ExportConfigDialog] poll failed', e)
    }

    if (record?.status === '2') {
      // 完成 → 下载 + toast + 关弹窗
      clearPoll()
      triggerDownload(record.fileUrl!, fileName.value)
      ElMessage.success(`PDF 已生成：${fileName.value}.pdf`)
      emit('update:visible', false)
      return
    }

    if (record?.status === '3') {
      // 失败
      clearPoll()
      submitting.value = false
      ElMessage.error(`导出失败：${record.errorMsg || '未知错误'}`)
      return
    }

    // 仍在排队/生成中
    if (pollCount.value >= MAX_POLL) {
      // 10s 超时 → 转后台通知
      clearPoll()
      submitting.value = false
      emit('update:visible', false)

      const etaText = humanizeSeconds(estimatedSeconds)
      ElNotification({
        title: `《${props.paperName || '试卷'}》正在后台生成`,
        message: `预计 ${etaText}，完成后请前往 我的工作台→导出记录 下载。`,
        type: 'info',
        duration: 0, // 不自动消失，让用户手动关
        onClick: () => {
          // 点通知跳 /workspace（T3 实现导出记录页签）
          import('@/router').then(({ default: router }) => {
            router.push('/workspace')
          })
        },
      })
      return
    }

    // 继续下一次轮询
    pollTimer = setTimeout(doOnePoll, POLL_INTERVAL)
  }

  // 第一次延迟 1s 再开始（刚提交立刻查大概率还在排队，节省一次）
  pollTimer = setTimeout(doOnePoll, POLL_INTERVAL)
}

// ── 提交 ─────────────────────────────────────────────────────────────────────

async function handleSubmit() {
  if (submitting.value) return

  const name = fileName.value.trim()
  if (!name) {
    ElMessage.warning('请填写文件名')
    return
  }
  if (props.ids.length === 0) {
    ElMessage.warning('当前试卷无题目，无法导出')
    return
  }

  submitting.value = true
  try {
    const resp = await submitExport({
      paperId: props.paperId,
      ids: props.ids,
      fileName: name,
      variant: variant.value,
      watermark: watermark.value,
    })

    // 开始赛跑轮询
    await pollRecord(resp.recordId, resp.estimatedSeconds)
  } catch (e) {
    // submitExport 失败（含 BE 返的业务错误，如单用户并发 1 限制）
    // request.ts 拦截器已 ElMessage.error，此处不重复弹
    console.error('[ExportConfigDialog] submitExport failed', e)
    submitting.value = false
  }
}

// 关弹窗时中止轮询（用户主动关弹窗）
function handleClose() {
  clearPoll()
  submitting.value = false
  emit('update:visible', false)
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    title="导出配置"
    width="480px"
    :close-on-click-modal="false"
    :close-on-press-escape="!submitting"
    :show-close="!submitting"
    class="export-config-dialog"
    @update:model-value="handleClose"
  >
    <div class="ecd-body">
      <!-- 文件名 -->
      <div class="ecd-field">
        <label class="ecd-label">文件名</label>
        <el-input
          v-model="fileName"
          placeholder="请输入文件名"
          maxlength="100"
          show-word-limit
          clearable
          :disabled="submitting"
        />
      </div>

      <!-- 卷型 -->
      <div class="ecd-field">
        <label class="ecd-label">卷型</label>
        <el-radio-group v-model="variant" :disabled="submitting" class="ecd-radio-group">
          <el-radio value="student" class="ecd-radio">
            <div class="ecd-radio-content">
              <span class="ecd-radio-title">学生卷</span>
              <span class="ecd-radio-desc">仅题干，不含答案解析</span>
            </div>
          </el-radio>
          <el-radio value="teacher" class="ecd-radio">
            <div class="ecd-radio-content">
              <span class="ecd-radio-title">教师卷</span>
              <span class="ecd-radio-desc">题干 + 答案 + 解析（备课批改用）</span>
            </div>
          </el-radio>
          <el-radio value="student_answers_appended" class="ecd-radio">
            <div class="ecd-radio-content">
              <span class="ecd-radio-title">学生卷 + 答案附后</span>
              <span class="ecd-radio-desc">题干在前，答案页独立附后</span>
            </div>
          </el-radio>
        </el-radio-group>
      </div>

      <!-- 水印 -->
      <div class="ecd-field ecd-field--watermark">
        <div class="ecd-watermark-row">
          <label class="ecd-label">水印</label>
          <el-switch v-model="watermark" :disabled="submitting" />
        </div>
        <div v-if="watermark" class="ecd-watermark-preview">
          <span class="ecd-watermark-text">{{ watermarkPreview }}</span>
          <span class="ecd-watermark-hint">（半透明斜排平铺，防盗用）</span>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="ecd-footer">
        <el-button :disabled="submitting" @click="handleClose">取消</el-button>
        <el-button
          type="primary"
          :loading="submitting"
          class="ecd-submit-btn"
          @click="handleSubmit"
        >
          {{ submitting ? (polling ? '生成中…' : '提交中…') : '开始导出' }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.ecd-body {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 4px 0;
}

.ecd-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ecd-label {
  font-size: 14px;
  font-weight: 500;
  color: #1d2129;
}

/* 卷型 radio 垂直排列 */
.ecd-radio-group {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.ecd-radio {
  height: auto;
  padding: 10px 12px;
  border: 1px solid #e5e6eb;
  border-radius: 6px;
  margin-bottom: 8px;
  align-items: flex-start;
  transition: border-color 0.2s;
}

.ecd-radio:last-child {
  margin-bottom: 0;
}

.ecd-radio:deep(.el-radio__label) {
  padding-left: 8px;
  white-space: normal;
}

.ecd-radio-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ecd-radio-title {
  font-size: 14px;
  color: #1d2129;
  font-weight: 500;
  line-height: 1.5;
}

.ecd-radio-desc {
  font-size: 12px;
  color: #86909c;
  line-height: 1.5;
}

/* 选中态高亮边框 */
.ecd-radio:deep(.el-radio__input.is-checked) + .ecd-radio-content {
  color: #1E8A8A;
}

/* 水印区 */
.ecd-field--watermark .ecd-watermark-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.ecd-watermark-preview {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #f5f8f8;
  border-radius: 6px;
  border: 1px dashed #1E8A8A;
}

.ecd-watermark-text {
  font-size: 13px;
  color: rgba(30, 138, 138, 0.7);
  font-style: italic;
  transform: rotate(-10deg);
  display: inline-block;
}

.ecd-watermark-hint {
  font-size: 12px;
  color: #86909c;
}

/* 页脚按钮 */
.ecd-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

.ecd-submit-btn {
  background-color: #1E8A8A;
  border-color: #1E8A8A;
  min-width: 100px;
}

.ecd-submit-btn:hover:not(:disabled) {
  background-color: #177373;
  border-color: #177373;
}
</style>
