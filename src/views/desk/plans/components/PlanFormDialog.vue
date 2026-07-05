<script setup lang="ts">
/**
 * PRD-C-213 FP16 — 计划新建 / 编辑弹窗（含 default_seg_template 三段默认配置编辑）。
 * 新建（plan=null）走 createPlan，编辑走 updatePlan。保存成功 emit saved 让父页刷新。
 * 契约：批0 §三 课程计划 POST plan / PUT plan/{id}；termTag 字典 = 暑假·上学期·寒假·下学期。
 */
import { ref, reactive, watch, computed } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import {
  createPlan,
  updatePlan,
  TARGET_TYPE_LABEL,
  type PlanVO,
  type PlanBo,
  type TargetType,
  type SegTemplateItem,
} from '@/api/teacher/schedule'
import { useDictStore } from '@/store/dict'
import SegTemplateEditor from './SegTemplateEditor.vue'

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
  termTag: string
  year: number
  materialNote: string
  defaultSegTemplate: SegTemplateItem[]
}

const form = reactive<FormState>({
  name: '',
  targetType: '0',
  termTag: '暑假',
  year: currentYear,
  materialNote: '',
  defaultSegTemplate: [],
})

const rules: FormRules<FormState> = {
  name: [{ required: true, message: '请填写计划名', trigger: 'blur' }],
  targetType: [{ required: true, message: '请选择对象类型', trigger: 'change' }],
  termTag: [{ required: true, message: '请选择学期', trigger: 'change' }],
  year: [{ required: true, message: '请选择年份', trigger: 'change' }],
}

// 打开时回填 / 重置
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    formRef.value?.clearValidate()
    if (props.plan) {
      form.name = props.plan.name
      form.targetType = props.plan.targetType
      form.termTag = props.plan.termTag || '暑假'
      form.year = props.plan.year || currentYear
      form.materialNote = props.plan.materialNote || ''
      form.defaultSegTemplate = (props.plan.defaultSegTemplate || []).map((s) => ({ ...s }))
    } else {
      form.name = ''
      form.targetType = '0'
      form.termTag = '暑假'
      form.year = currentYear
      form.materialNote = ''
      form.defaultSegTemplate = [
        { name: '思维题', style: '开场1道·单点突破·一题一坑', topic: '' },
        { name: '奥数专项', style: '书挑题·★分层', topic: '' },
        { name: '课内同步', style: '收尾过关·简单不费脑', topic: '' },
      ]
    }
  },
)

async function submit() {
  const ok = await formRef.value?.validate().catch(() => false)
  if (!ok) return
  const bo: PlanBo = {
    name: form.name.trim(),
    targetType: form.targetType,
    termTag: form.termTag,
    year: form.year,
    materialNote: form.materialNote.trim() || undefined,
    defaultSegTemplate: form.defaultSegTemplate.length ? form.defaultSegTemplate : undefined,
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
      <el-form-item label="默认三段式">
        <div class="seg-wrap">
          <div class="seg-tip">课次未单独配置时继承此默认分段（段数 2-4）</div>
          <SegTemplateEditor v-model="form.defaultSegTemplate" />
        </div>
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
