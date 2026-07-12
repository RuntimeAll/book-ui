<script setup lang="ts">
/**
 * SpecialExportDialog — 专项双卷导出对话框（PRD-003 P5 / D3）。
 *
 * 题目卷（学生用·带答题留空）/ 答案卷（老师用·红字答案框）各自勾选；含解析、难度星标开关。
 * 🔴 星标默认关（学生卷面纪律——卷面无任何内部词）；含解析默认关。
 * 调 BE `POST /teacher/special/{id}/export`（HTML 主题→无头 Chrome→双 PDF→OSS），
 * 导出即对专项内 item used_count+1（BE 侧）。成功后展示双卷下载链接。
 *
 * 单例挂 AppLayout，经 useSpecialExportStore.open(id,title) 唤起。
 */
import { ref, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { storeToRefs } from 'pinia'
import { useSpecialExportStore } from '@/store/specialExport'
import { exportSpecial, type SpecialExportResult } from '@/api/special'

const store = useSpecialExportStore()
const { visible, specialId, title } = storeToRefs(store)

const withQuestion = ref(true)
const withAnswer = ref(true)
const withAnalysis = ref(false)
const withStars = ref(false)

const exporting = ref(false)
const result = ref<SpecialExportResult | null>(null)

const canExport = computed(() => withQuestion.value || withAnswer.value)
const paperCount = computed(() => (withQuestion.value ? 1 : 0) + (withAnswer.value ? 1 : 0))

// 每次打开重置勾选与上次结果
watch(visible, (v) => {
  if (v) {
    withQuestion.value = true
    withAnswer.value = true
    withAnalysis.value = false
    withStars.value = false
    result.value = null
    exporting.value = false
  }
})

async function doExport() {
  if (!canExport.value) {
    ElMessage.warning('至少勾选一种卷')
    return
  }
  const papers: Array<'question' | 'answer'> = []
  if (withQuestion.value) papers.push('question')
  if (withAnswer.value) papers.push('answer')
  exporting.value = true
  result.value = null
  try {
    const res = await exportSpecial(specialId.value, {
      papers,
      withAnalysis: withAnalysis.value,
      withStars: withStars.value,
    })
    result.value = res
    ElMessage.success(`已生成 ${papers.length} 个 PDF` + (res.markedCount ? `，${res.markedCount} 题计入使用` : ''))
  } catch (e) {
    console.warn('[special-export] failed', e)
    /* 拦截器已弹错 */
  } finally {
    exporting.value = false
  }
}

function openUrl(url?: string | null) {
  if (url) window.open(url, '_blank')
}

function onClose() {
  store.close()
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    width="460px"
    style="max-width: 94vw"
    :close-on-click-modal="false"
    append-to-body
    @update:model-value="(v: boolean) => (v ? null : onClose())"
    @close="onClose"
  >
    <template #header>
      <div class="se-head">
        <span class="se-title">导出「{{ title || '专项' }}」</span>
      </div>
    </template>

    <div class="se-body">
      <label class="se-chk">
        <el-checkbox v-model="withQuestion" />
        <span class="se-chk-t">题目卷<span class="se-chk-d">学生用，带答题留空</span></span>
      </label>
      <label class="se-chk">
        <el-checkbox v-model="withAnswer" />
        <span class="se-chk-t">答案卷<span class="se-chk-d">老师用，红字答案框</span></span>
      </label>
      <div class="se-div"></div>
      <label class="se-chk sub">
        <el-checkbox v-model="withAnalysis" :disabled="!withAnswer" />
        <span class="se-chk-t">含解析<span class="se-chk-d">答案卷附【详解】</span></span>
      </label>
      <label class="se-chk sub">
        <el-checkbox v-model="withStars" />
        <span class="se-chk-t">显示难度星标（★）<span class="se-chk-d">默认关闭：学生卷面不出现内部标记</span></span>
      </label>

      <div class="se-theme">版式主题：教辅标准（宋体正文 · 蓝区块头 · 金难度档）</div>

      <!-- 导出结果 -->
      <div v-if="result" class="se-result">
        <div class="se-result-t">导出完成，点击下载：</div>
        <el-button v-if="result.questionUrl" type="primary" plain size="small" @click="openUrl(result.questionUrl)">
          下载题目卷 PDF
        </el-button>
        <el-button v-if="result.answerUrl" type="warning" plain size="small" @click="openUrl(result.answerUrl)">
          下载答案卷 PDF
        </el-button>
      </div>
    </div>

    <template #footer>
      <el-button @click="onClose">{{ result ? '关闭' : '取消' }}</el-button>
      <el-button type="primary" :loading="exporting" :disabled="!canExport" @click="doExport">
        {{ exporting ? '生成中…' : `导出 ${paperCount} 个 PDF` }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.se-head { display: flex; align-items: center; }
.se-title { font-size: 16px; font-weight: 700; color: #1d2a2e; }
.se-body { padding: 2px 2px 0; }
.se-chk {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 4px;
  cursor: pointer;
}
.se-chk.sub { padding-left: 6px; }
.se-chk-t { font-size: 14px; color: #1d2a2e; display: flex; flex-direction: column; line-height: 1.4; }
.se-chk-d { font-size: 12px; color: #86909c; margin-top: 2px; }
.se-div { height: 1px; background: #eef3f1; margin: 6px 0; }
.se-theme { font-size: 12px; color: #86909c; margin-top: 10px; }
.se-result {
  margin-top: 14px;
  padding: 12px;
  background: #f2faf7;
  border: 1px solid #d3ece5;
  border-radius: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.se-result-t { width: 100%; font-size: 13px; color: #0a8e6a; font-weight: 600; }
</style>
