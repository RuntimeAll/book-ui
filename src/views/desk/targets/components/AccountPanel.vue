<script setup lang="ts">
/**
 * PRD-018 批3 · 学生详情「课时账户」区块 → **批5 D11/D12 改造**。
 *
 * 一科一行：学科 chip / 余额双单位 / 约当金额 / 计价（每节 X 小时 · Y 元/节）+ 行内 meta
 *   （账本 · 每节时长 · 共享学生）+「记录」（台账抽屉）/「充值」/「调整」/「改计价」/「停用」/「删除」。
 *
 * 🔴 **D12 起本区块不再是账单主场** —— 账单有了自己的一等页面 `/desk/account`（我的全部账本 +
 *    台账 + 转账 + 开户全在那儿收口）。这里只留「这个学生这几科的账」这一层摘要 + 常用写操作，
 *    区头与台账抽屉都给出「在课时账单页打开」直达（带 `accountId` 落到那本账的选中态）。
 *    原「我的全部账本」弹窗随之退役 —— 它的能力就是账单页左栏，留着等于两套列表各漂各的。
 * 🔴 **台账本体与转账弹窗都是共用组件**（`views/desk/account/components/`），本文件不再自带一份
 *    表格实现：正序/期初行/默认末页/折节这套口径只能有一处，复制粘贴迟早对不上账。
 * 🔴 **D11**：用户可见面不出现按小时计价的说法，一律「每节 X 小时 · Y 元/节」；
 *    共享账本每人每节时长不同 → 折不出唯一每节价，只报余额（`dual()` 传 perLesson=null）。
 * 🔴 金额是派生量（小时 × 内部计价参数），所以文案一律写「约 N 元」——它不是底账，
 *    别让人当收支凭据读。
 * 🔴 停用 vs 删除：停用只是让该科退出建计划/结算，余额流水留档随时可启用；
 *    删除是硬删，BE 只放行零流水账本（有记录一律劝停用），前端不预判、直接吃 BE 的 400 文案。
 * 🔴 班级对象无账户（班课收费模型未拍），父级不渲染本组件。
 */
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  listAccounts,
  listMyAccountBooks,
  setAccountStatus,
  deleteAccount,
  type TuitionAccountVO,
  type AccountBookVO,
} from '@/api/teacher/account'
import { useTuitionUnit } from '@/composables/useTuitionUnit'
import AccountEntryDialog from './AccountEntryDialog.vue'
import TuitionLedger from '@/views/desk/account/components/TuitionLedger.vue'
import AccountTransferDialog from '@/views/desk/account/components/AccountTransferDialog.vue'

const props = defineProps<{
  studentId: string
  studentName?: string
}>()

const emit = defineEmits<{
  /** 账本/余额有变 → 父级刷新卡片（角标、学科 chips） */
  (e: 'changed'): void
}>()

const router = useRouter()
const { unit, setUnit, d, fmtNum, fmtMoney, priceSpecText } = useTuitionUnit()

const accounts = ref<TuitionAccountVO[]>([])
/**
 * 我的全部账本 —— 账户行要显示「这本账还绑了谁」，但 TuitionAccountVO 只到绑定层没有 studentNames，
 * 所以在读取层做一次 accountId 关联（D10 ②：跨域/跨视角聚合只在读取层做，不进写入事务）。
 * 顺带供转移弹窗的「转入账本」下拉用，省一次请求。
 */
const myBooks = ref<AccountBookVO[]>([])
const loading = ref(false)

let seq = 0
async function load() {
  const my = ++seq
  loading.value = true
  try {
    const [rows, books] = await Promise.all([
      listAccounts(props.studentId),
      listMyAccountBooks().catch(() => [] as AccountBookVO[]),
    ])
    if (my !== seq) return
    accounts.value = rows || []
    myBooks.value = books || []
  } catch {
    if (my === seq) accounts.value = []
  } finally {
    if (my === seq) loading.value = false
  }
}
watch(() => props.studentId, load, { immediate: true })

const openedSubjects = computed(() => accounts.value.map((a) => a.subject))

/** 折节基准；共享账本基准不唯一 → null（D4 规则②，dual 自动只出小时） */
function perLessonOf(a: TuitionAccountVO): number | null {
  if (a.shared) return null
  return a.hoursPerLesson && a.hoursPerLesson > 0 ? a.hoursPerLesson : null
}

/** 计价文案（D11）：本人这条绑定的「每节 X 小时 · Y 元/节」 —— 共享本也报得出，因为每节时长在绑定层 */
function priceText(a: TuitionAccountVO): string {
  return priceSpecText(a.pricePerHour, a.hoursPerLesson) || '未设置每节时长'
}

function bookOf(a: TuitionAccountVO): AccountBookVO | null {
  return myBooks.value.find((b) => b.id === a.accountId) ?? null
}

/** 账本显示名：自定义标签 → 共享本拼学生名 → 独立账本 */
function bookName(a: TuitionAccountVO): string {
  const tag = (a.name || bookOf(a)?.name || '').trim()
  if (tag) return tag
  if (!a.shared) return '独立账本'
  const names = (bookOf(a)?.studentNames || []).filter(Boolean)
  return names.length ? names.join('+') : '共享账本'
}

/** 共享账本上另外挂着的学生名（本人除外，本人自己那行不用重复报） */
function otherNames(a: TuitionAccountVO): string[] {
  if (!a.shared) return []
  return (bookOf(a)?.studentNames || []).filter((n) => n && n !== props.studentName)
}

// —— 跳「课时账单」页（D12：账单主场在那边）——
function goBill(accountId?: string) {
  void router.push({ path: '/desk/account', query: accountId ? { accountId } : {} })
}

// —— 录入弹窗（开通 / 改计价 / 充值 / 调整）——
type EntryMode = 'open' | 'price' | 'recharge' | 'adjust'
const entryVisible = ref(false)
const entryMode = ref<EntryMode>('open')
const entryAccount = ref<TuitionAccountVO | null>(null)

function openEntry(mode: EntryMode, acc?: TuitionAccountVO) {
  entryMode.value = mode
  entryAccount.value = acc ?? null
  entryVisible.value = true
}

// —— 停用 / 启用 / 删除 ——
const acting = ref('')

/** 停用 = 退出建计划下拉与结算取价；启用 = 放回来。余额流水一概不动。 */
async function toggleStatus(a: TuitionAccountVO) {
  const disable = a.status !== '1'
  const subj = a.subjectLabel || a.subject
  if (disable) {
    const ok = await ElMessageBox.confirm(
      `停用后「${subj}」不再出现在建计划的学科里，这科的课也无法结算。余额和记录都保留，随时可以再启用。`,
      `停用 ${subj} 账户`,
      { type: 'warning', confirmButtonText: '停用', cancelButtonText: '取消' },
    ).catch(() => false)
    if (!ok) return
  }
  acting.value = a.id
  try {
    await setAccountStatus(a.id, disable ? '1' : '0')
    ElMessage.success(disable ? '已停用' : '已启用')
    await load()
    emit('changed')
  } catch {
    // request 拦截器已弹错误 toast
  } finally {
    acting.value = ''
  }
}

/** 删本：只有零流水的才删得掉（开错学科当场删），有记录 BE 返 400 劝停用。 */
async function removeAccount(a: TuitionAccountVO) {
  const subj = a.subjectLabel || a.subject
  const ok = await ElMessageBox.confirm(
    `删除「${subj}」账本。只有从没有过充值/扣课记录的账本才能删；有记录的请改用「停用」。`,
    `删除 ${subj} 账本`,
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
  ).catch(() => false)
  if (!ok) return
  acting.value = a.id
  try {
    await deleteAccount(a.id)
    ElMessage.success('账本已删除')
    await load()
    emit('changed')
  } catch {
    // 有流水 → BE 400「请改为停用」，拦截器已把原文弹出来
  } finally {
    acting.value = ''
  }
}

async function onEntrySaved() {
  await load()
  ledgerRef.value?.reload()
  emit('changed')
}

// ─────────────────────────── 台账抽屉（共用组件）───────────────────────────
const ledgerVisible = ref(false)
const ledgerId = ref('')
const ledgerRef = ref<InstanceType<typeof TuitionLedger> | null>(null)
/** 抽屉标题/绑定描述一律吃台账返回体的 account（账本视角权威），不吃点进来那一行的快照 */
const ledgerBook = ref<AccountBookVO | null>(null)

function openLedger(accountId: string) {
  ledgerId.value = accountId
  ledgerBook.value = null
  ledgerVisible.value = true
}

function onLedgerLoaded(book: AccountBookVO | null) {
  ledgerBook.value = book
}

const ledgerTitle = computed(() => {
  const b = ledgerBook.value
  if (!b) return '课时记录'
  const tag = (b.name || '').trim() || (b.studentNames || []).filter(Boolean).join('+')
  return `课时记录 · ${tag || '账本 #' + b.id}`
})

/** 副标题 = 这本账绑了谁（共享本一眼看出是几个人的合账） */
const ledgerSubtitle = computed(() => {
  const b = ledgerBook.value
  if (!b) return ''
  if (!b.bindings?.length) return '这本账当前没有学生绑定，只作历史记录留档'
  const who = b.bindings
    .map((x) => [x.studentName || '—', x.subjectLabel || x.subject].filter(Boolean).join('（') + '）')
    .join(' · ')
  return b.bindingCount > 1 ? `共 ${b.bindingCount} 人记在这本账上：${who}` : `只有 ${who} 记在这本账上`
})

// ─────────────────────── 换本 / 拆本（M6-2 transfer）───────────────────────
const transferVisible = ref(false)
const transferFrom = ref<AccountBookVO | null>(null)

function openTransferFromLedger() {
  if (ledgerBook.value) {
    transferFrom.value = ledgerBook.value
    transferVisible.value = true
  }
}

async function onTransferDone() {
  await load()
  ledgerRef.value?.reload()
  emit('changed')
}

defineExpose({ reload: load })
</script>

<template>
  <div class="acc-wrap" v-loading="loading">
    <div class="acc-head">
      <span class="acc-eyebrow">课时账户</span>
      <span class="acc-head-acts">
        <!-- D12：账单主场在独立页，这里只做入口 -->
        <el-button size="small" text bg @click="goBill()">在课时账单页打开</el-button>
        <el-button size="small" text bg @click="openEntry('open')">开通学科账户</el-button>
        <!-- D8 全局单位开关：切一次全站联动（落 localStorage，刷新不丢） -->
        <el-radio-group :model-value="unit" size="small" class="unit-seg" @update:model-value="setUnit($event as 'h' | 'j')">
          <el-radio-button value="h">小时</el-radio-button>
          <el-radio-button value="j">节</el-radio-button>
        </el-radio-group>
      </span>
    </div>

    <div v-if="accounts.length" class="acc-list">
      <div v-for="a in accounts" :key="a.id" class="acc-row" :class="{ off: a.status === '1' }">
        <span class="subj">{{ a.subjectLabel || a.subject }}</span>
        <span v-if="a.status === '1'" class="offtag">已停用</span>

        <!-- 余额：双单位并排；共享账本只报小时（perLessonOf 返 null） -->
        <span class="cell bal">
          <i>剩余</i>
          <b :class="{ neg: (a.hoursRemain ?? 0) < 0 }">{{ d(a.hoursRemain, perLessonOf(a)).main }}</b>
          <em v-if="d(a.hoursRemain, perLessonOf(a)).sub">（{{ d(a.hoursRemain, perLessonOf(a)).sub }}）</em>
        </span>
        <!-- 「约」= 这是由课时数派生出来的参考值，不是底账 -->
        <span class="cell">
          <i>约</i>
          <b :class="{ neg: (a.amountRemain ?? 0) < 0 }">{{ fmtMoney(a.amountRemain) }}</b>
        </span>
        <!-- D11：对外只有「每节 X 小时 · Y 元/节」这一种说法 -->
        <span class="cell">
          <i>计价</i>
          <b>{{ priceText(a) }}</b>
        </span>

        <span class="acc-acts">
          <el-button size="small" text bg @click="openLedger(a.accountId)">记录</el-button>
          <el-button size="small" text bg type="primary" @click="openEntry('recharge', a)">充值</el-button>
          <el-button size="small" text bg @click="openEntry('adjust', a)">调整</el-button>
          <el-button size="small" text bg @click="openEntry('price', a)">改计价</el-button>
          <el-button size="small" text bg :loading="acting === a.id" @click="toggleStatus(a)">
            {{ a.status === '1' ? '启用' : '停用' }}
          </el-button>
          <el-button size="small" text bg type="danger" :loading="acting === a.id" @click="removeAccount(a)">
            删除
          </el-button>
        </span>

        <!-- 行内 meta：账本归属（跳账单页）/ 每节时长（点开就是改计价那张壳）/ 共享学生 -->
        <span class="acc-meta">
          <span>账本：<a class="lk" @click="goBill(a.accountId)">{{ bookName(a) }} ↗</a></span>
          <span class="dot">·</span>
          <span>
            每节
            <a class="lk dash" title="点击修改每节时长与每节价" @click="openEntry('price', a)">
              {{ fmtNum(a.hoursPerLesson) }} 小时 ✎
            </a>
          </span>
          <template v-if="otherNames(a).length">
            <span class="dot">·</span>
            <span>与 <b class="who">{{ otherNames(a).join('、') }}</b> 共用这本账</span>
          </template>
        </span>
      </div>
    </div>
    <p v-else class="acc-empty">还没有账户 —— 开通一个学科账户后，就能给这科建计划、记课时和课费。</p>

    <!-- 台账抽屉（账本粒度：一本账一张流水；表格本体 = 与账单页共用的 TuitionLedger） -->
    <el-drawer v-model="ledgerVisible" :title="ledgerTitle" size="880px" append-to-body>
      <div v-if="ledgerBook" class="lg-sub">{{ ledgerSubtitle }}</div>
      <TuitionLedger
        ref="ledgerRef"
        :account-id="ledgerId"
        :page-size="50"
        @loaded="onLedgerLoaded"
      >
        <template #actions>
          <el-button size="small" text bg @click="openTransferFromLedger">转到其他账本</el-button>
          <el-button size="small" text bg @click="goBill(ledgerId)">在课时账单页打开</el-button>
        </template>
      </TuitionLedger>
    </el-drawer>

    <AccountTransferDialog
      v-model="transferVisible"
      :from="transferFrom"
      :books="myBooks"
      @done="onTransferDone"
    />

    <AccountEntryDialog
      v-model="entryVisible"
      :mode="entryMode"
      :student-id="studentId"
      :account="entryAccount"
      :opened-subjects="openedSubjects"
      @saved="onEntrySaved"
    />
  </div>
</template>

<style scoped>
.acc-wrap {
  padding: 14px 20px 16px;
  border-bottom: 1px solid var(--bk-line);
}
.acc-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.acc-eyebrow {
  font-size: 12px;
  font-weight: 700;
  color: #8ba09a;
  letter-spacing: 0.5px;
}
.acc-head-acts {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
}
.unit-seg {
  margin-left: 4px;
}
.acc-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.acc-row {
  display: flex;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
  border: 1px solid var(--bk-line);
  border-radius: 10px;
  padding: 9px 14px;
  background: #fff;
}
/* 停用行：整行降饱和，但数字仍可读（余额还在，只是这科不参与建计划/结算） */
.acc-row.off {
  background: #fafcfb;
  border-style: dashed;
}
.acc-row.off .subj {
  color: #7d8f8b;
  background: #eef1f0;
}
.offtag {
  font-size: 11px;
  color: #a96f14;
  background: #f9f1dd;
  border-radius: 99px;
  padding: 1px 8px;
  flex: none;
}
.subj {
  font-size: 12px;
  font-weight: 700;
  color: var(--bk-teal-deep);
  background: #e8f2f0;
  border-radius: 99px;
  padding: 1px 10px;
  flex: none;
}
.cell {
  display: flex;
  align-items: baseline;
  gap: 4px;
  font-size: 12px;
  color: #8ba09a;
}
.cell b {
  font-size: 14px;
  color: var(--bk-ink);
  font-variant-numeric: tabular-nums;
}
.cell.bal b {
  font-size: 19px;
}
.cell b.neg {
  color: #be123c;
}
.cell em {
  font-style: normal;
}
.acc-acts {
  margin-left: auto;
  display: flex;
  gap: 6px;
}
/* meta 独占一行（flex-basis:100% 换行），与主行用虚线分开 */
.acc-meta {
  flex-basis: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 2px;
  padding-top: 8px;
  border-top: 1px dashed var(--bk-line);
  font-size: 11.5px;
  color: #8ba09a;
}
.acc-meta .dot {
  color: #c4d2cc;
}
.acc-meta .who {
  color: var(--bk-teal-deep);
}
.lk {
  color: var(--bk-teal-deep);
  cursor: pointer;
}
.lk:hover {
  text-decoration: underline;
}
.lk.dash {
  border-bottom: 1px dashed var(--bk-teal);
  padding-bottom: 1px;
}
.acc-empty {
  font-size: 12.5px;
  color: #8ba09a;
}
.lg-sub {
  font-size: 12px;
  color: #8ba09a;
  margin-bottom: 8px;
  line-height: 1.6;
}
</style>
