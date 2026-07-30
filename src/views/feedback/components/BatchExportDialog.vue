<script setup lang="ts">
/**
 * PRD-015 D13/D8 · 按计划导出反馈图弹窗（骨架照抄 desk/plans/components/ParentExportDialog.vue）。
 *
 * 单图 / 长图双模式：
 * - single（缺省）= 该计划最新一单（序号最大）单张；long = 全量按序号升序拼长图；
 * - 🔴 模式记住最后一次选择（localStorage，接口无状态）；
 * - 出口 = 下载图片 + 机器人发到我的飞书（D8：一律推老师本人，无「发送家长」）。
 *
 * 契约：POST /teacher/feedback/export-plan-png {planId, mode} → {file,url,mode,sheetCount}。
 */
import { ref, watch, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { exportPlanPng, downloadArtifact } from '@/api/teacher/feedback'

/** 计划最小形态（桌面计划页传 PlanVO，反馈列表页传筛选出的 {id,name}）。 */
interface PlanLike {
  id: string
  name?: string | null
}

const props = defineProps<{
  modelValue: boolean
  plan: PlanLike | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

/** 🔴 D13：模式记忆键（下次默认停在上次用的模式）。 */
const MODE_KEY = 'prd015.feedbackExportMode'

function loadMode(): 'single' | 'long' {
  try {
    return localStorage.getItem(MODE_KEY) === 'long' ? 'long' : 'single'
  } catch {
    return 'single'
  }
}

const mode = ref<'single' | 'long'>(loadMode())
const exporting = ref(false)
const imgUrl = ref('')
const sheetCount = ref(0)

watch(mode, (v) => {
  try {
    localStorage.setItem(MODE_KEY, v)
  } catch {
    /* 隐私模式下 localStorage 可能不可写，忽略即可（只丢记忆不影响导出） */
  }
})

function reset() {
  if (imgUrl.value) URL.revokeObjectURL(imgUrl.value)
  imgUrl.value = ''
  sheetCount.value = 0
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      reset()
      mode.value = loadMode()
    }
  },
)

async function doExport() {
  if (!props.plan?.id) {
    ElMessage.warning('请先选择课程计划')
    return
  }
  exporting.value = true
  try {
    const res = await exportPlanPng(props.plan.id, mode.value)
    const blob = await downloadArtifact(res.file)
    if (imgUrl.value) URL.revokeObjectURL(imgUrl.value)
    imgUrl.value = URL.createObjectURL(blob)
    sheetCount.value = res.sheetCount ?? 0
  } catch {
    /* 拦截器已弹错（无反馈单时 BE 返 400 带文案） */
  } finally {
    exporting.value = false
  }
}

function download() {
  if (!imgUrl.value) return
  const a = document.createElement('a')
  a.href = imgUrl.value
  a.download = `${props.plan?.name || 'feedback'}-${mode.value === 'long' ? '合集' : '最新'}.png`
  a.click()
}

/**
 * D8：机器人发到老师本人飞书。本期点击 = 同端点出图 + 提示（bot 推送归上线段接线，H5）。
 * 🔴 无「发送家长」——家长侧人工转发。
 */
async function sendToBot() {
  if (!imgUrl.value) await doExport()
  if (!imgUrl.value) return
  ElMessage.success('已生成，bot 推送上线段接线')
}
</script>

<template>
  <el-dialog v-model="visible" title="按计划导出反馈" width="680px" append-to-body>
    <div class="be-body">
      <div class="be-pick">
        <span class="be-label">计划</span>
        <b class="be-plan">{{ plan?.name || '（未选择）' }}</b>
        <el-radio-group v-model="mode" size="small">
          <el-radio-button value="single">单图</el-radio-button>
          <el-radio-button value="long">长图</el-radio-button>
        </el-radio-group>
        <el-button type="primary" :loading="exporting" :disabled="!plan?.id" @click="doExport">
          生成图片
        </el-button>
      </div>
      <p class="be-hint">
        单图 = 该计划最新一份反馈；长图 = 该计划全部反馈按序号依次拼接，一次性发出去。
      </p>

      <div v-if="exporting" class="be-loading">正在生成…</div>

      <div v-if="imgUrl" class="be-result">
        <div class="be-result-bar">
          <span class="be-ok">已生成{{ sheetCount ? `（${sheetCount} 份）` : '' }}</span>
        </div>
        <div class="be-img-wrap">
          <img :src="imgUrl" alt="反馈图" class="be-img" />
        </div>
      </div>
    </div>
    <template #footer>
      <el-button @click="visible = false">关闭</el-button>
      <el-button :disabled="!imgUrl" @click="download">下载图片</el-button>
      <el-button type="primary" :disabled="!plan?.id" @click="sendToBot">机器人发到我的飞书</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.be-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.be-pick {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.be-label {
  font-size: 13px;
  color: #5f716d;
}
.be-plan {
  font-size: 13px;
  color: #1c3330;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.be-hint {
  font-size: 12px;
  color: #8ba09a;
  margin: 0;
}
.be-loading {
  font-size: 13px;
  color: #8ba09a;
  padding: 10px 0;
}
.be-result-bar {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 8px;
}
.be-ok {
  font-size: 13px;
  font-weight: 700;
  color: #0e9285;
}
.be-img-wrap {
  max-height: 420px;
  overflow: auto;
  border: 1px solid #e2eae8;
  border-radius: 8px;
  background: #fafcfb;
  padding: 10px;
}
.be-img {
  width: 100%;
  display: block;
}
</style>
