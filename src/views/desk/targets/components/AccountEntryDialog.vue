<script setup lang="ts">
/**
 * PRD-018 批3 · 课时账本录入弹窗（四态共用一个壳，对照设计稿 ③④）→ **批5 D11/D12 改造**。
 * - open      开通学科账户：学科 + 每节时长 + 每节价，底部折叠「记入已有账本」
 * - price     改计价：学科只读，改每节时长 + 每节价
 * - recharge  充值：三档任填一档（小时 / 节 / 金额）+ 业务日期
 * - adjust    调整：同 recharge，允许负数
 *
 * 🔴 D1 v2.1：底账只记小时。三档换算<b>只在前端做给人看</b>，落库只发老师选中的那一档
 *    （发三个 BE 得猜以谁为准，等于把口径决定权丢给服务端）。
 * 🔴 **D11（批5）**：用户可见面只有「每节 X 小时 · Y 元/节」，按小时计价的说法一律不上屏。
 *    输入也按这两个值收，提交前换算成内部计价参数 `pricePerHour = 每节价 ÷ 每节时长`
 *    （唯一换算入口 = `toPricePerHour`，**保 4 位**：350 ÷ 1.5 = 233.3333，砍两位每笔差几分）。
 * 🔴 **D12（批5）**：`studentId` 改为可选 —— 「课时账单」页开户时没有学生上下文，
 *    本弹窗自带学生选择器（选完即时拉该生已开学科，避免重复开同一科）。
 * 🔴 AC9：金额档把老师输入的钱原样带 `amountPaid`——收 3500 台账就显示 3500 整，
 *    不能让派生尾差替老师改写他真收到的数。
 * 🔴 D9：`occurDate` 业务日期默认今天、可回填历史；台账按它排序而不是按写入时间，
 *    所以补录一笔旧充值后，它后面每一行的剩余都会自动重算。
 * 🔴 D4 规则②：共享账本（`account.shared`）多人每节时长不同 → 基准不唯一，「按节」档禁用。
 * 🔴 余额允许为负（欠费不拦截，老师最高权限）——本弹窗不做余额充足性校验。
 */
import { ref, reactive, computed, watch } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { useDictStore, DICT_EDU_SUBJECT } from '@/store/dict'
import {
  upsertAccount,
  addAccountFlow,
  listAccounts,
  listMyAccountBooks,
  type TuitionAccountVO,
  type TuitionFlowBo,
  type AccountBookVO,
} from '@/api/teacher/account'
import { pageTargets } from '@/api/teacher/schedule'
import { useTuitionUnit, todayStr } from '@/composables/useTuitionUnit'

type Mode = 'open' | 'price' | 'recharge' | 'adjust'
/** 三档输入：h 小时 / j 节 / y 金额 */
type Tab = 'h' | 'j' | 'y'

const props = defineProps<{
  modelValue: boolean
  mode: Mode
  /** 🔄 批5：可选 —— 不传（课时账单页开户）时本弹窗自带学生选择器 */
  studentId?: string
  /** price / recharge / adjust 模式下的目标账本绑定 */
  account?: TuitionAccountVO | null
  /** open 模式下已开户学科码（下拉里排除，改计价走行内「改计价」入口） */
  openedSubjects?: string[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'saved'): void
}>()

const { fmtNum, fmtMoney, toLessonPrice, toPricePerHour, priceSpecText } = useTuitionUnit()

const dict = useDictStore()
dict.load(DICT_EDU_SUBJECT)

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

// ── 学生：父级给了就锁定，没给就本弹窗自选（D12 账单页开户）───────────────
const students = ref<{ id: string; name: string }[]>([])
const pickedStudentId = ref('')
/** 自选学生时该生已开的学科（父级传了 studentId 就吃 props.openedSubjects） */
const pickedOpened = ref<string[]>([])

const selfPick = computed(() => !props.studentId)
const effStudentId = computed(() => props.studentId || pickedStudentId.value)

async function loadStudents() {
  try {
    const res = await pageTargets({ targetType: '0', pageSize: 500 })
    students.value = (res?.rows ?? []).map((s) => ({ id: s.id, name: s.name }))
  } catch {
    students.value = []
  }
}

/** 换学生 → 重新拉他已开的学科（同一科重复开会撞 uk，不如直接从候选里拿掉） */
watch(pickedStudentId, async (id) => {
  pickedOpened.value = []
  if (!id) return
  try {
    pickedOpened.value = ((await listAccounts(id)) ?? []).map((a) => a.subject)
  } catch {
    pickedOpened.value = []
  }
})

const openedList = computed(() => (selfPick.value ? pickedOpened.value : props.openedSubjects || []))

const SUBJECT_OPTIONS = computed(() =>
  dict.list(DICT_EDU_SUBJECT).filter((d) => !openedList.value.includes(d.dictValue)),
)

const title = computed(() => {
  if (props.mode === 'open') return '开通学科账户'
  const s = props.account?.subjectLabel || props.account?.subject || ''
  const suffix = s ? ' · ' + s : ''
  if (props.mode === 'price') return `改计价${suffix}`
  return props.mode === 'recharge' ? `充值${suffix}` : `调整${suffix}`
})

/** 学科/计价表单（open 与 price 共用），流水表单（recharge / adjust）另一套 */
const isPriceForm = computed(() => props.mode === 'open' || props.mode === 'price')

const formRef = ref<FormInstance>()
const submitting = ref(false)

const form = reactive({
  subject: '',
  /** 每节价 元/节（D11 对外唯一价格口径；提交前折成内部 pricePerHour） */
  lessonPrice: 0,
  /** 每节时长 小时（落在绑定层，既是折节基准也是结算默认扣时） */
  hoursPerLesson: 1,
  /** 记入已有账本：非空 = 只建绑定不新开本，计价跟账本走 */
  accountId: '',
  /** 三档输入 */
  tab: 'h' as Tab,
  val: 0,
  occurDate: todayStr(),
  note: '',
})

const rules = computed<FormRules>(() =>
  props.mode === 'open'
    ? {
        subject: [{ required: true, message: '请选择学科', trigger: 'change' }],
      }
    : {},
)

// ── open 态：「记入已有账本」折叠区 ────────────────────────────────────────
// 默认收起 = 新开一本（普通学生一步完成、无感知）；展开才是手动绑定入口。
const books = ref<AccountBookVO[]>([])
const booksLoading = ref(false)
const foldOpen = ref(false)

async function loadBooks() {
  booksLoading.value = true
  try {
    books.value = (await listMyAccountBooks()) ?? []
  } catch {
    books.value = []
  } finally {
    booksLoading.value = false
  }
}

/** 选中的已有账本（计价跟它走，每节价由「它的内部参数 × 本人每节时长」现算） */
const pickedBook = computed(() => books.value.find((b) => b.id === form.accountId) ?? null)

/** 记入已有账本时，这个学生按自己填的每节时长折出来的每节价 */
const boundLessonPrice = computed(() =>
  pickedBook.value ? toLessonPrice(pickedBook.value.pricePerHour, Number(form.hoursPerLesson) || 0) : null,
)

// ── 三档换算（D9）────────────────────────────────────────────────────────
/** 每节时长基准；共享账本基准不唯一 → null，「按节」档不可用 */
const perLesson = computed<number | null>(() => {
  const a = props.account
  if (!a || a.shared) return null
  return a.hoursPerLesson && a.hoursPerLesson > 0 ? a.hoursPerLesson : null
})
/** 内部计价参数（不上屏，只用来把金额档折成小时） */
const pricePerHour = computed(() => props.account?.pricePerHour ?? 0)
const canLessonTab = computed(() => perLesson.value !== null)
const canAmountTab = computed(() => pricePerHour.value > 0)

/** 老师输入的那一档 → 小时（底账单位）；另两档由它算出来只作展示 */
const hoursOfInput = computed(() => {
  const v = Number(form.val) || 0
  if (form.tab === 'j') return v * (perLesson.value ?? 1)
  if (form.tab === 'y') return pricePerHour.value > 0 ? v / pricePerHour.value : 0
  return v
})
const lessonsOfInput = computed(() =>
  perLesson.value ? hoursOfInput.value / perLesson.value : 0,
)
const amountOfInput = computed(() =>
  form.tab === 'y' ? Number(form.val) || 0 : hoursOfInput.value * pricePerHour.value,
)

const tabUnit = computed(() => (form.tab === 'h' ? '小时' : form.tab === 'j' ? '节' : '元'))

/** 换算行：显示另外两档（选中那档不重复报） */
const convText = computed(() => {
  const parts: string[] = []
  if (form.tab !== 'h') parts.push(`${fmtNum(hoursOfInput.value)} 小时`)
  if (form.tab !== 'j' && perLesson.value) parts.push(`${fmtNum(lessonsOfInput.value)} 节`)
  if (form.tab !== 'y' && pricePerHour.value > 0) parts.push(`${fmtNum(amountOfInput.value)} 元`)
  return parts.length ? '= ' + parts.join(' = ') : ''
})

/** 折算依据：D11 口径只报「每节 X 小时 · Y 元/节」 */
const convHint = computed(() => {
  const spec = priceSpecText(pricePerHour.value, perLesson.value)
  return spec ? `按${spec}折算` : ''
})

/** 当前余额小抬头（设计稿 ③ 的 .msub） */
const balanceText = computed(() => {
  const a = props.account
  if (!a) return ''
  const h = `${fmtNum(a.hoursRemain)} 小时`
  const j = perLesson.value ? `（${fmtNum(a.hoursRemain / perLesson.value)} 节）` : ''
  return `当前剩余 ${h}${j} · 约 ${fmtMoney(a.amountRemain)}`
})

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    formRef.value?.clearValidate()
    const a = props.account
    // 改计价：学科与现价从目标绑定回填（学科锁死——换学科等于挂到另一科，余额会挂错账）
    form.subject = props.mode === 'price' ? (a?.subject ?? '') : ''
    form.hoursPerLesson = props.mode === 'price' ? (a?.hoursPerLesson || 1) : 1
    // 每节价 = 内部参数 × 每节时长（233.3333 × 1.5 = 350，原样还回来）
    form.lessonPrice =
      props.mode === 'price' ? (toLessonPrice(a?.pricePerHour, a?.hoursPerLesson) ?? 0) : 0
    form.accountId = ''
    foldOpen.value = false
    // 默认档：共享账本折不了节 → 落回小时
    form.tab = canLessonTab.value ? 'j' : 'h'
    form.val = 0
    form.occurDate = todayStr()
    form.note = ''
    if (props.mode === 'open') {
      void loadBooks()
      if (selfPick.value) {
        pickedStudentId.value = ''
        pickedOpened.value = []
        void loadStudents()
      }
    }
  },
)

/** 换档时清空输入：把上一档的数字留在框里换个单位读，是账目事故的温床 */
watch(
  () => form.tab,
  () => {
    form.val = 0
  },
)

async function submit() {
  const ok = await formRef.value?.validate().catch(() => false)
  if (!ok) return
  submitting.value = true
  try {
    if (isPriceForm.value) {
      await submitBook()
    } else {
      await submitFlow()
    }
  } catch {
    // request 拦截器已弹错误 toast
  } finally {
    submitting.value = false
  }
}

/** open / price：建本+绑定 或 改计价（每节时长 + 每节价） */
async function submitBook() {
  const studentId = effStudentId.value
  if (!studentId) {
    ElMessage.warning('请选择学生')
    return
  }
  // price 态 subject 来自目标绑定（模板里只读展示），命中 uk = 改计价、不动余额
  const subject = props.mode === 'price' ? (props.account?.subject ?? '') : form.subject
  if (!subject) {
    ElMessage.warning('缺少学科，无法保存')
    return
  }
  const hpl = Number(form.hoursPerLesson) || 0
  if (hpl <= 0) {
    ElMessage.warning('每节时长必须大于 0 小时')
    return
  }
  await upsertAccount({
    studentId,
    subject,
    // 🔴 D11 换算唯一出口：每节价 ÷ 每节时长 → 内部计价参数（保 4 位，350÷1.5=233.3333）
    // 记入已有账本时不传：一本账一个价，跟账本走（传了会把那本账的价改掉）
    pricePerHour: form.accountId ? undefined : toPricePerHour(form.lessonPrice, hpl),
    hoursPerLesson: hpl,
    accountId: form.accountId || undefined,
  })
  ElMessage.success(
    props.mode === 'price'
      ? '计价已更新（不影响已扣的历史记录）'
      : form.accountId
        ? '已记入所选账本'
        : '账户已开通',
  )
  emit('saved')
  visible.value = false
}

/** recharge / adjust：只发老师选中的那一档 */
async function submitFlow() {
  if (!props.account) return
  const v = Number(form.val) || 0
  if (!v) {
    ElMessage.warning('请填写数量')
    return
  }
  if (props.mode === 'recharge' && v < 0) {
    ElMessage.warning('充值只能填正数；要扣回请用「调整」')
    return
  }
  const bo: TuitionFlowBo = {
    flowType: props.mode === 'recharge' ? '1' : '4',
    occurDate: form.occurDate || undefined,
    note: form.note.trim() || undefined,
  }
  if (form.tab === 'h') {
    bo.hours = v
  } else if (form.tab === 'j') {
    bo.lessons = v
  } else {
    bo.amount = v
    // AC9：实收原样落库，不让派生尾差替老师改写他真收到的钱
    bo.amountPaid = v
  }
  await addAccountFlow(props.account.id, bo)
  ElMessage.success(props.mode === 'recharge' ? '充值已记入' : '调整已记入')
  emit('saved')
  visible.value = false
}
</script>

<template>
  <el-dialog v-model="visible" :title="title" width="480px" append-to-body :close-on-click-modal="false">
    <el-form ref="formRef" :model="form" :rules="rules" label-width="86px">
      <template v-if="isPriceForm">
        <!-- D12：账单页开户没有学生上下文 → 本弹窗自己选 -->
        <el-form-item v-if="mode === 'open' && selfPick" label="学生">
          <el-select
            v-model="pickedStudentId"
            filterable
            placeholder="选择学生"
            style="width: 100%"
          >
            <el-option v-for="s in students" :key="s.id" :label="s.name" :value="s.id" />
          </el-select>
        </el-form-item>

        <el-form-item v-if="mode === 'open'" label="学科" prop="subject">
          <el-select v-model="form.subject" placeholder="选择学科" style="width: 100%">
            <el-option v-for="d in SUBJECT_OPTIONS" :key="d.dictValue" :label="d.dictLabel" :value="d.dictValue" />
          </el-select>
          <span class="fh block">
            开通即绑定该学科：系统开一本账，并把这个学生的这一科挂上去，一步完成；之后能给这科建计划、记课时课费
          </span>
        </el-form-item>
        <!-- 改计价：学科只读——换学科等于挂到另一科，余额会挂错账 -->
        <el-form-item v-else label="学科">
          <span class="ro">{{ account?.subjectLabel || account?.subject || '—' }}</span>
        </el-form-item>

        <el-form-item label="每节时长">
          <el-input-number v-model="form.hoursPerLesson" :min="0.25" :precision="2" :step="0.5" style="width: 180px" />
          <span class="fh">小时 / 节</span>
          <span class="fh block">与家长约定的一节课多长（如 1.5 小时）；结算默认按它扣，也是「节」的折算基准</span>
        </el-form-item>

        <el-form-item label="每节价">
          <el-input-number
            v-model="form.lessonPrice"
            :min="0"
            :precision="2"
            :step="50"
            :disabled="!!form.accountId"
            style="width: 180px"
          />
          <span class="fh">元 / 节</span>
          <span v-if="form.accountId" class="fh block">
            价格跟所选账本走，这里不改<template v-if="boundLessonPrice !== null">
              —— 按你填的每节时长算 = {{ fmtNum(boundLessonPrice) }} 元/节</template>
          </span>
        </el-form-item>

        <el-form-item v-if="mode === 'price'" label=" ">
          <span class="fh">改后只影响以后结算的场次；已扣过的记录按当时金额留档，不回溯</span>
        </el-form-item>

        <!-- 记入已有账本（默认收起 = 新开一本）：几个学生记同一本账的入口 -->
        <el-form-item v-if="mode === 'open'" label=" ">
          <div class="fold" v-loading="booksLoading">
            <div class="fold-h" @click="foldOpen = !foldOpen">
              <span class="arr">{{ foldOpen ? '▾' : '▸' }}</span>
              记入已有账本
              <span class="tip">不选就新开一本（默认）</span>
            </div>
            <template v-if="foldOpen">
              <el-radio-group v-model="form.accountId" class="fold-body">
                <el-radio value="">新开一本账</el-radio>
                <el-radio v-for="b in books" :key="b.id" :value="b.id">
                  {{ b.name || b.studentNames.join('+') || '账本 #' + b.id }}
                  <i class="om" :class="{ neg: (b.hoursRemain ?? 0) < 0 }">
                    {{ (b.hoursRemain ?? 0) < 0 ? '欠' : '余' }} {{ fmtNum(Math.abs(b.hoursRemain ?? 0)) }} 小时
                  </i>
                </el-radio>
              </el-radio-group>
              <span class="fh block">
                选了已有账本，这个学生的课就记进那本账；价格跟账本走，这里只填每节时长
              </span>
            </template>
          </div>
        </el-form-item>
      </template>

      <template v-else>
        <el-form-item label=" ">
          <span class="fh">{{ balanceText }}；余额为负时充值自动补平</span>
        </el-form-item>

        <!-- 三档输入（D9）：输一档，另两档实时换算显示；落库只发选中那一档 -->
        <el-form-item label="数量">
          <div class="amt">
            <el-radio-group v-model="form.tab" size="small">
              <el-radio-button value="h">按小时</el-radio-button>
              <el-radio-button value="j" :disabled="!canLessonTab">按节</el-radio-button>
              <el-radio-button value="y" :disabled="!canAmountTab">按金额</el-radio-button>
            </el-radio-group>
            <div class="amt-in">
              <el-input-number
                v-model="form.val"
                :precision="2"
                :step="form.tab === 'y' ? 100 : 1"
                :min="mode === 'recharge' ? 0 : undefined"
                :controls="false"
                class="big"
              />
              <span class="amt-u">{{ tabUnit }}</span>
            </div>
            <div v-if="convText" class="conv">
              {{ convText }}
              <i v-if="convHint">{{ convHint }}</i>
            </div>
            <span v-if="!canLessonTab" class="fh block">
              这本账绑了不止一个学生，每人每节时长不一样 —— 折不出统一的「节」，请按小时或金额填
            </span>
            <span class="fh block">{{ mode === 'adjust' ? '可填负数（扣回）' : '要扣回请用「调整」' }}</span>
          </div>
        </el-form-item>

        <!-- 业务日期（D9）：台账按它排序，补录旧充值后其后每行剩余自动重算 -->
        <el-form-item label="业务日期">
          <el-date-picker
            v-model="form.occurDate"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="选择日期"
            style="width: 180px"
          />
          <span v-if="form.occurDate === todayStr()" class="today">今天</span>
          <span class="fh block">补记以前的充值，就把日期改到当天</span>
        </el-form-item>

        <el-form-item label="备注">
          <el-input v-model="form.note" maxlength="200" placeholder="例如：微信转账 3500 / 补记 7-28 少上的一节" />
        </el-form-item>
      </template>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="submit">
        {{ mode === 'recharge' ? '确认充值' : '保存' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.fh {
  margin-left: 10px;
  font-size: 12px;
  color: #8ba09a;
}
.fh.block {
  display: block;
  margin-left: 0;
  line-height: 1.6;
}
.ro {
  font-size: 13px;
  font-weight: 600;
  color: var(--bk-teal-deep);
}
.today {
  margin-left: 8px;
  font-size: 11px;
  color: var(--bk-teal-deep);
  background: var(--bk-teal-soft);
  border-radius: 99px;
  padding: 1px 8px;
}
/* 三档输入区 */
.amt {
  width: 100%;
}
.amt-in {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.amt-in :deep(.big) {
  width: 190px;
}
.amt-in :deep(.big .el-input__inner) {
  font-size: 22px;
  font-weight: 800;
  text-align: left;
  color: var(--bk-ink);
  font-variant-numeric: tabular-nums;
}
.amt-u {
  font-size: 13px;
  color: #5f716d;
}
.conv {
  margin-top: 8px;
  padding: 6px 12px;
  border-radius: 8px;
  background: var(--bk-teal-soft);
  color: var(--bk-teal-deep);
  font-size: 13px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.conv i {
  display: block;
  margin-top: 2px;
  font-style: normal;
  font-size: 11.5px;
  font-weight: 400;
  color: #6fa898;
}
/* 记入已有账本折叠区 */
.fold {
  width: 100%;
  border: 1px dashed #c4d2cc;
  border-radius: 10px;
  padding: 8px 10px;
  background: #fafcfb;
}
.fold-h {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: #5f716d;
  cursor: pointer;
  line-height: 1.6;
}
.fold-h .arr {
  color: #8ba09a;
}
.fold-h .tip {
  margin-left: auto;
  font-size: 11px;
  color: #8ba09a;
}
.fold-body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  margin-top: 6px;
}
.fold-body .om {
  font-style: normal;
  font-size: 11px;
  color: #8ba09a;
  margin-left: 6px;
  font-variant-numeric: tabular-nums;
}
.fold-body .om.neg {
  color: #be123c;
}
</style>
