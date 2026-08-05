<script setup lang="ts">
/**
 * PRD-018 D12 · **课时账单**（一等页面，与「课程计划」平级并列）。
 *
 * > 2026-08-05 用户拍板：「账单单开一个页面和课后计划并行展示」。
 * > 在此之前账单寄居在**学生详情**里：只看得到这个学生挂着的账本，改绑之后旧本就从所有学生页
 * > 消失了（可它上面的冲正退款还在），而且看一眼账要先想起「这本账是谁的」再点进那个学生。
 * > 账本本来就是独立实体（v3 起 `biz_tuition_account` 已经不知道学生是谁），页面结构跟上它。
 *
 * 版面 = 左「我的全部账本」+ 右「选中账本的台账」：
 *   左栏含 **零绑定账本**（M6 ①）—— 改绑后旧本的退款永远查得到、转得走，而不是变成
 *   谁都看不到又删不掉的孤儿；共享账本（绑定数>1）直接把学生名 chips 列在行上（D4 规则①）。
 *   右栏 = 台账 + 充值/调整/转账/导出/停用/删除，账单的一切都在这一页收口。
 *
 * 🔴 台账本体与转账弹窗都是**共用组件**（`components/TuitionLedger` / `AccountTransferDialog`），
 *    学生详情的 AccountPanel 吃同一份 —— 台账口径（正序/期初/末页/折节）只能有一处实现。
 * 🔴 **D11**：本页不出现按小时计价的说法，一律「每节 X 小时 · Y 元/节」；
 *    共享本 / 零绑定本折不出唯一每节价（每人每节时长不同）→ 只报余额，不编假数。
 * 🔴 `?accountId=` 直达选中态：学生详情的「在课时账单页打开」跳进来就落在那本账上。
 * 🔴 停用 vs 删除：停用只是让该科退出建计划/结算，余额流水留档随时可启用；
 *    删除是硬删，BE 只放行零流水账本（有记录一律劝停用），前端不预判、直接吃 BE 的 400 文案。
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  listMyAccountBooks,
  setAccountStatus,
  deleteAccount,
  type AccountBookVO,
  type TuitionAccountVO,
} from '@/api/teacher/account'
import { useTuitionUnit } from '@/composables/useTuitionUnit'
import TuitionLedger from './components/TuitionLedger.vue'
import AccountTransferDialog from './components/AccountTransferDialog.vue'
import AccountEntryDialog from '@/views/desk/targets/components/AccountEntryDialog.vue'

const route = useRoute()
const router = useRouter()
const { unit, setUnit, d, fmtNum, fmtMoney, priceSpecText } = useTuitionUnit()

const books = ref<AccountBookVO[]>([])
const loading = ref(false)
const currentId = ref('')

const ledgerRef = ref<InstanceType<typeof TuitionLedger> | null>(null)

async function load() {
  loading.value = true
  try {
    books.value = (await listMyAccountBooks()) ?? []
  } catch {
    books.value = []
  } finally {
    loading.value = false
  }
  // 选中态兜底：URL 指的那本 → 上次选的那本 → 第一本
  const want = String(route.query.accountId || '')
  const has = (id: string) => !!id && books.value.some((b) => b.id === id)
  if (has(want)) currentId.value = want
  else if (!has(currentId.value)) currentId.value = books.value[0]?.id ?? ''
}

void load()

/** 从别的页跳进来（学生详情「在课时账单页打开」）时切到目标账本 */
watch(
  () => route.query.accountId,
  (v) => {
    const id = String(v || '')
    if (id && books.value.some((b) => b.id === id)) currentId.value = id
  },
)

const current = computed(() => books.value.find((b) => b.id === currentId.value) ?? null)

/** 零绑定孤本单列一段，在用账本在前 —— 别让退款孤本混在正常账里被误认成还在用的账 */
const activeBooks = computed(() => books.value.filter((b) => b.bindingCount > 0))
const orphanBooks = computed(() => books.value.filter((b) => b.bindingCount === 0))

/** 账本显示名：自定义标签 → 绑定学生名拼接 → 兜底 #id（与 BE accountName 同口径） */
function bookLabel(b: AccountBookVO) {
  if (b.name && b.name.trim()) return b.name.trim()
  const names = (b.studentNames || []).filter(Boolean)
  return names.length ? names.join('+') : `账本 #${b.id}`
}

/** 折节基准：共享本（绑定数>1）与零绑定本都拿不到唯一基准 → 只按小时（D4 规则②） */
function perLessonOf(b: AccountBookVO): number | null {
  if (b.bindingCount !== 1) return null
  return b.hoursPerLesson && b.hoursPerLesson > 0 ? b.hoursPerLesson : null
}

/** 计价文案（D11）：单绑本报「每节 X 小时 · Y 元/节」，其余说清为什么折不出来 */
function priceText(b: AccountBookVO): string {
  const spec = priceSpecText(b.pricePerHour, perLessonOf(b))
  if (spec) return spec
  return b.bindingCount > 1 ? '多人共用 · 每人每节时长不同' : '未绑定学生 · 无每节时长'
}

/** 选中账本的绑定描述（右栏抬头下方那行） */
const bindingText = computed(() => {
  const b = current.value
  if (!b) return ''
  if (!b.bindings?.length) return '这本账当前没有学生绑定，只作历史记录留档'
  const who = b.bindings
    .map((x) =>
      [x.studentName || '—', x.subjectLabel || x.subject, `每节 ${fmtNum(x.hoursPerLesson)} 小时`]
        .filter(Boolean)
        .join(' · '),
    )
    .join('　|　')
  return b.bindingCount > 1 ? `共 ${b.bindingCount} 人记在这本账上：${who}` : who
})

function pick(id: string) {
  if (id === currentId.value) return
  currentId.value = id
  // URL 跟着走：刷新/分享链接都能回到同一本账
  void router.replace({ query: { ...route.query, accountId: id } })
}

// ── 录入弹窗（开户 / 改计价 / 充值 / 调整）────────────────────────────────
type EntryMode = 'open' | 'price' | 'recharge' | 'adjust'
const entryVisible = ref(false)
const entryMode = ref<EntryMode>('open')
const entryStudentId = ref('')
const entryAccount = ref<TuitionAccountVO | null>(null)

/**
 * 账本视角 → 绑定视角（录入弹窗吃的是 `TuitionAccountVO`）。
 * 充值/调整只用到 id/shared/每节时长/计价参数/余额，任一绑定都够；
 * 改计价要认到具体的「学生×学科」，所以只对**单绑本**开放（共享本改哪一条绑定是歧义）。
 */
function asAccountVO(b: AccountBookVO): TuitionAccountVO {
  const b0 = b.bindings?.[0]
  return {
    id: b.id,
    accountId: b.id,
    name: b.name,
    studentId: b0?.studentId ?? '',
    subject: b0?.subject ?? '',
    subjectLabel: b0?.subjectLabel ?? null,
    pricePerHour: b.pricePerHour,
    hoursPerLesson: b.hoursPerLesson ?? b0?.hoursPerLesson ?? 1,
    hoursRemain: b.hoursRemain,
    lessonsRemain: b.lessonsRemain ?? 0,
    shared: b.shared,
    lessonPrice: b.lessonPrice ?? 0,
    amountRemain: b.amountRemain,
    status: b.status,
  }
}

/** 改计价只对单绑本开放（共享本得先拆本，见「转到其他账本」） */
const canEditPrice = computed(() => (current.value?.bindingCount ?? 0) === 1)

function openEntry(mode: EntryMode) {
  const b = current.value
  entryMode.value = mode
  if (mode === 'open') {
    entryStudentId.value = ''
    entryAccount.value = null
  } else {
    if (!b) return
    entryStudentId.value = b.bindings?.[0]?.studentId ?? ''
    entryAccount.value = asAccountVO(b)
  }
  entryVisible.value = true
}

async function onSaved() {
  await load()
  ledgerRef.value?.reload()
}

// ── 换本 / 拆本 ──────────────────────────────────────────────────────────
const transferVisible = ref(false)
const transferFrom = ref<AccountBookVO | null>(null)

function openTransfer(b: AccountBookVO) {
  transferFrom.value = b
  transferVisible.value = true
}

// ── 停用 / 启用 / 删除 ───────────────────────────────────────────────────
const acting = ref('')

async function toggleStatus(b: AccountBookVO) {
  const disable = b.status !== '1'
  if (disable) {
    const ok = await ElMessageBox.confirm(
      '停用后这本账绑的学科不再出现在建计划里，这些课也无法结算。余额和记录都保留，随时可以再启用。',
      `停用「${bookLabel(b)}」`,
      { type: 'warning', confirmButtonText: '停用', cancelButtonText: '取消' },
    ).catch(() => false)
    if (!ok) return
  }
  acting.value = b.id
  try {
    await setAccountStatus(b.id, disable ? '1' : '0')
    ElMessage.success(disable ? '已停用' : '已启用')
    await load()
  } catch {
    // request 拦截器已弹错误 toast
  } finally {
    acting.value = ''
  }
}

async function removeBook(b: AccountBookVO) {
  const ok = await ElMessageBox.confirm(
    '只有从没有过充值/扣课记录的账本才能删；有记录的请改用「停用」——删了账本，台账就与已结场次对不上账。',
    `删除「${bookLabel(b)}」`,
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
  ).catch(() => false)
  if (!ok) return
  acting.value = b.id
  try {
    await deleteAccount(b.id)
    ElMessage.success('账本已删除')
    currentId.value = ''
    await load()
  } catch {
    // 有流水 → BE 400「请改为停用」，拦截器已把原文弹出来
  } finally {
    acting.value = ''
  }
}
</script>

<template>
  <div class="ab-page">
    <header class="ab-head">
      <div class="ab-title">
        <h2>课时账单</h2>
        <p>一本账一个计价；几个学生记同一本账就是「共享账本」。左边选账本，右边看这本账的完整流水。</p>
      </div>
      <div class="ab-head-acts">
        <el-button size="small" text bg type="primary" @click="openEntry('open')">开户（新建账本）</el-button>
        <!-- D8 全局单位开关：切一次全站联动（落 localStorage，刷新不丢） -->
        <el-radio-group
          :model-value="unit"
          size="small"
          @update:model-value="setUnit($event as 'h' | 'j')"
        >
          <el-radio-button value="h">小时</el-radio-button>
          <el-radio-button value="j">节</el-radio-button>
        </el-radio-group>
      </div>
    </header>

    <div class="ab-body">
      <!-- 左：我的全部账本（含零绑定孤本） -->
      <aside class="ab-side" v-loading="loading">
        <div class="ab-sect">在用账本</div>
        <div v-if="activeBooks.length" class="ab-list">
          <button
            v-for="b in activeBooks"
            :key="b.id"
            type="button"
            class="ab-item"
            :class="{ on: b.id === currentId, off: b.status === '1' }"
            @click="pick(b.id)"
          >
            <span class="ab-name">
              {{ bookLabel(b) }}
              <i v-if="b.shared" class="tag shared">共享 {{ b.bindingCount }} 人</i>
              <i v-if="b.status === '1'" class="tag off">已停用</i>
            </span>
            <span class="ab-bal" :class="{ neg: (b.hoursRemain ?? 0) < 0 }">
              剩余 <b>{{ d(b.hoursRemain, perLessonOf(b)).main }}</b>
              <em v-if="d(b.hoursRemain, perLessonOf(b)).sub">（{{ d(b.hoursRemain, perLessonOf(b)).sub }}）</em>
              · 约 {{ fmtMoney(b.amountRemain) }}
            </span>
            <span class="ab-price">{{ priceText(b) }}</span>
            <!-- D4 规则①：绑定数>1 才逐个列学生名（单绑本列出来是噪音） -->
            <span v-if="b.shared" class="ab-chips">
              <i v-for="n in b.studentNames" :key="n" class="chip">{{ n }}</i>
            </span>
          </button>
        </div>
        <p v-else-if="!loading" class="ab-empty">
          还没有账本 —— 点右上角「开户（新建账本）」开出第一本。
        </p>

        <!-- 零绑定孤本：改绑之后没有学生指着它了，但退款/冲正还在上面 -->
        <template v-if="orphanBooks.length">
          <div class="ab-sect">
            没有学生绑定的账本
            <span>改绑后旧本的退款仍查得到，余额可以转到别的账本上</span>
          </div>
          <div class="ab-list">
            <button
              v-for="b in orphanBooks"
              :key="b.id"
              type="button"
              class="ab-item orphan"
              :class="{ on: b.id === currentId }"
              @click="pick(b.id)"
            >
              <span class="ab-name">
                {{ bookLabel(b) }}
                <i class="tag orphan">零绑定</i>
              </span>
              <span class="ab-bal" :class="{ neg: (b.hoursRemain ?? 0) < 0 }">
                剩余 <b>{{ fmtNum(b.hoursRemain) }} 小时</b> · 约 {{ fmtMoney(b.amountRemain) }}
              </span>
            </button>
          </div>
        </template>
      </aside>

      <!-- 右：选中账本的台账 -->
      <section class="ab-main">
        <template v-if="current">
          <div class="ab-main-head">
            <h3>
              {{ bookLabel(current) }}
              <i v-if="current.shared" class="tag shared">共享账本 · {{ current.bindingCount }} 人</i>
              <i v-if="current.status === '1'" class="tag off">已停用</i>
            </h3>
            <span class="ab-main-price">{{ priceText(current) }}</span>
            <span class="ab-main-acts">
              <el-button size="small" text bg type="primary" @click="openEntry('recharge')">充值</el-button>
              <el-button size="small" text bg @click="openEntry('adjust')">调整</el-button>
              <el-button v-if="canEditPrice" size="small" text bg @click="openEntry('price')">改计价</el-button>
              <el-button size="small" text bg @click="openTransfer(current)">转到其他账本</el-button>
              <el-button size="small" text bg :loading="acting === current.id" @click="toggleStatus(current)">
                {{ current.status === '1' ? '启用' : '停用' }}
              </el-button>
              <el-button size="small" text bg type="danger" :loading="acting === current.id" @click="removeBook(current)">
                删除
              </el-button>
            </span>
          </div>
          <p class="ab-binding">{{ bindingText }}</p>

          <TuitionLedger ref="ledgerRef" :account-id="currentId" :page-size="50" height="calc(100vh - 344px)" />
        </template>
        <p v-else-if="!loading" class="ab-empty pad">
          左边还没有账本可选。开一本账，这个学生的课时和课费就有地方记了。
        </p>
      </section>
    </div>

    <AccountTransferDialog
      v-model="transferVisible"
      :from="transferFrom"
      :books="books"
      @done="onSaved"
    />

    <AccountEntryDialog
      v-model="entryVisible"
      :mode="entryMode"
      :student-id="entryStudentId || undefined"
      :account="entryAccount"
      @saved="onSaved"
    />
  </div>
</template>

<style scoped>
.ab-page {
  background: #fff;
  border: 1px solid var(--bk-line);
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(22, 36, 42, 0.05);
  overflow: hidden;
}
.ab-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 18px 12px;
  border-bottom: 1px solid var(--bk-line);
}
.ab-title h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 800;
  color: var(--bk-ink);
}
.ab-title p {
  margin: 4px 0 0;
  font-size: 12.5px;
  color: #8ba09a;
  line-height: 1.6;
}
.ab-head-acts {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.ab-body {
  display: flex;
  align-items: stretch;
  min-height: 420px;
}
.ab-side {
  width: 292px;
  flex: none;
  border-right: 1px solid var(--bk-line);
  padding: 10px 10px 16px;
  box-sizing: border-box;
  background: #fbfdfc;
}
.ab-sect {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  font-weight: 700;
  color: #7b8b93;
  letter-spacing: 0.4px;
  padding: 6px 6px 8px;
}
.ab-sect span {
  font-weight: 400;
  font-size: 11px;
  color: #a0b0aa;
  line-height: 1.5;
}
.ab-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ab-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  text-align: left;
  border: 1px solid var(--bk-line);
  border-radius: 10px;
  background: #fff;
  padding: 9px 11px;
  cursor: pointer;
  transition: 0.15s;
}
.ab-item:hover {
  border-color: var(--bk-teal);
}
.ab-item.on {
  border-color: var(--bk-teal);
  background: var(--bk-teal-soft);
}
.ab-item.off {
  border-style: dashed;
}
.ab-item.orphan {
  border-style: dashed;
  border-color: #dfd3b8;
  background: #fdfaf2;
}
.ab-name {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 13.5px;
  font-weight: 700;
  color: var(--bk-ink);
}
.ab-bal {
  font-size: 12px;
  color: #5f716d;
  font-variant-numeric: tabular-nums;
}
.ab-bal b {
  font-size: 14px;
  color: var(--bk-ink);
}
.ab-bal em {
  font-style: normal;
  color: #8ba09a;
}
.ab-bal.neg b,
.ab-bal.neg {
  color: #be123c;
}
.ab-price {
  font-size: 11.5px;
  color: #8ba09a;
}
.ab-chips {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 2px;
}
.chip {
  font-style: normal;
  font-size: 11px;
  color: var(--bk-teal-deep);
  background: #e8f2f0;
  border-radius: 99px;
  padding: 1px 9px;
}
.tag {
  font-style: normal;
  font-size: 10.5px;
  font-weight: 400;
  border-radius: 99px;
  padding: 1px 8px;
  flex: none;
}
.tag.shared {
  color: var(--bk-teal-deep);
  background: var(--bk-teal-soft);
}
.tag.off {
  color: #a96f14;
  background: #f9f1dd;
}
.tag.orphan {
  color: #a96f14;
  background: #f6ecd6;
}
.ab-main {
  flex: 1;
  min-width: 0;
  padding: 12px 16px 16px;
}
.ab-main-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.ab-main-head h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 16px;
  font-weight: 800;
  color: var(--bk-ink);
}
.ab-main-price {
  font-size: 12px;
  color: #5f716d;
  background: #eef4f2;
  border-radius: 99px;
  padding: 2px 10px;
}
.ab-main-acts {
  margin-left: auto;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.ab-binding {
  margin: 6px 0 10px;
  font-size: 12px;
  color: #8ba09a;
  line-height: 1.6;
}
.ab-empty {
  font-size: 12.5px;
  color: #8ba09a;
  line-height: 1.7;
  padding: 4px 6px;
}
.ab-empty.pad {
  padding: 40px 8px;
}
</style>
