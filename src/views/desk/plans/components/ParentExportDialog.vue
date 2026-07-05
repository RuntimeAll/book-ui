<script setup lang="ts">
/**
 * PRD-C-213 FP22 — 家长版课表导出弹窗。
 * 选对象（该计划关联对象，按 planId + 同 targetType 从对象墙拉，可手选）→ parentExport(planId,targetId)
 * → 返回 {file,url} 图片直显 + 下载链接。BE 未起时优雅提示，按钮可点。
 * 契约：批0 §三 POST plan/{id}/parent-export?targetId= → {file,url}（900px 两列长图）。
 */
import { ref, watch, computed } from 'vue'
import { ElMessage } from 'element-plus'
import {
  pageTargets,
  parentExport,
  artifactUrl,
  TARGET_TYPE_LABEL,
  type PlanVO,
  type TargetCardVO,
} from '@/api/teacher/schedule'

const props = defineProps<{
  modelValue: boolean
  plan: PlanVO | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

const targets = ref<TargetCardVO[]>([])
const loadingTargets = ref(false)
const selectedTargetId = ref<string>('')
const exporting = ref(false)
const resultUrl = ref<string>('')
const resultFile = ref<string>('')
const loadError = ref(false)

const targetTypeLabel = computed(() =>
  props.plan ? TARGET_TYPE_LABEL[props.plan.targetType] : '对象',
)

async function loadTargets() {
  if (!props.plan) return
  loadingTargets.value = true
  loadError.value = false
  try {
    // 按计划对象类型过滤候选（计划与对象通过 session.plan_id 关联，此处放开手选）
    const res = await pageTargets({ targetType: props.plan.targetType, pageSize: 200 })
    targets.value = res?.rows ?? []
    // 优先预选绑定了本计划的对象
    const bound = targets.value.find((t) => t.planId && String(t.planId) === String(props.plan?.id))
    selectedTargetId.value = bound?.id ?? targets.value[0]?.id ?? ''
  } catch {
    targets.value = []
    loadError.value = true
  } finally {
    loadingTargets.value = false
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    resultUrl.value = ''
    resultFile.value = ''
    selectedTargetId.value = ''
    loadTargets()
  },
)

// 下载 URL：优先服务端临时 url，回退用 artifact 流下载助手
const downloadHref = computed(() => resultUrl.value || (resultFile.value ? artifactUrl(resultFile.value) : ''))

async function doExport() {
  if (!props.plan) return
  if (!selectedTargetId.value) {
    ElMessage.warning('请先选择一个对象')
    return
  }
  exporting.value = true
  resultUrl.value = ''
  resultFile.value = ''
  try {
    const res = await parentExport(props.plan.id, selectedTargetId.value)
    resultFile.value = res?.file ?? ''
    resultUrl.value = res?.url ?? ''
    if (!resultUrl.value && !resultFile.value) {
      ElMessage.warning('导出成功但未返回图片地址')
    }
  } catch {
    // 拦截器已弹错误（BE 未起 = 网络错误提示）
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <el-dialog v-model="visible" title="家长版课表" width="640px" append-to-body>
    <div class="pe-body">
      <div class="pe-pick">
        <span class="pe-label">选择对象（{{ targetTypeLabel }}）</span>
        <el-select
          v-model="selectedTargetId"
          :loading="loadingTargets"
          placeholder="选择对象"
          filterable
          style="width: 260px"
        >
          <el-option v-for="t in targets" :key="t.id" :label="t.name" :value="t.id" />
        </el-select>
        <el-button type="primary" :loading="exporting" :disabled="!selectedTargetId" @click="doExport">
          生成家长版长图
        </el-button>
      </div>

      <el-alert
        v-if="loadError"
        type="warning"
        :closable="false"
        title="对象列表加载失败，服务可能未就绪；可稍后重试"
        show-icon
        class="pe-alert"
      />
      <el-empty v-else-if="!loadingTargets && targets.length === 0" description="暂无可导出的对象" :image-size="70" />

      <div v-if="exporting" class="pe-loading">正在生成家长版长图…</div>

      <div v-if="downloadHref" class="pe-result">
        <div class="pe-result-bar">
          <span class="pe-ok">长图已生成</span>
          <a :href="downloadHref" target="_blank" rel="noopener" download class="pe-dl">下载图片</a>
        </div>
        <div class="pe-img-wrap">
          <img :src="downloadHref" alt="家长版课表" class="pe-img" />
        </div>
      </div>
    </div>
    <template #footer>
      <el-button @click="visible = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.pe-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.pe-pick {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.pe-label {
  font-size: 13px;
  color: #5f716d;
}
.pe-alert {
  margin-top: 4px;
}
.pe-loading {
  font-size: 13px;
  color: #8ba09a;
  padding: 10px 0;
}
.pe-result-bar {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 10px;
}
.pe-ok {
  font-size: 13px;
  font-weight: 700;
  color: var(--bk-teal-deep);
}
.pe-dl {
  font-size: 13px;
  color: var(--bk-teal);
  text-decoration: none;
}
.pe-dl:hover {
  text-decoration: underline;
}
.pe-img-wrap {
  max-height: 420px;
  overflow: auto;
  border: 1px solid var(--bk-line);
  border-radius: 8px;
  background: #fafcfb;
  padding: 10px;
}
.pe-img {
  width: 100%;
  display: block;
}
</style>
