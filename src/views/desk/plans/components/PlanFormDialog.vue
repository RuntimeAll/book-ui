<script setup lang="ts">
/**
 * PRD-C-213 FP16 — 计划新建 / 编辑弹窗（含 default_seg_template 三段默认配置编辑）。
 * 新建（plan=null）走 createPlan，编辑走 updatePlan。保存成功 emit saved 让父页刷新。
 * 契约：批0 §三 课程计划 POST plan / PUT plan/{id}；termTag 字典 = 暑假·上学期·寒假·下学期。
 * 🔴 R1a·S1：计划有归属——新建必选归属对象（targetType+targetId，BE 强校验）；编辑不可改归属。
 * 🔴 PRD-015 学科线（V10）：学生对象的学科下拉 = <b>该生已开户学科</b>（开户即绑定，D3）——
 *    没开户的学科不给选，硬选也会被 BE 挡回 400「先为学生开通X账户」；班级对象保持原样（无账户模型）。
 */
import { ref, reactive, watch, computed } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import {
  createPlan,
  updatePlan,
  pageTargets,
  TARGET_TYPE_LABEL,
  type PlanVO,
  type PlanBo,
  type TargetType,
  type TargetCardVO,
} from '@/api/teacher/schedule'
import { listAccounts, type TuitionAccountVO } from '@/api/teacher/account'
import { useDictStore } from '@/store/dict'
// PRD-003 D7：默认卷位编辑器（PaperSlotsEditor）随 paper_slots 编辑链整套退役，
// 计划不再配默认卷位模板；课次材料统一走专项材料位（P6）。

const props = defineProps<{
  modelValue: boolean
  /** null = 新建；非空 = 编辑该计划 */
  plan: PlanVO | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'saved', id: string): void
}>()

// PRD-C-213 终审：期段改吃字典 biz_term_tag（暑假/上学期/寒假/下学期，四值封闭，不 allow-create）。
// 🔴 biz_term_tag 的 value=中文文本本身（与 label 同文），termTag 列 varchar 存中文，直接绑 dictLabel。
const DICT_TERM_TAG = 'biz_term_tag'
const dict = useDictStore()
dict.load(DICT_TERM_TAG)
const TERM_OPTIONS = computed(() => dict.list(DICT_TERM_TAG).map((d) => d.dictLabel))
const currentYear = new Date().getFullYear()
const YEAR_OPTIONS = Array.from({ length: 5 }, (_, i) => currentYear - 1 + i)

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

const isEdit = computed(() => !!props.plan)
const title = computed(() => (isEdit.value ? '编辑计划' : '新建计划'))

const formRef = ref<FormInstance>()
const submitting = ref(false)

interface FormState {
  name: string
  targetType: TargetType
  /** R1a·S1 归属对象 id（新建必选） */
  targetId: string
  /** PRD-015 学科（学生=已开户学科之一） */
  subject: string
  termTag: string
  year: number
  materialNote: string
}

const form = reactive<FormState>({
  name: '',
  targetType: '0',
  targetId: '',
  subject: '',
  termTag: '暑假',
  year: currentYear,
  materialNote: '',
})

const rules: FormRules<FormState> = {
  name: [{ required: true, message: '请填写计划名', trigger: 'blur' }],
  targetType: [{ required: true, message: '请选择对象类型', trigger: 'change' }],
  targetId: [{ required: true, message: '请选择归属对象', trigger: 'change' }],
  termTag: [{ required: true, message: '请选择学期', trigger: 'change' }],
  year: [{ required: true, message: '请选择年份', trigger: 'change' }],
}

// ── R1a·S1 归属对象选择器（从简：按对象类型拉卡片墙，不含已归档）──
const targetOptions = ref<TargetCardVO[]>([])
const targetLoading = ref(false)
async function loadTargetOptions(tt: TargetType) {
  targetLoading.value = true
  try {
    const res = await pageTargets({ targetType: tt, pageNum: 1, pageSize: 200 })
    targetOptions.value = res?.rows ?? []
  } catch {
    targetOptions.value = []
  } finally {
    targetLoading.value = false
  }
}
// 切对象类型 → 归属选项跟着换、已选清空（编辑态不动）
watch(
  () => form.targetType,
  (tt) => {
    if (isEdit.value) return
    form.targetId = ''
    form.subject = ''
    subjectOptions.value = []
    void loadTargetOptions(tt)
  },
)

// ── PRD-015·V10 学科选项 = 该归属学生已开户学科（班级无账户模型 → 不限制、不展示下拉）──
const subjectOptions = ref<TuitionAccountVO[]>([])
const subjectLoading = ref(false)
const isClassPlan = computed(() => form.targetType === '1')

async function loadSubjectOptions(studentId: string) {
  if (!studentId) {
    subjectOptions.value = []
    return
  }
  subjectLoading.value = true
  try {
    // 🔴 bug 批 BUG-3/A：停用账户不进下拉（BE requireSubjectAccount 同口径，选了也会 400）
    subjectOptions.value = ((await listAccounts(studentId)) ?? []).filter((a) => a.status !== '1')
  } catch {
    subjectOptions.value = []
  } finally {
    subjectLoading.value = false
  }
}

// 切归属对象 → 重新拉该生开户学科；已选学科不在新列表里就清空（防串人）
watch(
  () => form.targetId,
  async (tid) => {
    if (isClassPlan.value) {
      subjectOptions.value = []
      return
    }
    await loadSubjectOptions(tid)
    if (form.subject && !subjectOptions.value.some((a) => a.subject === form.subject)) {
      form.subject = ''
    }
  },
)

// 打开时回填 / 重置
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    formRef.value?.clearValidate()
    if (props.plan) {
      form.name = props.plan.name
      form.targetType = props.plan.targetType
      form.targetId = props.plan.targetId ?? ''
      form.subject = props.plan.subject ?? ''
      form.termTag = props.plan.termTag || '暑假'
      form.year = props.plan.year || currentYear
      form.materialNote = props.plan.materialNote || ''
      void loadTargetOptions(props.plan.targetType) // 编辑态只为回显归属名
    } else {
      form.name = ''
      form.targetType = '0'
      form.targetId = ''
      form.subject = ''
      subjectOptions.value = []
      void loadTargetOptions('0')
      form.termTag = '暑假'
      form.year = currentYear
      form.materialNote = ''
    }
  },
)

async function submit() {
  const ok = await formRef.value?.validate().catch(() => false)
  if (!ok) return
  const bo: PlanBo = {
    name: form.name.trim(),
    targetType: form.targetType,
    // R1a·S1：新建必传归属；编辑带上原值（BE 归属不可改语义以服务端为准）
    targetId: form.targetId || undefined,
    // PRD-015：学生计划的学科必须是已开户学科（BE 同校验，未开户 400）
    subject: form.subject || undefined,
    termTag: form.termTag,
    year: form.year,
    materialNote: form.materialNote.trim() || undefined,
  }
  submitting.value = true
  try {
    if (isEdit.value && props.plan) {
      await updatePlan(props.plan.id, bo)
      ElMessage.success('计划已保存')
      emit('saved', props.plan.id)
    } else {
      const res = await createPlan(bo)
      ElMessage.success('计划已创建')
      emit('saved', res?.id ?? '')
    }
    visible.value = false
  } catch {
    // request 拦截器已弹错误 toast
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog v-model="visible" :title="title" width="620px" append-to-body :close-on-click-modal="false">
    <el-form ref="formRef" :model="form" :rules="rules" label-width="92px">
      <el-form-item label="计划名" prop="name">
        <el-input v-model="form.name" maxlength="100" placeholder="如：苏俊宇 · 暑期数学计划" />
      </el-form-item>
      <el-form-item label="对象类型" prop="targetType">
        <el-radio-group v-model="form.targetType" :disabled="isEdit">
          <el-radio-button value="0">{{ TARGET_TYPE_LABEL['0'] }}</el-radio-button>
          <el-radio-button value="1">{{ TARGET_TYPE_LABEL['1'] }}</el-radio-button>
        </el-radio-group>
        <span v-if="isEdit" class="form-hint">对象类型不可改</span>
      </el-form-item>
      <el-form-item label="归属对象" prop="targetId">
        <!-- R1a·S1：计划必须归属一个学生/班级（BE 强校验）；编辑不可改归属 -->
        <el-select
          v-model="form.targetId"
          filterable
          :loading="targetLoading"
          :disabled="isEdit"
          placeholder="选择这份计划教谁"
          style="width: 100%"
        >
          <el-option
            v-for="t in targetOptions"
            :key="t.id"
            :value="t.id"
            :label="`${t.name}${t.grade ? '（' + t.grade + '）' : ''}`"
          />
        </el-select>
        <span v-if="isEdit" class="form-hint">归属不可改（换绑走对象卡片「换绑计划」）</span>
      </el-form-item>
      <!-- PRD-015·V10：学科下拉只列该生已开户学科；没开户先去学生详情「课时账户」开通 -->
      <el-form-item v-if="!isClassPlan" label="学科" prop="subject">
        <el-select
          v-model="form.subject"
          :loading="subjectLoading"
          :disabled="!form.targetId"
          clearable
          placeholder="选择学科"
          style="width: 220px"
        >
          <el-option
            v-for="a in subjectOptions"
            :key="a.id"
            :value="a.subject"
            :label="a.subjectLabel || a.subject"
          />
        </el-select>
        <span class="form-hint">
          {{
            !form.targetId
              ? '先选归属对象'
              : subjectOptions.length
                ? '只列该学生已开通的学科'
                : '该学生还没开通学科账户 —— 去学生详情「课时账户」开通'
          }}
        </span>
      </el-form-item>
      <el-form-item label="学期 / 年份" prop="termTag">
        <div class="term-row">
          <el-select v-model="form.termTag" placeholder="学期" style="width: 130px">
            <el-option v-for="t in TERM_OPTIONS" :key="t" :label="t" :value="t" />
          </el-select>
          <el-select v-model="form.year" placeholder="年份" style="width: 120px">
            <el-option v-for="y in YEAR_OPTIONS" :key="y" :label="`${y}`" :value="y" />
          </el-select>
        </div>
      </el-form-item>
      <el-form-item label="素材说明">
        <el-input v-model="form.materialNote" maxlength="200" placeholder="如：学而思 36 周书 · 挑题制" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="submit">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.form-hint {
  margin-left: 10px;
  font-size: 12px;
  color: #8ba09a;
}
.term-row {
  display: flex;
  gap: 10px;
}
.seg-wrap {
  width: 100%;
}
.seg-tip {
  font-size: 12px;
  color: #8ba09a;
  margin-bottom: 8px;
}
</style>
