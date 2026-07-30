<script setup lang="ts">
/**
 * PRD-015 批2 · 课时账户录入弹窗（三态共用一个壳）。
 * - open      开通学科账户 / 改单价（学科 + 单价）
 * - recharge  充值（金额 + 课时数 + 备注）
 * - adjust    调整（金额 + 课时数，均可正负 + 备注）
 *
 * 🔴 只发 '1' 充值 / '4' 调整两种手工流水；'2' 扣课 / '3' 冲正由结算链服务端产生，前端无入口。
 * 🔴 余额允许为负（欠费不拦截，老师最高权限）——本弹窗不做余额充足性校验。
 */
import { ref, reactive, computed, watch } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { useDictStore, DICT_EDU_SUBJECT } from '@/store/dict'
import {
  upsertAccount,
  addAccountFlow,
  type TuitionAccountVO,
} from '@/api/teacher/account'

type Mode = 'open' | 'recharge' | 'adjust'

const props = defineProps<{
  modelValue: boolean
  mode: Mode
  studentId: string
  /** recharge / adjust 模式下的目标账户 */
  account?: TuitionAccountVO | null
  /** open 模式下已开户学科码（下拉里排除，改单价走行内「改单价」入口） */
  openedSubjects?: string[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'saved'): void
}>()

const dict = useDictStore()
dict.load(DICT_EDU_SUBJECT)
const SUBJECT_OPTIONS = computed(() =>
  dict.list(DICT_EDU_SUBJECT).filter((d) => !(props.openedSubjects || []).includes(d.dictValue)),
)

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

const title = computed(() => {
  if (props.mode === 'open') return '开通学科账户'
  const s = props.account?.subjectLabel || ''
  return props.mode === 'recharge' ? `充值${s ? ' · ' + s : ''}` : `调整${s ? ' · ' + s : ''}`
})

const formRef = ref<FormInstance>()
const submitting = ref(false)

const form = reactive({
  subject: '',
  lessonPrice: 0,
  hoursDelta: 0,
  amountDelta: 0,
  note: '',
})

const rules = computed<FormRules>(() =>
  props.mode === 'open'
    ? {
        subject: [{ required: true, message: '请选择学科', trigger: 'change' }],
        lessonPrice: [{ required: true, message: '请填写课时单价', trigger: 'blur' }],
      }
    : {},
)

/** 充值时按单价换算的参考金额（只提示不代填，两笔增量老师自己定） */
const suggestAmount = computed(() => {
  const price = props.account?.lessonPrice ?? 0
  if (!price || !form.hoursDelta) return ''
  return `按单价 ${price} 元 × ${form.hoursDelta} 课时 = ${(price * form.hoursDelta).toFixed(2)} 元`
})

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    formRef.value?.clearValidate()
    form.subject = ''
    form.lessonPrice = 0
    form.hoursDelta = 0
    form.amountDelta = 0
    form.note = ''
  },
)

async function submit() {
  const ok = await formRef.value?.validate().catch(() => false)
  if (!ok) return
  submitting.value = true
  try {
    if (props.mode === 'open') {
      await upsertAccount({
        studentId: props.studentId,
        subject: form.subject,
        lessonPrice: Number(form.lessonPrice) || 0,
      })
      ElMessage.success('账户已开通')
    } else {
      if (!props.account) return
      if (!form.hoursDelta && !form.amountDelta) {
        ElMessage.warning('课时与金额不能同时为 0')
        return
      }
      await addAccountFlow(props.account.id, {
        flowType: props.mode === 'recharge' ? '1' : '4',
        hoursDelta: Number(form.hoursDelta) || 0,
        amountDelta: Number(form.amountDelta) || 0,
        note: form.note.trim() || undefined,
      })
      ElMessage.success(props.mode === 'recharge' ? '充值已记入' : '调整已记入')
    }
    emit('saved')
    visible.value = false
  } catch {
    // request 拦截器已弹错误 toast
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog v-model="visible" :title="title" width="460px" append-to-body :close-on-click-modal="false">
    <el-form ref="formRef" :model="form" :rules="rules" label-width="86px">
      <template v-if="mode === 'open'">
        <el-form-item label="学科" prop="subject">
          <el-select v-model="form.subject" placeholder="选择学科" style="width: 100%">
            <el-option v-for="d in SUBJECT_OPTIONS" :key="d.dictValue" :label="d.dictLabel" :value="d.dictValue" />
          </el-select>
          <span class="fh">开通即绑定该学科，之后可给这科单独建计划</span>
        </el-form-item>
        <el-form-item label="课时单价" prop="lessonPrice">
          <el-input-number v-model="form.lessonPrice" :min="0" :precision="2" :step="10" style="width: 180px" />
          <span class="fh">元 / 课时</span>
        </el-form-item>
      </template>

      <template v-else>
        <el-form-item label="课时数">
          <el-input-number
            v-model="form.hoursDelta"
            :precision="2"
            :step="1"
            :min="mode === 'recharge' ? 0 : undefined"
            style="width: 180px"
          />
          <span class="fh">{{ mode === 'adjust' ? '可填负数（扣回）' : '本次买的课时' }}</span>
        </el-form-item>
        <el-form-item label="金额">
          <el-input-number
            v-model="form.amountDelta"
            :precision="2"
            :step="100"
            :min="mode === 'recharge' ? 0 : undefined"
            style="width: 180px"
          />
          <span class="fh">元{{ mode === 'adjust' ? '，可填负数' : '' }}</span>
        </el-form-item>
        <el-form-item v-if="suggestAmount" label=" ">
          <span class="fh">{{ suggestAmount }}</span>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" maxlength="200" placeholder="如：暑期第二次续费 / 补记 7-28 少上的一节" />
        </el-form-item>
      </template>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="submit">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.fh {
  margin-left: 10px;
  font-size: 12px;
  color: #8ba09a;
}
</style>
