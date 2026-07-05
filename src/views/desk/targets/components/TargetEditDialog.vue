<script setup lang="ts">
/**
 * PRD-C-213 FP12 · 建档 / 编辑弹窗（学生与班级两套字段）。
 * - create：createTarget → 若班级且选了学员再 setClassStudents。
 * - edit：updateTarget（targetType 不可改）→ 若班级同步 setClassStudents。
 * 班级隐藏 textbook / parentPhone；color 可选（留空则服务端色板轮转）。
 */
import { ref, reactive, watch, computed } from 'vue'
import { ElMessage } from 'element-plus'
import {
  TARGET_TYPE_LABEL,
  createTarget,
  updateTarget,
  setClassStudents,
  type TargetType,
  type TargetDetailVO,
  type TargetCreateBo,
  type TargetUpdateBo,
} from '@/api/teacher/schedule'

const props = defineProps<{
  modelValue: boolean
  mode: 'create' | 'edit'
  targetType: TargetType
  /** edit 模式下的详情（含 studentIds） */
  detail?: TargetDetailVO | null
  /** 班级选学员用的候选（学生对象） */
  studentOptions?: { id: string; name: string }[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'saved', id: string): void
}>()

const PALETTE = ['#0f766e', '#b45309', '#5455b8', '#8a6d3b', '#0e7490', '#9d174d', '#4d7c0f']

const form = reactive({
  name: '',
  grade: '',
  subject: '',
  textbook: '',
  parentPhone: '',
  color: '',
  studentIds: [] as string[],
})

const saving = ref(false)
const isClass = computed(() => props.targetType === '1')
const kindLabel = computed(() => TARGET_TYPE_LABEL[props.targetType])

function resetFrom() {
  if (props.mode === 'edit' && props.detail) {
    const d = props.detail
    form.name = d.name ?? ''
    form.grade = d.grade ?? ''
    form.subject = d.subject ?? ''
    form.textbook = d.textbook ?? ''
    form.parentPhone = d.parentPhone ?? ''
    form.color = d.color ?? ''
    form.studentIds = d.studentIds ? [...d.studentIds] : []
  } else {
    form.name = ''
    form.grade = ''
    form.subject = ''
    form.textbook = ''
    form.parentPhone = ''
    form.color = ''
    form.studentIds = []
  }
}

watch(
  () => props.modelValue,
  (v) => {
    if (v) resetFrom()
  },
)

function pickColor(c: string) {
  form.color = form.color === c ? '' : c
}

async function submit() {
  if (!form.name.trim()) {
    ElMessage.warning('请填写名称')
    return
  }
  saving.value = true
  try {
    let id = props.detail?.id ?? ''
    if (props.mode === 'create') {
      const bo: TargetCreateBo = {
        targetType: props.targetType,
        name: form.name.trim(),
        grade: form.grade.trim() || undefined,
        subject: form.subject.trim() || undefined,
        color: form.color || undefined,
      }
      if (!isClass.value) {
        bo.textbook = form.textbook.trim() || undefined
        bo.parentPhone = form.parentPhone.trim() || undefined
      }
      const res = await createTarget(bo)
      id = res.id
    } else {
      const bo: TargetUpdateBo = {
        name: form.name.trim(),
        grade: form.grade.trim() || undefined,
        subject: form.subject.trim() || undefined,
        color: form.color || undefined,
      }
      if (!isClass.value) {
        bo.textbook = form.textbook.trim() || undefined
        bo.parentPhone = form.parentPhone.trim() || undefined
      }
      await updateTarget(id, bo)
    }
    // 班级同步学员
    if (isClass.value && id) {
      await setClassStudents(id, form.studentIds)
    }
    ElMessage.success(props.mode === 'create' ? '已建档' : '已保存')
    emit('saved', id)
    emit('update:modelValue', false)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="`${mode === 'create' ? '新建' : '编辑'}${kindLabel}`"
    width="520px"
    append-to-body
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-form label-width="72px" label-position="right">
      <el-form-item label="名称" required>
        <el-input v-model="form.name" :placeholder="isClass ? '班级名称' : '学生姓名'" maxlength="50" />
      </el-form-item>
      <div class="ge-row">
        <el-form-item label="年级">
          <el-input v-model="form.grade" placeholder="如 初一 / 升四" />
        </el-form-item>
        <el-form-item label="学科">
          <el-input v-model="form.subject" placeholder="如 数学 / 科学" />
        </el-form-item>
      </div>
      <template v-if="!isClass">
        <el-form-item label="教材">
          <el-input v-model="form.textbook" placeholder="如 人教版数学" maxlength="100" />
        </el-form-item>
        <el-form-item label="家长电话">
          <el-input v-model="form.parentPhone" placeholder="用于家长版导出" maxlength="20" />
        </el-form-item>
      </template>
      <el-form-item v-else label="班级学员">
        <el-select
          v-model="form.studentIds"
          multiple
          filterable
          collapse-tags
          collapse-tags-tooltip
          placeholder="选择学生（可留空后续再设）"
          style="width: 100%"
        >
          <el-option
            v-for="s in studentOptions || []"
            :key="s.id"
            :value="s.id"
            :label="s.name"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="对象色">
        <div class="color-row">
          <span
            v-for="c in PALETTE"
            :key="c"
            class="swatch"
            :class="{ on: form.color === c }"
            :style="{ background: c }"
            @click="pickColor(c)"
          />
          <span class="swatch auto" :class="{ on: !form.color }" @click="form.color = ''">自动</span>
        </div>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submit">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.ge-row {
  display: flex;
  gap: 12px;
}
.ge-row .el-form-item {
  flex: 1;
}
.color-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.swatch {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  cursor: pointer;
  border: 2px solid transparent;
  box-sizing: border-box;
}
.swatch.on {
  border-color: var(--bk-ink);
  box-shadow: 0 0 0 2px #fff inset;
}
.swatch.auto {
  width: auto;
  padding: 0 10px;
  height: 22px;
  line-height: 20px;
  font-size: 12px;
  color: #5f716d;
  background: #eef1f0;
  border-radius: 6px;
}
.swatch.auto.on {
  color: var(--bk-teal-deep);
  background: var(--bk-teal-soft);
  border-color: var(--bk-teal);
}
</style>
