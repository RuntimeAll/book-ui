<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import {
  addAiMemory,
  deleteAiMemory,
  listAiMemory,
  toggleAiMemory,
  updateAiMemory,
  type AiMemoryBo,
  type AiMemoryVO,
} from '@/api/teacher/ai-memory'

// ---------------------------------------------------------------------------
// PRD-C-100 B6 — AI 记忆维护分区（个人资料页内 tab）。
//
//   - 三类分组：偏好 / 纠正 / 习惯（MEM_TYPES）。
//   - 来源徽章：自动（AI 沉淀）/ 手填（老师维护）。
//   - 启停开关：调 toggle 端点；停用的记忆视觉置灰、不参与 AI 上下文。
//   - 增 / 改 / 删：表单（memType 下拉 + memKey + memValue + remark）。
//   - 空态友好：无记忆时给引导文案。
//
// 走 /api → book-server（misikt envelope，code===1 由拦截器解包）。
// ---------------------------------------------------------------------------

const MEM_TYPES = ['偏好', '纠正', '习惯'] as const
type MemType = (typeof MEM_TYPES)[number]

/** 类型 → 展示元信息（图标 + 说明 + 主题色） */
const TYPE_META: Record<string, { icon: string; desc: string; color: string }> = {
  偏好: { icon: '💡', desc: '你希望 AI 默认怎么做（如难度、题量、风格）', color: '#7b6cf0' },
  纠正: { icon: '✏️', desc: '纠正过 AI 的具体错误（避免重蹈覆辙）', color: '#1e8a8a' },
  习惯: { icon: '🔁', desc: '你常用的命题 / 组卷习惯（沉淀复用）', color: '#b8741a' },
}

const loading = ref(false)
const list = ref<AiMemoryVO[]>([])
const togglingId = ref<string>('')

// 列表过滤
const filterType = ref<string>('') // '' = 全部
const enabledOnly = ref(false)

async function load() {
  loading.value = true
  try {
    const params: { memType?: string; enabledOnly?: boolean } = {}
    if (filterType.value) params.memType = filterType.value
    if (enabledOnly.value) params.enabledOnly = true
    const data = await listAiMemory(params)
    list.value = Array.isArray(data) ? data : []
  } catch (e) {
    console.warn('[ai-memory] 列表加载失败', e)
    // 错误 toast 由 http 拦截器统一弹（code!==1）
  } finally {
    loading.value = false
  }
}

/** 按类型分组（即便 filterType 选了全部也分三组展示） */
const grouped = computed<Record<MemType, AiMemoryVO[]>>(() => {
  const g: Record<MemType, AiMemoryVO[]> = { 偏好: [], 纠正: [], 习惯: [] }
  for (const m of list.value) {
    if (m.memType === '偏好' || m.memType === '纠正' || m.memType === '习惯') {
      g[m.memType].push(m)
    }
  }
  return g
})

const isEmpty = computed(() => list.value.length === 0)

// ---------------------------------------------------------------------------
// 增 / 改 表单
// ---------------------------------------------------------------------------
const dialogVisible = ref(false)
const saving = ref(false)
const editingId = ref<string>('') // 非空 = 编辑模式
const formRef = ref<FormInstance>()

const form = reactive<AiMemoryBo>({
  memType: '偏好',
  memKey: '',
  memValue: '',
  remark: '',
})

const rules: FormRules = {
  memType: [{ required: true, message: '请选择记忆类型', trigger: 'change' }],
  memKey: [{ required: true, message: '请输入记忆标题', trigger: 'blur' }],
  memValue: [{ required: true, message: '请输入记忆内容', trigger: 'blur' }],
}

const dialogTitle = computed(() => (editingId.value ? '编辑 AI 记忆' : '新增 AI 记忆'))

function openAdd(presetType?: MemType) {
  editingId.value = ''
  form.memType = presetType ?? '偏好'
  form.memKey = ''
  form.memValue = ''
  form.remark = ''
  dialogVisible.value = true
}

function openEdit(m: AiMemoryVO) {
  editingId.value = m.id
  form.memType = m.memType
  form.memKey = m.memKey
  form.memValue = m.memValue
  form.remark = m.remark ?? ''
  dialogVisible.value = true
}

async function handleSave() {
  if (!formRef.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  saving.value = true
  try {
    const bo: AiMemoryBo = {
      memType: form.memType,
      memKey: form.memKey.trim(),
      memValue: form.memValue.trim(),
      remark: form.remark?.trim() || undefined,
    }
    if (editingId.value) {
      await updateAiMemory(editingId.value, bo)
      ElMessage.success('已更新')
    } else {
      await addAiMemory(bo)
      ElMessage.success('已新增')
    }
    dialogVisible.value = false
    await load()
  } catch (e) {
    console.warn('[ai-memory] 保存失败', e)
    // 错误 toast 由拦截器弹
  } finally {
    saving.value = false
  }
}

// ---------------------------------------------------------------------------
// 启停 / 删除
// ---------------------------------------------------------------------------
async function handleToggle(m: AiMemoryVO) {
  if (togglingId.value) return
  togglingId.value = m.id
  try {
    const vo = await toggleAiMemory(m.id)
    // 整条替换（保 BE 真实态）；BE 未返完整 VO 时本地翻转兜底
    const idx = list.value.findIndex((x) => x.id === m.id)
    if (idx >= 0) {
      list.value[idx] =
        vo && typeof vo === 'object' && 'enabled' in vo
          ? vo
          : { ...m, enabled: !m.enabled }
    }
    ElMessage.success(list.value.find((x) => x.id === m.id)?.enabled ? '已启用' : '已停用')
  } catch (e) {
    console.warn('[ai-memory] 切换失败', e)
  } finally {
    togglingId.value = ''
  }
}

async function handleDelete(m: AiMemoryVO) {
  try {
    await ElMessageBox.confirm(`确定删除记忆「${m.memKey}」吗？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return // 取消
  }
  try {
    await deleteAiMemory(m.id)
    list.value = list.value.filter((x) => x.id !== m.id)
    ElMessage.success('已删除')
  } catch (e) {
    console.warn('[ai-memory] 删除失败', e)
  }
}

/** 来源徽章文案（兼容缺省 → 手填） */
function sourceLabel(src: string | null): string {
  return src === '自动' || src === 'auto' ? '自动' : '手填'
}
function isAutoSource(src: string | null): boolean {
  return src === '自动' || src === 'auto'
}

onMounted(load)
</script>

<template>
  <div class="ai-memory">
    <header class="am-head">
      <div class="am-head-text">
        <h2 class="am-title">AI 记忆</h2>
        <p class="am-sub">
          这些记忆会在 AI 命题 / 组卷时作为你的个性化上下文。停用的记忆不参与，删除即永久移除。
        </p>
      </div>
      <el-button type="primary" @click="openAdd()">＋ 新增记忆</el-button>
    </header>

    <!-- 过滤栏 -->
    <div class="am-filters">
      <el-radio-group v-model="filterType" size="small" @change="load">
        <el-radio-button value="">全部</el-radio-button>
        <el-radio-button v-for="t in MEM_TYPES" :key="t" :value="t">{{ t }}</el-radio-button>
      </el-radio-group>
      <el-checkbox v-model="enabledOnly" size="small" @change="load">只看启用</el-checkbox>
    </div>

    <div v-loading="loading" class="am-body">
      <!-- 空态 -->
      <div v-if="isEmpty && !loading" class="am-empty">
        <div class="am-empty-emoji">🧠</div>
        <p class="am-empty-title">还没有任何 AI 记忆</p>
        <p class="am-empty-tip">
          新增一条「偏好 / 纠正 / 习惯」，AI 下次出题就会照着你的口味来。
          AI 在使用中也会自动沉淀记忆（来源标「自动」）。
        </p>
        <el-button type="primary" plain @click="openAdd()">新增第一条记忆</el-button>
      </div>

      <!-- 按三类分组 -->
      <template v-else>
        <section
          v-for="t in MEM_TYPES"
          v-show="!filterType || filterType === t"
          :key="t"
          class="am-group"
        >
          <div class="am-group-head">
            <span class="am-group-icon">{{ TYPE_META[t].icon }}</span>
            <span class="am-group-title" :style="{ color: TYPE_META[t].color }">{{ t }}</span>
            <span class="am-group-count">{{ grouped[t].length }}</span>
            <span class="am-group-desc">{{ TYPE_META[t].desc }}</span>
            <el-button
              text
              size="small"
              class="am-group-add"
              @click="openAdd(t)"
            >
              ＋ 加一条
            </el-button>
          </div>

          <p v-if="grouped[t].length === 0" class="am-group-empty">暂无{{ t }}记忆</p>

          <ul v-else class="am-list">
            <li
              v-for="m in grouped[t]"
              :key="m.id"
              class="am-item"
              :class="{ 'is-disabled': !m.enabled }"
            >
              <div class="am-item-main">
                <div class="am-item-top">
                  <span class="am-item-key">{{ m.memKey }}</span>
                  <span
                    class="am-badge"
                    :class="isAutoSource(m.source) ? 'badge-auto' : 'badge-manual'"
                  >
                    {{ sourceLabel(m.source) }}
                  </span>
                  <span v-if="!m.enabled" class="am-badge badge-off">已停用</span>
                </div>
                <p class="am-item-value">{{ m.memValue }}</p>
                <p v-if="m.remark" class="am-item-remark">备注：{{ m.remark }}</p>
              </div>

              <div class="am-item-actions">
                <el-switch
                  :model-value="m.enabled"
                  size="small"
                  :loading="togglingId === m.id"
                  inline-prompt
                  active-text="启"
                  inactive-text="停"
                  @change="handleToggle(m)"
                />
                <el-button text size="small" @click="openEdit(m)">编辑</el-button>
                <el-button text size="small" class="am-del" @click="handleDelete(m)">删除</el-button>
              </div>
            </li>
          </ul>
        </section>
      </template>
    </div>

    <!-- 增 / 改弹窗 -->
    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="520px" append-to-body>
      <el-form ref="formRef" :model="form" :rules="rules" label-width="84px">
        <el-form-item label="类型" prop="memType">
          <el-select v-model="form.memType" class="am-full">
            <el-option v-for="t in MEM_TYPES" :key="t" :label="t" :value="t" />
          </el-select>
          <div class="am-field-tip">{{ TYPE_META[form.memType]?.desc }}</div>
        </el-form-item>
        <el-form-item label="标题" prop="memKey">
          <el-input v-model="form.memKey" maxlength="40" show-word-limit placeholder="如：难度偏好" />
        </el-form-item>
        <el-form-item label="内容" prop="memValue">
          <el-input
            v-model="form.memValue"
            type="textarea"
            :rows="3"
            maxlength="500"
            show-word-limit
            placeholder="如：默认出中等难度，避免超纲；选择题优先 4 个选项"
          />
        </el-form-item>
        <el-form-item label="备注">
          <el-input
            v-model="form.remark"
            type="textarea"
            :rows="2"
            maxlength="200"
            placeholder="可选，便于你日后回忆为什么加这条"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="handleSave">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.ai-memory {
  max-width: 760px;
}

.am-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}
.am-title {
  font-size: 18px;
  font-weight: 600;
  color: #1d2a2e;
  margin: 0 0 6px;
}
.am-sub {
  font-size: 13px;
  color: #86909c;
  line-height: 1.6;
  margin: 0;
}

.am-filters {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
}

.am-body {
  min-height: 120px;
}

/* 空态 */
.am-empty {
  text-align: center;
  padding: 40px 0;
  color: #86909c;
}
.am-empty-emoji {
  font-size: 40px;
}
.am-empty-title {
  font-size: 15px;
  font-weight: 600;
  color: #4e5969;
  margin: 10px 0 6px;
}
.am-empty-tip {
  font-size: 13px;
  color: #a0a8b3;
  line-height: 1.7;
  max-width: 440px;
  margin: 0 auto 16px;
}

/* 分组 */
.am-group {
  margin-bottom: 22px;
}
.am-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid #eef1f1;
  margin-bottom: 10px;
}
.am-group-icon {
  font-size: 15px;
}
.am-group-title {
  font-size: 14px;
  font-weight: 700;
}
.am-group-count {
  font-size: 12px;
  color: #fff;
  background: #c0c6cf;
  border-radius: 9px;
  padding: 0 7px;
  line-height: 17px;
  min-width: 17px;
  text-align: center;
}
.am-group-desc {
  font-size: 12px;
  color: #a0a8b3;
}
.am-group-add {
  margin-left: auto;
}
.am-group-empty {
  font-size: 12px;
  color: #c0c6cf;
  padding: 4px 2px 8px;
  margin: 0;
}

.am-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.am-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid #e7e3da;
  border-radius: 10px;
  background: #fff;
  transition: opacity 0.2s, background 0.2s;
}
.am-item.is-disabled {
  opacity: 0.55;
  background: #f7f8f8;
}
.am-item-main {
  flex: 1;
  min-width: 0;
}
.am-item-top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.am-item-key {
  font-size: 14px;
  font-weight: 600;
  color: #1d2a2e;
}
.am-badge {
  font-size: 11px;
  line-height: 16px;
  padding: 0 7px;
  border-radius: 8px;
}
.badge-auto {
  color: #7b6cf0;
  background: #f1eeff;
}
.badge-manual {
  color: #1e8a8a;
  background: #e6f4f4;
}
.badge-off {
  color: #86909c;
  background: #eef1f1;
}
.am-item-value {
  font-size: 13px;
  color: #4e5969;
  line-height: 1.6;
  margin: 6px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.am-item-remark {
  font-size: 12px;
  color: #a0a8b3;
  margin: 4px 0 0;
}

.am-item-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.am-del:hover {
  color: #cf1322;
}

.am-full {
  width: 100%;
}
.am-field-tip {
  font-size: 12px;
  color: #a0a8b3;
  line-height: 1.6;
  margin-top: 2px;
}
</style>
