<script setup lang="ts">
/**
 * PRD-C-213 FP12 · 建档 / 编辑弹窗（学生与班级两套字段）。
 * - create：createTarget → 若班级且选了学员再 setClassStudents。
 * - edit：updateTarget（targetType 不可改）→ 若班级同步 setClassStudents。
 * 班级隐藏 教材版本 / parentPhone；color 可选（留空则服务端色板轮转）。
 * 🔴 R1a 建模：年级=gradeNo 数字码 + gradeYear（隐藏缺省当年）；学科/教材版本=字典码；
 *    显示层用 BE 推导串（VO grade/textbook/subjectLabel），本弹窗只管写原始码。
 *
 * PRD-015 bug 批 BUG-4/C「建档一体」：新建学生时可<b>顺手</b>录课时账本（学科+每节时长+每节价+初始充值，
 * 可多科），保存链 = 建档成功 → 逐科 upsertAccount → 有初始小时就 addAccountFlow('1' 充值)。
 * 🔴 可跳过（拍板 C）：试听生先建档、回头再开户；学科留空的行直接忽略。
 * 🔴 只复用既有 api，不造新端点；建档已成功而开户失败 <b>不回滚建档</b>——只报哪几科没开成，
 *    让老师去学生详情补，绝不把一个已经建好的学生悄悄删掉。
 * 🔴 编辑态不重复做账户管理：只列已有账本 +「去详情管理」跳转（正本 = 学生详情 AccountPanel）。
 *
 * 🔄 PRD-018 批3/批5：单价（元/课时）换轨成<b>每节时长 + 每节价（元/节，D11 对外唯一价格口径）</b>；
 *    提交前折成内部计价参数（`toPricePerHour`，保 4 位）。初始额只填小时数，
 *    实收金额选填并原样落 `amountPaid`（AC9：收 3500 就记 3500，不用派生尾差倒推）。
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
import { listAccounts, upsertAccount, addAccountFlow, type TuitionAccountVO } from '@/api/teacher/account'
import { useDictStore, DICT_EDU_GRADE, DICT_EDU_SUBJECT, DICT_EDU_EDITION } from '@/store/dict'
import { useTuitionUnit, todayStr } from '@/composables/useTuitionUnit'

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
  /** 编辑态「去详情管理」：父级选中该对象展开详情面板（账户管理正本在那儿） */
  (e: 'go-detail', id: string): void
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

// ── PRD-015 BUG-4/C 课时账本段（PRD-018 换轨成每节时长 + 每节价）──────────
const { d, fmtMoney, priceSpecText, toPricePerHour } = useTuitionUnit()

/** 建档时顺手开的账本行（学科留空=这行不开，整段可跳过） */
interface AcctDraft {
  subject: string
  /** 每节价 元/节（D11 对外唯一价格口径；提交前折成内部 pricePerHour） */
  lessonPrice: number
  /** 每节时长 小时（落绑定层，结算默认按它扣） */
  hoursPerLesson: number
  /** 初始充值小时数（底账只记小时） */
  hours: number
  /** 实收金额，选填；给了就原样落库（AC9） */
  amountPaid: number
}

/** 折节基准；共享账本基准不唯一 → null（D4 规则②） */
function perLessonOf(a: TuitionAccountVO): number | null {
  if (a.shared) return null
  return a.hoursPerLesson && a.hoursPerLesson > 0 ? a.hoursPerLesson : null
}

const acctRows = ref<AcctDraft[]>([])
/** 编辑态：该生已有账户（只读简行 +「去详情管理」，本弹窗不做完整管理） */
const existAccounts = ref<TuitionAccountVO[]>([])
const acctLoading = ref(false)

/** 学生才有账户段（班课收费模型未拍，PRD-015 §9） */
const showAcct = computed(() => !isClass.value)

function newAcctRow(): AcctDraft {
  return { subject: '', lessonPrice: 0, hoursPerLesson: 1, hours: 0, amountPaid: 0 }
}

function addAcctRow() {
  acctRows.value.push(newAcctRow())
}

function removeAcctRow(i: number) {
  acctRows.value.splice(i, 1)
}

/** 某行的可选学科 = 全字典 − 其它行已选（同一学科只能一个账户，uk_student_subject） */
function subjectOptionsFor(i: number) {
  const taken = new Set(acctRows.value.filter((_, j) => j !== i).map((r) => r.subject).filter(Boolean))
  return SUBJECT_OPTIONS.value.filter((d) => !taken.has(d.dictValue))
}

// 上面选了主科 → 首个空账户行自动跟上（只填空行，不覆盖老师已选的）
watch(
  () => form.subject,
  (s) => {
    if (!s || props.mode !== 'create') return
    const first = acctRows.value[0]
    if (first && !first.subject) first.subject = s
  },
)

async function loadExistAccounts(id: string) {
  acctLoading.value = true
  try {
    existAccounts.value = (await listAccounts(id)) ?? []
  } catch {
    existAccounts.value = []
  } finally {
    acctLoading.value = false
  }
}

/**
 * 建档后逐科开户 + 首充。
 * 🔴 建档已成功，这里失败绝不回滚建档——把没开成的学科报出来，让老师去详情补开。
 * @return 未开成功的学科标签
 */
async function createAccounts(studentId: string): Promise<string[]> {
  const failed: string[] = []
  for (const r of acctRows.value) {
    if (!r.subject) continue
    try {
      const hpl = Number(r.hoursPerLesson) || 1
      const res = await upsertAccount({
        studentId,
        subject: r.subject,
        // D11：表单收「每节价」，落库前折成内部计价参数（保 4 位，350÷1.5=233.3333）
        pricePerHour: toPricePerHour(r.lessonPrice, hpl),
        hoursPerLesson: hpl,
      })
      const hours = Number(r.hours) || 0
      const paid = Number(r.amountPaid) || 0
      // 初始额 = 一笔充值流水（余额只能经流水产生，D1 铁律；不裸改余额列）
      if (hours) {
        await addAccountFlow(res.id, {
          flowType: '1',
          hours,
          // 实收给了就原样落（AC9）；没给走「小时 × 账本计价」派生
          amountPaid: paid || undefined,
          occurDate: todayStr(),
          note: '建档初始',
        })
      }
    } catch (e) {
      console.warn('[target-edit] 开户失败 subject=', r.subject, e)
      failed.push(dict.label(DICT_EDU_SUBJECT, r.subject) || r.subject)
    }
  }
  return failed
}

function resetFrom() {
  // 账户段：新建=一行空白（可跳过）；编辑=拉已有账户只读展示
  existAccounts.value = []
  acctRows.value = props.mode === 'create' && !isClass.value ? [newAcctRow()] : []
  if (props.mode === 'edit' && props.detail && !isClass.value) {
    void loadExistAccounts(props.detail.id)
  }
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
  // 同一学科只能开一个账户（uk_student_subject）；两行同科会把第二行当改单价 + 重复充值
  const picked = acctRows.value.map((r) => r.subject).filter(Boolean)
  if (new Set(picked).size !== picked.length) {
    ElMessage.warning('同一学科只能开一个账户，请合并重复的行')
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
    // PRD-015 BUG-4/C：建档一体——新建学生时顺手开户 + 首充（编辑态账户在详情面板改）
    let acctFailed: string[] = []
    if (props.mode === 'create' && !isClass.value && id) {
      acctFailed = await createAccounts(id)
    }
    if (acctFailed.length) {
      // 学生已经建好了，只是账户没开成 —— 说清楚是哪几科，别让人以为整单失败
      ElMessage.warning(`已建档，但 ${acctFailed.join('、')} 账户没开成功，请到学生详情「课时账户」补开`)
    } else {
      ElMessage.success(props.mode === 'create' ? '已建档' : '已保存')
    }
    emit('saved', id)
    emit('update:modelValue', false)
  } finally {
    saving.value = false
  }
}

function goDetail() {
  const id = props.detail?.id
  if (!id) return
  emit('update:modelValue', false)
  emit('go-detail', id)
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
      <!-- PRD-015 BUG-4/C 课时账本（学生专有；可跳过） -->
      <template v-if="showAcct">
        <!-- 新建：顺手开本 + 首充，可加多科 -->
        <el-form-item v-if="mode === 'create'" label="课时账本">
          <div class="acct-block">
            <div v-for="(r, i) in acctRows" :key="i" class="acct-line">
              <el-select v-model="r.subject" clearable placeholder="学科" class="a-subj">
                <el-option
                  v-for="s in subjectOptionsFor(i)"
                  :key="s.dictValue"
                  :label="s.dictLabel"
                  :value="s.dictValue"
                />
              </el-select>
              <el-input-number
                v-model="r.hoursPerLesson"
                :min="0.25"
                :precision="2"
                :step="0.5"
                :controls="false"
                class="a-num"
                placeholder="每节"
              />
              <span class="a-u">小时/节</span>
              <el-input-number
                v-model="r.lessonPrice"
                :min="0"
                :precision="2"
                :step="50"
                :controls="false"
                class="a-num"
                placeholder="每节价"
              />
              <span class="a-u">元/节</span>
              <el-input-number
                v-model="r.hours"
                :min="0"
                :precision="2"
                :step="1"
                :controls="false"
                class="a-num"
                placeholder="初始"
              />
              <span class="a-u">小时</span>
              <el-input-number
                v-model="r.amountPaid"
                :min="0"
                :precision="2"
                :step="100"
                :controls="false"
                class="a-num"
                placeholder="实收"
              />
              <span class="a-u">元</span>
              <el-button v-if="acctRows.length > 1" size="small" text @click="removeAcctRow(i)">删</el-button>
            </div>
            <div class="acct-foot">
              <el-button size="small" text bg @click="addAcctRow">＋ 再加一科</el-button>
              <span class="a-hint">
                不填学科就跳过，回头在学生详情「课时账户」里开也一样；实收金额选填，填了台账就按这个数显示
              </span>
            </div>
          </div>
        </el-form-item>

        <!-- 编辑：只列已有账本，管理去详情面板（不在这儿重复做一套） -->
        <el-form-item v-else label="课时账本">
          <div class="acct-block" v-loading="acctLoading">
            <div v-if="existAccounts.length" class="acct-exist">
              <span v-for="a in existAccounts" :key="a.id" class="a-tag" :class="{ off: a.status === '1' }">
                {{ a.subjectLabel || a.subject }} · {{ priceSpecText(a.pricePerHour, a.hoursPerLesson) }} ·
                余 {{ d(a.hoursRemain, perLessonOf(a)).full }} · 约 {{ fmtMoney(a.amountRemain) }}
                <i v-if="a.status === '1'">（已停用）</i>
              </span>
            </div>
            <span v-else-if="!acctLoading" class="a-hint">还没有账本</span>
            <div class="acct-foot">
              <el-button size="small" text bg @click="goDetail">去详情管理</el-button>
              <span class="a-hint">开户 / 充值 / 调整 / 改计价 / 停用都在学生详情的「课时账户」区块</span>
            </div>
          </div>
        </el-form-item>
      </template>

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
/* PRD-015 BUG-4/C 课时账户段 */
.acct-block {
  width: 100%;
}
/* 四个数字格（每节/每节价/初始/实收）超出一行就换行，别把弹窗撑破 */
.acct-line {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.acct-line .a-subj {
  width: 90px;
  flex: none;
}
.acct-line :deep(.a-num) {
  width: 68px;
  flex: none;
}
.acct-line :deep(.a-num .el-input__inner) {
  text-align: left;
}
.a-u {
  font-size: 12px;
  color: #8ba09a;
  flex: none;
}
.acct-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.a-hint {
  font-size: 12px;
  color: #8ba09a;
  line-height: 1.5;
}
.acct-exist {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.a-tag {
  font-size: 12px;
  color: var(--bk-teal-deep);
  background: #e8f2f0;
  border-radius: 99px;
  padding: 2px 10px;
}
.a-tag.off {
  color: #7d8f8b;
  background: #eef1f0;
}
.a-tag i {
  font-style: normal;
  color: #a96f14;
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
