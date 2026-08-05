<script setup lang="ts">
/**
 * PRD-018 M6-2 · 账本转移（换本 / 拆本）—— **唯一实现**，「课时账单」页与学生详情共用。
 *
 * 一个事务产**一对互指的 '4' 调整行**：老师手搓两笔无关调整在台账上对不出因果，
 * transfer 才能把「这笔课时从这本挪到那本」解释清楚（改绑/拆账的唯一正路）。
 *
 * 🔴 改计价的正确姿势 = 开新本 + 把余额 transfer 过去，**不是**改老本的价
 *    （历史金额已被 amount_paid 冻结，改价不回溯，但共享本「同价才能并本」的约束会被打破）。
 * 🔴 跨不同计价的账本转，金额天然不守恒 —— 同样的小时在新账本按新价算钱。
 *    这是「小时本位 + 金额派生」的固有性质，写在弹窗里明说，不做拉平（PRD §4 边界）。
 * 🔴 D11：不出现按小时计价的说法，账本用「每节 X 小时 · Y 元/节」描述；
 *    共享本 / 零绑定本折不出唯一每节价 → 只报余额。
 */
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { listMyAccountBooks, transferAccount, type AccountBookVO } from '@/api/teacher/account'
import { useTuitionUnit, todayStr } from '@/composables/useTuitionUnit'

const props = defineProps<{
  modelValue: boolean
  /** 转出账本 */
  from: AccountBookVO | null
  /** 转入候选（父级已有清单就传进来省一次请求；不传则本组件自己拉） */
  books?: AccountBookVO[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'done'): void
}>()

const { fmtNum, priceSpecText } = useTuitionUnit()

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

const myBooks = ref<AccountBookVO[]>([])
const transferring = ref(false)
const form = reactive({
  toAccountId: '',
  hours: 0,
  occurDate: todayStr(),
  note: '',
})

watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return
    form.toAccountId = ''
    form.hours = 0
    form.occurDate = todayStr()
    form.note = ''
    // 下拉要最新的账本表（刚开的本、刚改的名都得在）
    if (props.books?.length) {
      myBooks.value = props.books
      return
    }
    try {
      myBooks.value = (await listMyAccountBooks()) ?? []
    } catch {
      /* 拉不到就空着，总比开不出弹窗强 */
    }
  },
)

/** 转入候选 = 我的其他账本（排除转出本身） */
const targets = computed(() => myBooks.value.filter((b) => b.id !== props.from?.id))

function bookTag(b: AccountBookVO) {
  const tag = (b.name || '').trim() || (b.studentNames || []).filter(Boolean).join('+')
  return tag || `账本 #${b.id}`
}

/** 下拉行的副信息：能折出每节价就报计价，否则只报余额（共享本每人每节时长不同） */
function bookOption(b: AccountBookVO) {
  const spec = priceSpecText(b.pricePerHour, b.hoursPerLesson)
  const bal = `余 ${fmtNum(b.hoursRemain)} 小时`
  return `${bookTag(b)}（${spec ? spec + ' · ' : ''}${bal}）`
}

async function submit() {
  if (!props.from) return
  if (!form.toAccountId) {
    ElMessage.warning('请选择转入账本')
    return
  }
  const h = Number(form.hours) || 0
  if (h <= 0) {
    ElMessage.warning('请填写要转的小时数（大于 0）')
    return
  }
  transferring.value = true
  try {
    await transferAccount({
      fromAccountId: props.from.id,
      toAccountId: form.toAccountId,
      hours: h,
      occurDate: form.occurDate || undefined,
      note: form.note.trim() || undefined,
    })
    ElMessage.success('已转出：两本账各产生一条互指的调整行，来去都查得到')
    visible.value = false
    emit('done')
  } catch {
    // 拦截器已弹错误（余额守卫/归属校验都在 BE）
  } finally {
    transferring.value = false
  }
}
</script>

<template>
  <el-dialog v-model="visible" title="转到其他账本" width="480px" append-to-body>
    <el-form label-width="86px">
      <el-form-item label="转出账本">
        <span class="ro">{{ from ? bookTag(from) : '—' }}</span>
        <span v-if="from" class="fh">当前 {{ fmtNum(from.hoursRemain) }} 小时</span>
      </el-form-item>
      <el-form-item label="转入账本">
        <el-select v-model="form.toAccountId" placeholder="选择我的其他账本" style="width: 100%">
          <el-option v-for="b in targets" :key="b.id" :value="b.id" :label="bookOption(b)" />
        </el-select>
      </el-form-item>
      <el-form-item label="转多少">
        <el-input-number v-model="form.hours" :min="0" :precision="2" :step="1" style="width: 180px" />
        <span class="fh">小时</span>
      </el-form-item>
      <el-form-item label="业务日期">
        <el-date-picker
          v-model="form.occurDate"
          type="date"
          value-format="YYYY-MM-DD"
          placeholder="选择日期"
          style="width: 180px"
        />
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="form.note" maxlength="200" placeholder="例如：改绑到新账本 / 拆出好好的部分" />
      </el-form-item>
      <el-form-item label=" ">
        <span class="fh">
          两本账各记一条互指的调整行；两本账每节价不一样时，金额天然不守恒（同样的小时在新账本按新价算钱）
        </span>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="transferring" @click="submit">确认转移</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.ro {
  font-size: 13px;
  font-weight: 600;
  color: var(--bk-teal-deep);
}
.fh {
  margin-left: 10px;
  font-size: 12px;
  color: #8ba09a;
  line-height: 1.6;
}
</style>
