<script setup lang="ts">
/**
 * PRD-015 · /m/account 课时账户（V22 / V26）→ **PRD-018 批3 改版**（v3 账本模型 + 双单位）。
 *
 * 🔄 本批改了什么（逐条对着设计稿「稿2-H5-课时账户.html」的功能点做）：
 *   FP-3  余额双单位：「N 课时 + ¥M」→「N 小时（M 节）」+ 约当金额；价格口径 =「每节 X 小时 · Y 元/节」（D11）。
 *         🔴 折节基准 = 绑定层的 hoursPerLesson，**共享账本（shared）传 null 只按小时不折节**（D4 规则②）。
 *         欠费判定只看小时（hoursRemain<0），红显不拦截（沿用）。
 *   FP-4  顶栏「小时 / 节」全局切换（宿主在 MobileLayout，状态在 composables/useTuitionUnit）。
 *   FP-6  台账正序 + 剩余实时推导：🔴 **不传 pageNum = BE 默认末页**（最近的行）。
 *         老口径硬传 {pageNum:1} 在正序下是**最旧一页**，老师首屏永远看不到最新记录 → 批1→批3 必改点。
 *         向前翻 = 顶部「加载更早」（pageNum-1 前置拼进 rows）；页首挂 openingBalance 期初行（M10）。
 *   FP-7  行三列结构/行色全沿用；shared 时行内容前补学生名（D4 规则①，纯数据驱动无开关）。
 *   FP-8/9/10 充值·调整：三档输入（小时/节/金额）实时互算，🔴 **落库只发选中那一档**（D9）；
 *         业务日期 occurDate 可回填历史（默认今天）；金额档把用户输入原样带进 amountPaid（AC9）。
 *   FP-11/12 开户：每节时长 + 每节价（撤「初始课时/初始金额」，初始额走充值）；
 *         折叠区「记入已有账本」= 学生绑已有账本（n:1），价格跟账本走。
 *   🔴 **D11（批5）**：用户可见面不出现按小时计价的说法；输入收「每节价」，
 *         提交前用 `toPricePerHour` 折成内部计价参数（保 4 位：350 ÷ 1.5 = 233.3333）。
 *   FP-13 导出流水单：通道与三颗按钮**一个字节没动**。
 *
 * 🔴 三态失败分级（BUG-1 铁律）**一行未动**：loadFailed（整页失败）/ failedCount（部分失败）/
 *    trulyEmpty（真没开户）—— 接口坏了就说接口坏了，绝不把故障演成「还没有账户」。
 * 🔴 只发 '1' 充值 / '4' 调整两种手工流水；'2' 扣课 / '3' 冲正由结算链服务端产生，前端无入口。
 * 🔴 删户不上移动端：硬删只对零流水账本放行，误触代价高，留在电脑端。
 * 🔴 双单位/换算**只有一处实现** = composables/useTuitionUnit（桌面同源），本文件不自造第二套。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { showConfirmDialog, showFailToast, showSuccessToast, showToast } from 'vant'
import 'vant/es/toast/style'
import 'vant/es/dialog/style'
import {
  addAccountFlow,
  exportLedgerPng,
  getAccountLedger,
  listAccounts,
  listMyAccountBooks,
  setAccountStatus,
  upsertAccount,
  type AccountBookVO,
  type AccountUpsertBo,
  type LedgerRowVO,
  type TuitionAccountVO,
  type TuitionFlowBo,
} from '@/api/teacher/account'
import { downloadArtifact, pageTargets, type TargetCardVO } from '@/api/teacher/schedule'
import { DICT_EDU_SUBJECT, useDictStore } from '@/store/dict'
import { todayStr, useTuitionUnit } from '@/composables/useTuitionUnit'
import MSheet from './components/MSheet.vue'
import { money } from './shared'

const dict = useDictStore()
/** d/dText = 跟随全局单位的双单位串；fmtNum/toLessons 供三档换算提示 */
const { d, dText, fmtNum, toLessons, unit, priceSpecText, toLessonPrice, toPricePerHour } =
  useTuitionUnit()

interface StudentAccounts {
  id: string
  name: string
  accounts: TuitionAccountVO[]
}

const groups = ref<StudentAccounts[]>([])
/** 全部学生（含没开户的）——开户弹层的学生下拉吃这份，否则新学生永远开不了户 */
const students = ref<{ id: string; name: string }[]>([])
const loading = ref(false)
/** 学生清单本身拉不到 → 整页失败（一个学生都渲染不出来） */
const loadFailed = ref(false)
/** 逐生账本请求失败的学生数 —— 🔴 与「该生没开户」严格分开计数（BUG-1） */
const failedCount = ref(0)

async function load() {
  loading.value = true
  loadFailed.value = false
  failedCount.value = 0
  try {
    const res = await pageTargets({ targetType: '0', pageSize: 500 })
    const list: TargetCardVO[] = res?.rows ?? []
    students.value = list.map((s) => ({ id: s.id, name: s.name }))
    let failed = 0
    const packs = await Promise.all(
      list.map(async (s) => {
        try {
          const accs = await listAccounts(s.id)
          return { id: s.id, name: s.name, accounts: Array.isArray(accs) ? accs : [] }
        } catch (e) {
          // 🔴 BUG-1 教训：请求异常 ≠ 该生没开户。原来这里逐生吞错返空账户，
          //    结果接口一坏，整页就演成「还没有开户的学生」，把故障说成了正常业务态，
          //    足足瞒过一整轮回归。现在照实计数 → 页面出「加载失败·重试」条。
          failed += 1
          console.warn('[m/account] 该生账本拉取失败 studentId=', s.id, e)
          return { id: s.id, name: s.name, accounts: [] as TuitionAccountVO[] }
        }
      }),
    )
    failedCount.value = failed
    groups.value = packs.filter((p) => p.accounts.length > 0)
  } catch (e) {
    console.warn('[m/account] 学生清单拉取失败', e)
    groups.value = []
    students.value = []
    loadFailed.value = true
  } finally {
    loading.value = false
  }
}

/** 只有「全部请求都成功、确实一个账本都没有」才敢说没开户 */
const trulyEmpty = computed(
  () => !loading.value && !loadFailed.value && !failedCount.value && !groups.value.length,
)

function subjectLabel(code: string): string {
  return dict.label(DICT_EDU_SUBJECT, code) || code
}

/**
 * 折节基准（D4 规则②）：
 * 共享账本（多个学生绑同一本，每节时长各不同）**基准不唯一 → 传 null 只按小时不折节**。
 */
function perLessonOf(a: TuitionAccountVO): number | null {
  if (a.shared) return null
  return a.hoursPerLesson > 0 ? a.hoursPerLesson : null
}

/** 🔴 欠费只看小时（金额是派生量，不再参与判定） */
function isOwe(a: TuitionAccountVO): boolean {
  return (a.hoursRemain ?? 0) < 0
}

/** 约当金额 = 剩余小时 × 账本计价参数（现场派生，不落库） */
function amountOf(a: TuitionAccountVO): number {
  return (a.hoursRemain ?? 0) * (a.pricePerHour ?? 0)
}

/** 右列第二行：正常「约 ¥350」/ 欠费「欠 ¥1166.65 · 欠费」 */
function amountText(a: TuitionAccountVO): string {
  const v = amountOf(a)
  return v < 0 ? `欠 ${money(-v)} · 欠费` : `约 ${money(v)}`
}

// ── 台账 ───────────────────────────────────────────────────────
const LEDGER_PAGE = 30

const ledgerOpen = ref(false)
const ledgerLoading = ref(false)
const ledgerMoreLoading = ref(false)
const ledgerRows = ref<LedgerRowVO[]>([])
/** 已加载到的**最早**一页（>1 说明前面还有更早的行可翻） */
const ledgerPageNum = ref(1)
/** 期初结余 = 当前首行之前的累计小时（翻页后跟着变） */
const ledgerOpening = ref(0)
/** BE 回的账本视角（含绑定学生名，标题与共享判定用） */
const ledgerBook = ref<AccountBookVO | null>(null)
const ledgerShared = ref(false)
const curAccount = ref<TuitionAccountVO | null>(null)
const curStudentName = ref('')

/** 台账内的折节基准：共享账本不折节（与卡片行同一条规则） */
const ledgerPerLesson = computed<number | null>(() => {
  const a = curAccount.value
  if (!a) return null
  if (ledgerShared.value || a.shared) return null
  return a.hoursPerLesson > 0 ? a.hoursPerLesson : null
})

/** 账本抬头：有账本标签用标签，否则用绑定学生名（共享本列全部） */
const ledgerWho = computed(() => {
  const names = ledgerBook.value?.studentNames ?? []
  if (ledgerBook.value?.name) return ledgerBook.value.name
  return names.length ? names.join(' + ') : curStudentName.value
})

const ledgerTitle = computed(() =>
  curAccount.value
    ? `课时消耗记录 · ${ledgerWho.value}（${subjectLabel(curAccount.value.subject)}）`
    : '课时消耗记录',
)

/** 期初行只在「前面确实还有账」时出：翻过页 或 期初非零 */
const showOpening = computed(
  () => !!ledgerRows.value.length && (ledgerPageNum.value > 1 || Math.abs(ledgerOpening.value) > 1e-6),
)

/** 流水类型 → 台账行样式：'1' 充值 / '4' 调整走绿，'3' 冲正走红，'2' 扣课普通 */
function rowClass(t: string): string {
  if (t === '1' || t === '4') return 'recharge'
  if (t === '3') return 'reverse'
  return 'consume'
}

async function loadLedgerRows(accountId: string) {
  ledgerLoading.value = true
  ledgerRows.value = []
  try {
    // 🔴 **不传 pageNum** = BE 默认最后一页（最近的行）。
    //    正序口径下硬传 pageNum:1 是最旧的一页 —— 老师点开台账只会看到几个月前的账。
    const res = await getAccountLedger(accountId, { pageSize: LEDGER_PAGE })
    ledgerRows.value = res?.rows ?? []
    ledgerPageNum.value = res?.pageNum ?? 1
    ledgerOpening.value = res?.openingBalance ?? 0
    ledgerBook.value = res?.account ?? null
    ledgerShared.value = !!res?.shared
  } catch (e) {
    console.warn('[m/account] 台账拉取失败', e)
    ledgerRows.value = []
    ledgerPageNum.value = 1
    ledgerOpening.value = 0
    ledgerBook.value = null
    ledgerShared.value = false
  } finally {
    ledgerLoading.value = false
  }
}

/** 向**前**翻一页（更早的行前置拼进来）：正序 + 默认末页 ⟹ 累积翻页方向与常规列表相反 */
async function loadEarlier() {
  const a = curAccount.value
  if (!a || ledgerMoreLoading.value || ledgerPageNum.value <= 1) return
  ledgerMoreLoading.value = true
  try {
    const res = await getAccountLedger(a.id, {
      pageNum: ledgerPageNum.value - 1,
      pageSize: LEDGER_PAGE,
    })
    ledgerRows.value = [...(res?.rows ?? []), ...ledgerRows.value]
    ledgerPageNum.value = res?.pageNum ?? ledgerPageNum.value - 1
    ledgerOpening.value = res?.openingBalance ?? 0
  } catch (e) {
    console.warn('[m/account] 更早台账拉取失败', e)
    showFailToast('更早的记录没拉到，稍后重试')
  } finally {
    ledgerMoreLoading.value = false
  }
}

async function openLedger(stu: StudentAccounts, a: TuitionAccountVO) {
  curAccount.value = a
  curStudentName.value = stu.name
  ledgerOpen.value = true
  await loadLedgerRows(a.id)
}

// ── 写操作四态（开户 / 改计价 / 充值 / 调整）────────────────────
// 一个弹层壳吃四态，字段按 mode 显隐——与桌面录入弹窗一一对应。
type EntryMode = 'open' | 'price' | 'recharge' | 'adjust'
/** 充值/调整的输入档（D9 三档任填其一，落库只有小时） */
type AmountTab = 'h' | 'j' | 'y'

const entryOpen = ref(false)
const entryMode = ref<EntryMode>('open')
const entrySaving = ref(false)
const entryTab = ref<AmountTab>('h')
/** 「记入已有账本」折叠区的展开态（开户弹层用；声明在此供 resetEntry 收起） */
const foldNames = ref<string[]>([])
const entryForm = reactive({
  studentId: '',
  subject: '',
  /** 每节价 元/节（D11 对外唯一价格口径） */
  lessonPrice: '',
  /** 每节时长 小时/节 */
  hoursPerLesson: '',
  /** 三档共用的那一个输入框 */
  val: '',
  /** 业务日期（默认今天，可回填历史） */
  occurDate: todayStr(),
  note: '',
  /** 记入已有账本：非空 = 只建绑定不新建账本 */
  accountId: '',
})

const entryTitle = computed(() => {
  const s = curAccount.value
    ? `${curStudentName.value}（${subjectLabel(curAccount.value.subject)}）`
    : ''
  switch (entryMode.value) {
    case 'open':
      return '开通学科账户'
    case 'price':
      return `改计价 · ${s}`
    case 'recharge':
      return `充值 · ${s}`
    default:
      return `调整 · ${s}`
  }
})

const entrySub = computed(() => {
  const a = curAccount.value
  const bal = a ? dText(a.hoursRemain, perLessonOf(a)) : ''
  switch (entryMode.value) {
    case 'open':
      return '开通即绑定该学科：之后能给这科建计划、记课时课费。初始额回头用「充值」记。'
    case 'price':
      return '只改以后结算用的每节时长与每节价；已扣过的记录按当时金额留档，不回溯。'
    case 'adjust':
      return `当前 ${bal}；可以填负数（扣回记错的数）`
    default:
      return `当前 ${bal}；负数=欠费，充值后自动补平`
  }
})

/** 开户可选学科 = 全字典 − 该生已开过的（含停用的：那种去行内点「启用」，别重复开） */
const subjectOptions = computed(() => {
  const opened = new Set(
    (groups.value.find((g) => g.id === entryForm.studentId)?.accounts ?? []).map((a) => a.subject),
  )
  return dict.list(DICT_EDU_SUBJECT).filter((dd) => !opened.has(dd.dictValue))
})

// ── 三档换算（D9）：输一档，另两档实时算给老师看；落库只发选中那一档 ────────
const curPerLesson = computed(() => (curAccount.value ? perLessonOf(curAccount.value) : null))
/** 内部计价参数（不上屏，只用来把金额档折成小时） */
const curPrice = computed(() => curAccount.value?.pricePerHour ?? 0)

/** 「按节」档：共享账本基准不唯一 → 禁用（BE 也不接受 lessons） */
const jieDisabled = computed(() => !curPerLesson.value)
/** 「按金额」档：没有计价就换算不了 */
const yuanDisabled = computed(() => !(curPrice.value > 0))

/** 当前输入折成小时（**仅用于提示**，落库由 BE 按选中档换算） */
const entryHours = computed(() => {
  const v = parseFloat(entryForm.val)
  if (!Number.isFinite(v) || !v) return 0
  if (entryTab.value === 'j') return curPerLesson.value ? v * curPerLesson.value : 0
  if (entryTab.value === 'y') return curPrice.value > 0 ? v / curPrice.value : 0
  return v
})

const tabUnit = computed(() =>
  entryTab.value === 'h' ? '小时' : entryTab.value === 'j' ? '节' : '元',
)

/** 「= 15 小时 = 3500 元　按每节 1.5 小时 · 350 元/节 折算」 */
const convHint = computed(() => {
  if (entryMode.value === 'open' || entryMode.value === 'price') return ''
  const h = entryHours.value
  if (!h) return ''
  const parts: string[] = []
  if (entryTab.value !== 'h') parts.push(`${fmtNum(h)} 小时`)
  if (entryTab.value !== 'j' && curPerLesson.value) {
    parts.push(`${fmtNum(toLessons(h, curPerLesson.value))} 节`)
  }
  if (entryTab.value !== 'y' && curPrice.value > 0) parts.push(money(h * curPrice.value))
  if (!parts.length) return ''
  const spec = priceSpecText(curPrice.value, curPerLesson.value)
  const basis = spec ? `按${spec}折算` : '按本账计价折算'
  return `= ${parts.join(' = ')}　${basis}`
})

function resetEntry() {
  entryForm.subject = ''
  entryForm.lessonPrice = ''
  entryForm.hoursPerLesson = ''
  entryForm.val = ''
  entryForm.occurDate = todayStr()
  entryForm.note = ''
  entryForm.accountId = ''
  entryTab.value = 'h'
  foldNames.value = []
}

/** 开户：从页头进（学生下拉自选）或从某学生卡进（学生锁定） */
function openCreate(stu?: StudentAccounts) {
  entryMode.value = 'open'
  curAccount.value = null
  curStudentName.value = stu?.name ?? ''
  resetEntry()
  entryForm.hoursPerLesson = '1'
  entryForm.studentId = stu?.id ?? students.value[0]?.id ?? ''
  entryOpen.value = true
}

function openEntry(mode: Exclude<EntryMode, 'open'>, stu: StudentAccounts, a: TuitionAccountVO) {
  entryMode.value = mode
  curAccount.value = a
  curStudentName.value = stu.name
  resetEntry()
  entryForm.studentId = stu.id
  entryForm.subject = a.subject
  if (mode === 'price') {
    entryForm.lessonPrice = String(toLessonPrice(a.pricePerHour, a.hoursPerLesson) ?? 0)
    entryForm.hoursPerLesson = String(a.hoursPerLesson || 1)
  } else {
    // 默认档跟着顶栏单位走（老师正看「节」就按节记），共享账本折不了节 → 回落小时
    entryTab.value = unit.value === 'j' && !jieDisabled.value ? 'j' : 'h'
  }
  entryOpen.value = true
}

function pickTab(t: AmountTab) {
  if (t === 'j' && jieDisabled.value) return
  if (t === 'y' && yuanDisabled.value) return
  entryTab.value = t
}

function num2(v: string): number {
  return Math.round((parseFloat(v) || 0) * 100) / 100
}

async function submitEntry() {
  if (entrySaving.value) return
  const mode = entryMode.value
  const acc = curAccount.value

  if (mode === 'open' || mode === 'price') {
    // 🔴 开户与改计价走同一个 upsertAccount：uk(studentId,subject) 命中 = 改绑定+计价（不动余额）
    const studentId = entryForm.studentId
    const subject = mode === 'price' ? (acc?.subject ?? '') : entryForm.subject
    if (!studentId) {
      showToast('请选择学生')
      return
    }
    if (!subject) {
      showToast('请选择学科')
      return
    }
    const per = num2(entryForm.hoursPerLesson)
    if (per <= 0) {
      showToast('每节时长要大于 0（如 1 或 1.5）')
      return
    }
    const lessonPrice = num2(entryForm.lessonPrice)
    // 记入已有账本时价格跟账本走，本地这栏不参与校验
    if (!entryForm.accountId && lessonPrice < 0) {
      showToast('每节价不能为负')
      return
    }
    // 🔴 hoursPerLesson 必须每次显式带上：入参缺省时 BE 按 1 兜底，
    //    改计价时漏传会把俊羽的 1.5 悄悄改回 1（结算默认时长跟着错）。
    const bo: AccountUpsertBo = { studentId, subject, hoursPerLesson: per }
    if (entryForm.accountId) bo.accountId = entryForm.accountId
    // D11 换算唯一出口：每节价 ÷ 每节时长 → 内部计价参数（保 4 位）
    else bo.pricePerHour = toPricePerHour(lessonPrice, per)
    entrySaving.value = true
    try {
      await upsertAccount(bo)
      showSuccessToast(mode === 'open' ? '账本已开通' : '计价已更新')
    } catch {
      return // 拦截器已提示，弹层保持打开好让老师改了重试
    } finally {
      entrySaving.value = false
    }
  } else {
    if (!acc) return
    const v = num2(entryForm.val)
    if (!v) {
      showToast(`请填写要${mode === 'recharge' ? '充值' : '调整'}的数`)
      return
    }
    if (mode === 'recharge' && v < 0) {
      showToast('充值填正数；要扣回请用「调整」')
      return
    }
    if (!entryForm.occurDate) {
      showToast('请选择业务日期')
      return
    }
    // 🔴 三档**只发选中那一档**（D9）：三个都传 BE 无从判断哪个是老师真填的。
    const bo: TuitionFlowBo = {
      flowType: mode === 'recharge' ? '1' : '4',
      occurDate: entryForm.occurDate,
    }
    if (entryTab.value === 'h') bo.hours = v
    else if (entryTab.value === 'j') bo.lessons = v
    else {
      bo.amount = v
      bo.amountPaid = v // AC9：收 3500 就记 3500，不用派生值倒推尾差
    }
    if (entryForm.note.trim()) bo.note = entryForm.note.trim()
    entrySaving.value = true
    try {
      await addAccountFlow(acc.id, bo)
      showSuccessToast(mode === 'recharge' ? '充值已记入' : '调整已记入')
    } catch {
      return
    } finally {
      entrySaving.value = false
    }
  }

  entryOpen.value = false
  await load()
  // 台账正开着 → 同步刷新（余额与台账即时更新，V22）
  if (ledgerOpen.value && curAccount.value) await loadLedgerRows(curAccount.value.id)
}

// ── 「记入已有账本」折叠区（M6：我的全部账本，含零绑定孤本）────────────
const books = ref<AccountBookVO[]>([])
const booksLoading = ref(false)
const booksFailed = ref(false)

async function loadBooks() {
  if (booksLoading.value) return
  booksLoading.value = true
  booksFailed.value = false
  try {
    const res = await listMyAccountBooks()
    books.value = Array.isArray(res) ? res : []
  } catch (e) {
    console.warn('[m/account] 账本清单拉取失败', e)
    books.value = []
    booksFailed.value = true
  } finally {
    booksLoading.value = false
  }
}

/** 折叠区展开才拉账本清单（大多数开户是「新开一本」，不该为它多打一次接口） */
function onFoldChange(names: unknown) {
  const arr = Array.isArray(names) ? names : [names]
  if (arr.some((n) => n === 'book') && !books.value.length && !booksFailed.value) void loadBooks()
}

function bookTitle(b: AccountBookVO): string {
  if (b.name) return b.name
  if (b.studentNames?.length) return `${b.studentNames.join(' + ')}的账本`
  return '未命名账本（零绑定）'
}

function bookMeta(b: AccountBookVO): string {
  const h = b.hoursRemain ?? 0
  const bal = h < 0 ? `欠 ${fmtNum(-h)} 小时` : `余 ${fmtNum(h)} 小时`
  const spec = priceSpecText(b.pricePerHour, b.hoursPerLesson)
  return spec ? `${spec} · ${bal}` : bal
}

// ── 学生 / 学科选择器（van-picker 底部滚轮）───────────────────
const stuPickerOpen = ref(false)
const subjPickerOpen = ref(false)
const datePickerOpen = ref(false)
const datePicked = ref<string[]>([])
const dateMin = new Date(new Date().getFullYear() - 3, 0, 1)
const dateMax = new Date()

const studentColumns = computed(() => students.value.map((s) => ({ text: s.name, value: s.id })))
const subjectColumns = computed(() =>
  subjectOptions.value.map((dd) => ({ text: dd.dictLabel, value: dd.dictValue })),
)

const entryStudentName = computed(
  () => students.value.find((s) => s.id === entryForm.studentId)?.name || '',
)

function onPickStudent({ selectedOptions }: { selectedOptions: { value?: string | number }[] }) {
  const v = selectedOptions[0]?.value
  entryForm.studentId = v == null ? '' : String(v)
  // 换学生 → 已开学科集合变了，之前选的学科可能已不在候选里，清掉重选
  entryForm.subject = ''
  stuPickerOpen.value = false
}

function onPickSubject({ selectedOptions }: { selectedOptions: { value?: string | number }[] }) {
  const v = selectedOptions[0]?.value
  entryForm.subject = v == null ? '' : String(v)
  subjPickerOpen.value = false
}

function openDatePicker() {
  const [y, m, dd] = (entryForm.occurDate || todayStr()).split('-')
  datePicked.value = [y, m, dd]
  datePickerOpen.value = true
}

function onPickDate() {
  const [y, m, dd] = datePicked.value
  if (y && m && dd) entryForm.occurDate = `${y}-${m}-${dd}`
  datePickerOpen.value = false
}

// ── 停用 / 启用 ────────────────────────────────────────────────
const acting = ref('')

async function toggleStatus(stu: StudentAccounts, a: TuitionAccountVO) {
  const disable = a.status !== '1'
  const subj = subjectLabel(a.subject)
  if (disable) {
    const ok = await showConfirmDialog({
      title: `停用 ${stu.name} 的${subj}账本`,
      message: `停用后「${subj}」不再出现在建计划的学科里，这科的课结算时只标已上、暂不扣课。余额和记录都保留，随时可以再启用。`,
      confirmButtonText: '停用',
      cancelButtonText: '取消',
    })
      .then(() => true)
      .catch(() => false)
    if (!ok) return
  }
  acting.value = a.id
  try {
    await setAccountStatus(a.id, disable ? '1' : '0')
    showSuccessToast(disable ? '已停用' : '已启用')
    await load()
  } catch {
    // 拦截器已提示
  } finally {
    acting.value = ''
  }
}

// ── 流水导出（D16 / V26）──────────────────────────────────────
const expOpen = ref(false)
const expLoading = ref(false)
const expUrl = ref('')

function revokeExp() {
  if (expUrl.value) {
    URL.revokeObjectURL(expUrl.value)
    expUrl.value = ''
  }
}

/** 出图：POST export-ledger-png → 带鉴权 blob 通道取流 → objectURL 预览 */
async function buildLedgerPng(): Promise<boolean> {
  const a = curAccount.value
  if (!a) return false
  expLoading.value = true
  try {
    const res = await exportLedgerPng(a.id)
    const blob = await downloadArtifact(res.file)
    revokeExp()
    expUrl.value = URL.createObjectURL(blob)
    return true
  } catch {
    showFailToast('流水单生成失败')
    return false
  } finally {
    expLoading.value = false
  }
}

async function openExport() {
  ledgerOpen.value = false
  expOpen.value = true
  revokeExp()
  await buildLedgerPng()
}

function downloadLedgerPng() {
  if (!expUrl.value) return
  const a = document.createElement('a')
  a.href = expUrl.value
  const subj = curAccount.value ? subjectLabel(curAccount.value.subject) : ''
  a.download = `课时流水单-${ledgerWho.value}${subj ? '-' + subj : ''}.png`
  a.click()
}

/** 机器人发到老师本人飞书（D8）：dev 段验出图端点，bot 推送接线归上线段 */
async function sendLedgerToBot() {
  const ok = expUrl.value ? true : await buildLedgerPng()
  if (!ok) return
  showSuccessToast('已生成，bot 推送上线段接线')
}

onMounted(load)
</script>

<template>
  <section>
    <van-cell-group inset>
      <van-cell title="学生 × 学科 账户" label="点「记录」看消耗台账">
        <template #value>
          <van-button
            size="small"
            type="primary"
            plain
            icon="plus"
            :disabled="loading || loadFailed"
            @click="openCreate()"
          >
            开户
          </van-button>
        </template>
      </van-cell>
    </van-cell-group>

    <van-loading v-if="loading" class="m-note" size="18">加载中…</van-loading>

    <!-- 🔴 BUG-1：加载失败必须现形，绝不伪装成「没开户」 -->
    <van-notice-bar
      v-else-if="loadFailed"
      type="danger"
      wrapable
      :scrollable="false"
      left-icon="warning-o"
    >
      账户加载失败——这是接口/网络问题，不代表没有开户。
      <template #right-icon>
        <van-button size="mini" type="danger" plain @click="load">重试</van-button>
      </template>
    </van-notice-bar>
    <template v-else>
      <van-notice-bar
        v-if="failedCount"
        type="danger"
        wrapable
        :scrollable="false"
        left-icon="warning-o"
      >
        {{ failedCount }} 名学生的账户加载失败，下面的清单不完整。
        <template #right-icon>
          <van-button size="mini" type="danger" plain @click="load">重试</van-button>
        </template>
      </van-notice-bar>
      <!-- BUG-3/B：空态不再指路电脑端，右上角就能开户 -->
      <van-empty v-if="trulyEmpty" image="search" description="还没有账户">
        <van-button round type="primary" icon="plus" @click="openCreate()">开通第一个账户</van-button>
      </van-empty>
    </template>

    <van-cell-group v-for="g in groups" :key="g.id" inset>
      <van-cell :title="g.name" title-class="m-rowtitle">
        <template #value>
          <van-button size="mini" type="primary" plain icon="plus" @click="openCreate(g)">
            开新科
          </van-button>
        </template>
      </van-cell>

      <van-cell
        v-for="a in g.accounts"
        :key="a.id"
        :class="{ 'm-muted': a.status === '1' }"
        value-class="m-vnarrow"
        clickable
        @click="openLedger(g, a)"
      >
        <template #title>
          <span class="m-rowtitle">
            <van-tag type="primary" plain>{{ subjectLabel(a.subject) }}</van-tag>
            <van-tag v-if="a.status === '1'" type="warning">已停用</van-tag>
            <van-tag v-if="a.shared" type="primary">共享账本</van-tag>
            <!-- D11：价格口径统一「每节 X 小时 · Y 元/节」，不出现按小时计价的说法 -->
            <span class="m-note" style="margin: 0">{{ priceSpecText(a.pricePerHour, a.hoursPerLesson) }}</span>
          </span>
        </template>
        <template #value>
          <!-- 双单位：主显跟随顶栏开关，副显在括号里；共享账本只出小时（sub 为空） -->
          <div class="m-num" :class="{ 'm-owe': isOwe(a) }">
            <b>{{ d(a.hoursRemain, perLessonOf(a)).main }}</b>
            <i v-if="d(a.hoursRemain, perLessonOf(a)).sub" class="m-subu">
              （{{ d(a.hoursRemain, perLessonOf(a)).sub }}）
            </i>
          </div>
          <div class="m-num m-note" :class="{ 'm-owe': isOwe(a) }" style="margin: 0">
            {{ amountText(a) }}
          </div>
        </template>
        <template #label>
          <!-- 写操作全套上手机（BUG-3/B）：轻按即达，不再指路电脑端 -->
          <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px">
            <van-button size="mini" @click.stop="openLedger(g, a)">记录</van-button>
            <van-button size="mini" type="primary" @click.stop="openEntry('recharge', g, a)">
              充值
            </van-button>
            <van-button size="mini" @click.stop="openEntry('adjust', g, a)">调整</van-button>
            <van-button size="mini" @click.stop="openEntry('price', g, a)">改计价</van-button>
            <van-button size="mini" :loading="acting === a.id" @click.stop="toggleStatus(g, a)">
              {{ a.status === '1' ? '启用' : '停用' }}
            </van-button>
          </div>
        </template>
      </van-cell>
    </van-cell-group>

    <!-- 课时消耗台账（正序 + 剩余实时推导 + 向前翻页） -->
    <MSheet
      v-model="ledgerOpen"
      :title="ledgerTitle"
      sub="日期 · 上课时间 · 内容 · 消耗 · 剩余——按上课先后排列，剩余随每行连续变化"
    >
      <van-loading v-if="ledgerLoading" class="m-note" size="18">加载中…</van-loading>
      <van-empty v-else-if="!ledgerRows.length" image="search" image-size="70" description="暂无记录" />
      <template v-else>
        <!-- 向前翻：正序 + 默认末页，更早的账在上面（到第 1 页这条自动消失） -->
        <div
          v-if="ledgerPageNum > 1"
          class="m-lrow fold-row"
          role="button"
          tabindex="0"
          @click="loadEarlier"
          @keyup.enter="loadEarlier"
        >
          {{ ledgerMoreLoading ? '正在加载更早…' : '↑ 加载更早的记录' }}
        </div>
        <div v-if="showOpening" class="m-lrow opening">
          <div class="ld"><div class="dd">期初</div></div>
          <div class="lc">期初结余</div>
          <div class="ln">
            <div class="after">剩 {{ d(ledgerOpening, ledgerPerLesson).main }}</div>
          </div>
        </div>
        <div v-for="(f, i) in ledgerRows" :key="f.id || i" class="m-lrow" :class="rowClass(f.flowType)">
          <div class="ld">
            <div class="dd">{{ (f.date || '').slice(5) || '—' }}</div>
            <div v-if="f.timeRange" class="tt">{{ f.timeRange }}</div>
          </div>
          <div class="lc">
            <!-- D4 规则①：共享账本才显学生名（这行是谁的课），纯数据驱动无开关 -->
            <b v-if="f.studentName" class="stu">{{ f.studentName }}</b>{{ f.content || '—' }}
          </div>
          <div class="ln">
            <div class="delta">{{ d(f.hoursDelta, ledgerPerLesson, true).main }}</div>
            <div v-if="f.hoursAfter !== null && f.hoursAfter !== undefined" class="after">
              剩 {{ d(f.hoursAfter, ledgerPerLesson).main }}
            </div>
          </div>
        </div>
      </template>

      <template #acts>
        <van-button block @click="ledgerOpen = false">关闭</van-button>
        <van-button block type="primary" :disabled="!ledgerRows.length" @click="openExport">
          导出流水
        </van-button>
      </template>
    </MSheet>

    <!-- 开户 / 改计价 / 充值 / 调整（四态共壳）-->
    <MSheet v-model="entryOpen" :title="entryTitle" :sub="entrySub">
      <!-- D9 三档：输哪档另两档实时算；落库只发选中那一档 -->
      <div v-if="entryMode === 'recharge' || entryMode === 'adjust'" class="mtabs">
        <button type="button" :class="{ on: entryTab === 'h' }" @click="pickTab('h')">按小时</button>
        <button
          type="button"
          :class="{ on: entryTab === 'j' }"
          :disabled="jieDisabled"
          @click="pickTab('j')"
        >
          按节
        </button>
        <button
          type="button"
          :class="{ on: entryTab === 'y' }"
          :disabled="yuanDisabled"
          @click="pickTab('y')"
        >
          按金额
        </button>
      </div>

      <van-cell-group inset>
        <template v-if="entryMode === 'open'">
          <van-field
            :model-value="entryStudentName"
            label="学生"
            placeholder="请选择"
            readonly
            is-link
            @click="stuPickerOpen = true"
          />
          <van-field
            :model-value="entryForm.subject ? subjectLabel(entryForm.subject) : ''"
            label="学科"
            placeholder="请选择"
            readonly
            is-link
            @click="subjPickerOpen = true"
          />
        </template>

        <template v-if="entryMode === 'open' || entryMode === 'price'">
          <van-field
            v-model="entryForm.hoursPerLesson"
            label="每节时长"
            type="number"
            inputmode="decimal"
            placeholder="小时 / 节，如 1 或 1.5"
          />
          <van-field
            v-model="entryForm.lessonPrice"
            label="每节价"
            type="number"
            inputmode="decimal"
            :disabled="!!entryForm.accountId"
            :placeholder="entryForm.accountId ? '跟随所选账本' : '元 / 节，如 350'"
          />
        </template>

        <template v-if="entryMode === 'recharge' || entryMode === 'adjust'">
          <van-field
            v-model="entryForm.val"
            :label="entryMode === 'recharge' ? '充值' : '调整'"
            type="number"
            inputmode="decimal"
            :placeholder="entryTab === 'y' ? '如 3500' : '如 10'"
          >
            <template #extra>
              <span class="m-note" style="margin: 0">{{ tabUnit }}</span>
            </template>
          </van-field>
          <van-field
            :model-value="entryForm.occurDate"
            label="业务日期"
            placeholder="选择日期"
            readonly
            is-link
            @click="openDatePicker"
          >
            <template v-if="entryForm.occurDate === todayStr()" #button>
              <van-tag type="primary" plain>今天</van-tag>
            </template>
          </van-field>
          <van-field
            v-model="entryForm.note"
            label="备注"
            maxlength="200"
            placeholder="如：暑期第二期 / 微信转账 3500"
          />
        </template>
      </van-cell-group>

      <p v-if="convHint" class="m-fnote">{{ convHint }}</p>
      <p v-if="(entryMode === 'recharge' || entryMode === 'adjust') && jieDisabled" class="m-fnote">
        共享账本（多个学生同一本账）每节时长不统一，「按节」不可用——按小时或按金额记。
      </p>
      <p v-if="entryMode === 'recharge' || entryMode === 'adjust'" class="m-fnote">
        业务日期可以改到过去补记；台账按业务日期实时重排，后面每行的剩余会自动跟着变。
      </p>

      <!-- FP-12「记入已有账本」：默认收起 = 新开一本 -->
      <van-collapse v-if="entryMode === 'open'" v-model="foldNames" @change="onFoldChange">
        <van-collapse-item name="book" title="记入已有账本" :value="entryForm.accountId ? '已选' : '不选就新开一本'">
          <van-loading v-if="booksLoading" class="m-note" size="18">加载中…</van-loading>
          <van-notice-bar
            v-else-if="booksFailed"
            type="danger"
            wrapable
            :scrollable="false"
            left-icon="warning-o"
          >
            账本清单没拉到（接口/网络问题）。
            <template #right-icon>
              <van-button size="mini" type="danger" plain @click="loadBooks">重试</van-button>
            </template>
          </van-notice-bar>
          <van-radio-group v-else v-model="entryForm.accountId">
            <van-cell clickable title="新开一本账（默认）" @click="entryForm.accountId = ''">
              <template #right-icon><van-radio name="" @click.stop /></template>
            </van-cell>
            <van-cell
              v-for="b in books"
              :key="b.id"
              clickable
              :title="bookTitle(b)"
              :label="bookMeta(b)"
              @click="entryForm.accountId = b.id"
            >
              <template #right-icon><van-radio :name="b.id" @click.stop /></template>
            </van-cell>
          </van-radio-group>
          <p class="m-fnote">选了已有账本，这个学生的课就记进那本账；价格跟账本走，这里只填每节时长。</p>
        </van-collapse-item>
      </van-collapse>

      <template #acts>
        <van-button block @click="entryOpen = false">取消</van-button>
        <van-button block type="primary" :loading="entrySaving" loading-text="保存中…" @click="submitEntry">
          保存
        </van-button>
      </template>
    </MSheet>

    <!-- 学生选择 -->
    <van-popup v-model:show="stuPickerOpen" position="bottom" round>
      <van-picker
        title="选择学生"
        :columns="studentColumns"
        @confirm="onPickStudent"
        @cancel="stuPickerOpen = false"
      />
    </van-popup>

    <!-- 学科选择（已开过的学科不在候选里，那种去行内点「启用」） -->
    <van-popup v-model:show="subjPickerOpen" position="bottom" round>
      <van-picker
        title="选择学科"
        :columns="subjectColumns"
        @confirm="onPickSubject"
        @cancel="subjPickerOpen = false"
      />
    </van-popup>

    <!-- 业务日期（可回填历史，D9/FP-9） -->
    <van-popup v-model:show="datePickerOpen" position="bottom" round>
      <van-date-picker
        v-model="datePicked"
        title="业务日期"
        :min-date="dateMin"
        :max-date="dateMax"
        @confirm="onPickDate"
        @cancel="datePickerOpen = false"
      />
    </van-popup>

    <!-- 流水单导出预览 -->
    <MSheet
      v-model="expOpen"
      title="导出流水单"
      sub="Excel 风格格式化版式 · 下载 PNG 或让机器人发到你的飞书，转发家长自便"
    >
      <div class="m-png">
        <div v-if="expLoading" class="loading">流水单生成中…</div>
        <img v-else-if="expUrl" :src="expUrl" alt="课时流水单" />
        <div v-else class="loading">未能生成流水单</div>
      </div>
      <template #acts>
        <van-button block @click="expOpen = false">关闭</van-button>
        <van-button block :disabled="!expUrl" @click="downloadLedgerPng">下载图片</van-button>
        <van-button block type="primary" :loading="expLoading" @click="sendLedgerToBot">
          发到飞书
        </van-button>
      </template>
    </MSheet>
  </section>
</template>
