<script setup lang="ts">
/**
 * PRD-C-213 FP12 · 建档 / 编辑弹窗（学生与班级两套字段）。
 * - create：createTarget → 若班级且选了学员再 setClassStudents。
 * - edit：updateTarget（targetType 不可改）→ 若班级同步 setClassStudents。
 * 班级隐藏 教材版本 / parentPhone；color 可选（留空则服务端色板轮转）。
 * 🔴 R1a 建模：年级=gradeNo 数字码 + gradeYear（隐藏缺省当年）；学科/教材版本=字典码；
 *    显示层用 BE 推导串（VO grade/textbook/subjectLabel），本弹窗只管写原始码。
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
import { useDictStore, DICT_EDU_GRADE, DICT_EDU_SUBJECT, DICT_EDU_EDITION } from '@/store/dict'

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

/** 缺省学年 = 当年（R1a：gradeYear 隐藏缺省，暑期录「升X」即 当年学年就读 X 年级） */
const CURRENT_YEAR = new Date().getFullYear()

const form = reactive({
  name: '',
  /** 年级 1-12（字典 biz_edu_grade 数字码；null = 未选） */
  gradeNo: null as number | null,
  /** 学年起始年（隐藏缺省当年；编辑时保留原值） */
  gradeYear: CURRENT_YEAR as number | null,
  /** 学科字典码（biz_edu_subject：'1'数学…） */
  subject: '',
  /** 教材版本字典码（biz_edu_edition：'1'浙教/'2'人教…） */
  textbookEdition: '',
  parentPhone: '',
  color: '',
  studentIds: [] as string[],
})

const saving = ref(false)
const isClass = computed(() => props.targetType === '1')
const kindLabel = computed(() => TARGET_TYPE_LABEL[props.targetType])

// R1a 建模：年级/学科/教材版本 = 字典下拉存码（biz_edu_grade / biz_edu_subject / biz_edu_edition），
// 不再 allow-create 存自由文本；显示层用 BE 推导串（VO grade/textbook/subjectLabel）。
// 🔴 字典走前端进程内缓存：BE 重启/字典变更后首次拉取才有新值，异常时刷新页面重拉。
const dict = useDictStore()
dict.load(DICT_EDU_GRADE)
dict.load(DICT_EDU_SUBJECT)
dict.load(DICT_EDU_EDITION)

const GRADE_OPTIONS = computed(() => dict.list(DICT_EDU_GRADE))
const SUBJECT_OPTIONS = computed(() => dict.list(DICT_EDU_SUBJECT))
const EDITION_OPTIONS = computed(() => dict.list(DICT_EDU_EDITION))

function resetFrom() {
  if (props.mode === 'edit' && props.detail) {
    const d = props.detail
    form.name = d.name ?? ''
    form.gradeNo = d.gradeNo ?? null
    form.gradeYear = d.gradeYear ?? CURRENT_YEAR
    form.subject = d.subject ?? ''
    form.textbookEdition = d.textbookEdition ?? ''
    form.parentPhone = d.parentPhone ?? ''
    form.color = d.color ?? ''
    form.studentIds = d.studentIds ? [...d.studentIds] : []
  } else {
    form.name = ''
    form.gradeNo = null
    form.gradeYear = CURRENT_YEAR
    form.subject = ''
    form.textbookEdition = ''
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
    // R1a：选了年级才带 gradeYear（隐藏缺省当年）；学科/教材版本传字典码
    const eduDims = {
      gradeNo: form.gradeNo ?? undefined,
      gradeYear: form.gradeNo != null ? (form.gradeYear ?? CURRENT_YEAR) : undefined,
      subject: form.subject || undefined,
      textbookEdition: form.textbookEdition || undefined,
    }
    if (props.mode === 'create') {
      const bo: TargetCreateBo = {
        targetType: props.targetType,
        name: form.name.trim(),
        ...eduDims,
        color: form.color || undefined,
      }
      if (!isClass.value) {
        bo.parentPhone = form.parentPhone.trim() || undefined
      }
      const res = await createTarget(bo)
      id = res.id
    } else {
      const bo: TargetUpdateBo = {
        name: form.name.trim(),
        ...eduDims,
        color: form.color || undefined,
      }
      if (!isClass.value) {
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
          <!-- R1a：存 gradeNo 数字码（字典 biz_edu_grade）；学年隐藏缺省当年（暑期录「升四」=选 四年级） -->
          <el-select v-model="form.gradeNo" filterable clearable placeholder="如 升四 选「四年级」" style="width: 100%">
            <el-option
              v-for="g in GRADE_OPTIONS"
              :key="g.dictValue"
              :label="g.dictLabel"
              :value="Number(g.dictValue)"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="学科">
          <!-- 存字典码 biz_edu_subject（'1'数学…） -->
          <el-select v-model="form.subject" filterable clearable placeholder="请选择学科" style="width: 100%">
            <el-option v-for="s in SUBJECT_OPTIONS" :key="s.dictValue" :label="s.dictLabel" :value="s.dictValue" />
          </el-select>
        </el-form-item>
      </div>
      <template v-if="!isClass">
        <el-form-item label="教材版本">
          <!-- 存字典码 biz_edu_edition（'2'人教…）；具体册次由 年级+学年 推导显示 -->
          <el-select v-model="form.textbookEdition" filterable clearable placeholder="如 人教" style="width: 100%">
            <el-option v-for="e in EDITION_OPTIONS" :key="e.dictValue" :label="e.dictLabel" :value="e.dictValue" />
          </el-select>
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
