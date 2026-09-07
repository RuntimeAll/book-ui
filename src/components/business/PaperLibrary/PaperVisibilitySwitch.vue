<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { setPaperVisibility } from '@/api/paper'

const props = defineProps<{ paperId: string; name: string; published: boolean }>()
const emit = defineEmits<{ updated: [published: boolean] }>()
const loading = ref(false)

async function beforeChange(): Promise<boolean> {
  if (loading.value) return false
  const published = !props.published
  loading.value = true
  try {
    try {
      await ElMessageBox.confirm(
        published ? `公开试卷「${props.name}」后，所有用户均可查看。` : `取消公开试卷「${props.name}」后，其他用户将无法查看。`,
        published ? '公开试卷' : '取消公开',
        { type: 'warning', confirmButtonText: '确认', cancelButtonText: '取消' },
      )
    } catch { return false }
    await setPaperVisibility(props.paperId, published)
    ElMessage.success(published ? '试卷已公开' : '试卷已取消公开')
    return true
  } catch {
    // The shared HTTP client displays the server error; keep the confirmed state unchanged.
    return false
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <el-switch
    class="visibility-switch"
    :model-value="published"
    :loading="loading"
    :before-change="beforeChange"
    :aria-label="`${name}的公开状态`"
    inline-prompt
    active-text="已公开"
    inactive-text="未公开"
    :width="68"
    @update:model-value="emit('updated', Boolean($event))"
  />
</template>

<style scoped>
.visibility-switch { --el-switch-off-color: #68747b; }
</style>
