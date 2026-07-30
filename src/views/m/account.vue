<script setup lang="ts">
/**
 * PRD-015 批5 · /m/account 课时账户（V22 / V26）+ bug 批 BUG-3/B「/m/ 全部放开」。
 *
 * D2/D3：学生 × 学科各一账户 —— 学生分卡、学科分行（单价 / 剩余课时 / 剩余金额），
 *        余额可为负（欠费）→ 红显不拦截。
 * 「记录」= 课时消耗台账（手抄本数字版）：日期+上课时间 / 上课内容 / ±课时 / 本行后剩余，
 *          充值（重置）绿、冲正红，与扣课同列按时间倒序（getAccountLedger 已排好序，前端不重排）。
 * 台账内「导出流水」= exportLedgerPng（D16 Excel 风格 PNG）→ 预览 + 「下载图片」真下载 +
 *          「机器人发到我的飞书」调同端点出图（bot 推送归上线段，D8/H5）。
 *
 * 🔴 BUG-3/B 写操作全套上手机：开户 / 充值 / 调整 / 改单价 / 停用启用，
 *    语义与校验<b>照搬桌面 AccountEntryDialog</b>（同一套 api：upsertAccount + addAccountFlow +
 *    setAccountStatus），只把壳换成 MSheet 底部弹层——两端口径必须一致，否则同一笔钱两处算法不同。
 * 🔴 只发 '1' 充值 / '4' 调整两种手工流水；'2' 扣课 / '3' 冲正由结算链服务端产生，前端无入口。
 * 🔴 删户不上移动端：硬删只对零流水账户放行，误触代价高，留在电脑端学生卡做。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  addAccountFlow,
  exportLedgerPng,
  getAccountLedger,
  listAccounts,
  setAccountStatus,
  upsertAccount,
  type LedgerRowVO,
  type TuitionAccountVO,
} from '@/api/teacher/account'
import { downloadArtifact, pageTargets, type TargetCardVO } from '@/api/teacher/schedule'
import { DICT_EDU_SUBJECT, useDictStore } from '@/store/dict'
import MSheet from './components/MSheet.vue'
import { fmtHours, money } from './shared'

const dict = useDictStore()

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
/** 逐生账户请求失败的学生数 —— 🔴 与「该生没开户」严格分开计数（BUG-1） */
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
          console.warn('[m/account] 该生账户拉取失败 studentId=', s.id, e)
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

/** 只有「全部请求都成功、确实一个账户都没有」才敢说没开户 */
const trulyEmpty = computed(
  () => !loading.value && !loadFailed.value && !failedCount.value && !groups.value.length,
)

function subjectLabel(code: string): string {
  return dict.label(DICT_EDU_SUBJECT, code) || code
}

function isOwe(a: TuitionAccountVO): boolean {
  return (a.hoursRemain ?? 0) < 0 || (a.amountRemain ?? 0) < 0
}

// ── 台账 ───────────────────────────────────────────────────────
const ledgerOpen = ref(false)
const ledgerLoading = ref(false)
const ledgerRows = ref<LedgerRowVO[]>([])
const curAccount = ref<TuitionAccountVO | null>(null)
const curStudentName = ref('')

const ledgerTitle = computed(() =>
  curAccount.value
    ? `课时消耗记录 · ${curStudentName.value}（${subjectLabel(curAccount.value.subject)}）`
    : '课时消耗记录',
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
    const res = await getAccountLedger(accountId, { pageNum: 1, pageSize: 100 })
    ledgerRows.value = res?.rows ?? []
  } catch (e) {
    console.warn('[m/account] 台账拉取失败', e)
    ledgerRows.value = []
  } finally {
    ledgerLoading.value = false
  }
}

async function openLedger(stu: StudentAccounts, a: TuitionAccountVO) {
  curAccount.value = a
  curStudentName.value = stu.name
  ledgerOpen.value = true
  await loadLedgerRows(a.id)
}

// ── 写操作四态（开户 / 改单价 / 充值 / 调整）────────────────────
// 一个 MSheet 壳吃四态，字段按 mode 显隐——与桌面 AccountEntryDialog 一一对应。
type EntryMode = 'open' | 'price' | 'recharge' | 'adjust'

const entryOpen = ref(false)
const entryMode = ref<EntryMode>('open')
const entrySaving = ref(false)
const entryForm = reactive({ studentId: '', subject: '', price: '', hours: '', amount: '', note: '' })

const entryTitle = computed(() => {
  const s = curAccount.value ? `${curStudentName.value}（${subjectLabel(curAccount.value.subject)}）` : ''
  switch (entryMode.value) {
    case 'open':
      return '开通学科账户'
    case 'price':
      return `改单价 · ${s}`
    case 'recharge':
      return `充值 · ${s}`
    default:
      return `调整 · ${s}`
  }
})

const entrySub = computed(() => {
  const a = curAccount.value
  switch (entryMode.value) {
    case 'open':
      return '开通即绑定该学科：之后能给这科建计划、记课时课费。初始课时/金额可留空，回头再充。'
    case 'price':
      return '只改以后结算用的单价；已扣过的记录按当时单价留档，不回溯。'
    case 'adjust':
      return `当前 ${a ? fmtHours(a.hoursRemain) : 0} 课时 / ${money(a?.amountRemain)}；课时与金额都能填负数（扣回记错的数）`
    default:
      return `当前 ${a ? fmtHours(a.hoursRemain) : 0} 课时 / ${money(a?.amountRemain)}；负数=欠费，充值后自动补平`
  }
})

/** 开户可选学科 = 全字典 − 该生已开过的（含停用的：那种去行内点「启用」，别重复开） */
const subjectOptions = computed(() => {
  const opened = new Set(
    (groups.value.find((g) => g.id === entryForm.studentId)?.accounts ?? []).map((a) => a.subject),
  )
  return dict.list(DICT_EDU_SUBJECT).filter((d) => !opened.has(d.dictValue))
})

/** 充值时按单价换算的参考金额（只提示不代填，两笔增量老师自己定；口径同桌面弹窗） */
const suggestAmount = computed(() => {
  if (entryMode.value !== 'recharge') return ''
  const price = curAccount.value?.lessonPrice ?? 0
  const h = parseFloat(entryForm.hours) || 0
  if (!price || !h) return ''
  return `按单价 ${price} 元 × ${h} 课时 = ${(price * h).toFixed(2)} 元`
})

function resetEntry() {
  entryForm.subject = ''
  entryForm.price = ''
  entryForm.hours = ''
  entryForm.amount = ''
  entryForm.note = ''
}

/** 开户：从页头进（学生下拉自选）或从某学生卡进（学生锁定） */
function openCreate(stu?: StudentAccounts) {
  entryMode.value = 'open'
  curAccount.value = null
  curStudentName.value = stu?.name ?? ''
  resetEntry()
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
  if (mode === 'price') entryForm.price = String(a.lessonPrice ?? 0)
  entryOpen.value = true
}

function num2(v: string): number {
  return Math.round((parseFloat(v) || 0) * 100) / 100
}

async function submitEntry() {
  if (entrySaving.value) return
  const mode = entryMode.value
  const acc = curAccount.value

  if (mode === 'open' || mode === 'price') {
    // 🔴 开户与改单价走同一个 upsertAccount（uk(student,subject) 冲突 = 改单价语义，不动余额）
    const studentId = entryForm.studentId
    const subject = mode === 'price' ? (acc?.subject ?? '') : entryForm.subject
    if (!studentId) {
      ElMessage.warning('请选择学生')
      return
    }
    if (!subject) {
      ElMessage.warning('请选择学科')
      return
    }
    const price = num2(entryForm.price)
    if (price < 0) {
      ElMessage.warning('课时单价不能为负')
      return
    }
    entrySaving.value = true
    try {
      const res = await upsertAccount({ studentId, subject, lessonPrice: price })
      if (mode === 'open') {
        // 初始课时/金额 = 顺手记一笔充值流水（余额只能经流水产生，D1 铁律）
        const hours = num2(entryForm.hours)
        const amount = num2(entryForm.amount)
        if (hours || amount) {
          await addAccountFlow(res.id, {
            flowType: '1',
            hoursDelta: hours,
            amountDelta: amount,
            note: entryForm.note.trim() || '开户初始',
          })
        }
        ElMessage.success('账户已开通')
      } else {
        ElMessage.success('单价已更新')
      }
    } catch {
      return // 拦截器已提示，弹层保持打开好让老师改了重试
    } finally {
      entrySaving.value = false
    }
  } else {
    if (!acc) return
    const hours = num2(entryForm.hours)
    const amount = num2(entryForm.amount)
    if (!hours && !amount) {
      ElMessage.warning('课时与金额不能同时为 0')
      return
    }
    if (mode === 'recharge' && (hours < 0 || amount < 0)) {
      ElMessage.warning('充值填正数；要扣回请用「调整」')
      return
    }
    entrySaving.value = true
    try {
      await addAccountFlow(acc.id, {
        flowType: mode === 'recharge' ? '1' : '4',
        hoursDelta: hours,
        amountDelta: amount,
        ...(entryForm.note.trim() ? { note: entryForm.note.trim() } : {}),
      })
      ElMessage.success(mode === 'recharge' ? '充值已记入' : '调整已记入')
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

// ── 停用 / 启用 ────────────────────────────────────────────────
const acting = ref('')

async function toggleStatus(stu: StudentAccounts, a: TuitionAccountVO) {
  const disable = a.status !== '1'
  const subj = subjectLabel(a.subject)
  if (disable) {
    const ok = await ElMessageBox.confirm(
      `停用后「${subj}」不再出现在建计划的学科里，这科的课也无法结算。余额和记录都保留，随时可以再启用。`,
      `停用 ${stu.name} 的${subj}账户`,
      { type: 'warning', confirmButtonText: '停用', cancelButtonText: '取消' },
    ).catch(() => false)
    if (!ok) return
  }
  acting.value = a.id
  try {
    await setAccountStatus(a.id, disable ? '1' : '0')
    ElMessage.success(disable ? '已停用' : '已启用')
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
    ElMessage.error('流水单生成失败')
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
  a.download = `课时流水单-${curStudentName.value}${subj ? '-' + subj : ''}.png`
  a.click()
}

/** 机器人发到老师本人飞书（D8）：dev 段验出图端点，bot 推送接线归上线段 */
async function sendLedgerToBot() {
  const ok = expUrl.value ? true : await buildLedgerPng()
  if (!ok) return
  ElMessage.success('已生成，bot 推送上线段接线')
}

onMounted(load)
</script>

<template>
  <section>
    <div class="m-sechead">
      <span class="m-sec">学生 × 学科 账户 · 点「记录」看消耗台账</span>
      <button class="m-btn ghost" :disabled="loading || loadFailed" @click="openCreate()">＋ 开户</button>
    </div>

    <div v-if="loading" class="m-empty">加载中…</div>

    <!-- 🔴 BUG-1：加载失败必须现形，绝不伪装成「没开户」 -->
    <div v-else-if="loadFailed" class="m-failbar">
      <span>账户加载失败——这是接口/网络问题，不代表没有开户。</span>
      <button class="m-btn ghost" @click="load">重试</button>
    </div>
    <template v-else>
      <div v-if="failedCount" class="m-failbar">
        <span>{{ failedCount }} 名学生的账户加载失败，下面的清单不完整。</span>
        <button class="m-btn ghost" @click="load">重试</button>
      </div>
      <!-- BUG-3/B：空态不再指路电脑端，右上角就能开户 -->
      <div v-if="trulyEmpty" class="m-empty">还没有账户 —— 点右上角开户</div>
    </template>

    <div v-for="g in groups" :key="g.id" class="m-card m-stu">
      <div class="stuhead">
        <div class="name">{{ g.name }}</div>
        <button class="mini" @click="openCreate(g)">＋ 开新科</button>
      </div>
      <template v-for="a in g.accounts" :key="a.id">
        <div class="m-acct" :class="{ owe: isOwe(a), off: a.status === '1' }">
          <span class="m-chip subj">{{ subjectLabel(a.subject) }}</span>
          <span v-if="a.status === '1'" class="m-chip warn">已停用</span>
          <span class="price">单价 {{ money(a.lessonPrice) }}/课时</span>
          <div class="nums" role="button" tabindex="0" @click="openLedger(g, a)" @keyup.enter="openLedger(g, a)">
            <div class="h">{{ fmtHours(a.hoursRemain) }}<em>课时</em></div>
            <div class="mm">{{ money(a.amountRemain) }}<template v-if="isOwe(a)"> · 欠费</template></div>
          </div>
          <button class="mini" @click="openLedger(g, a)">记录</button>
          <button class="mini" @click="openEntry('recharge', g, a)">充值</button>
        </div>
        <!-- 写操作第二行（BUG-3/B）：一行塞不下六个按钮，次要动作下沉一行 -->
        <div class="m-rowact acctmore">
          <button @click="openEntry('adjust', g, a)">调整</button>
          <button @click="openEntry('price', g, a)">改单价</button>
          <button :disabled="acting === a.id" @click="toggleStatus(g, a)">
            {{ a.status === '1' ? '启用' : '停用' }}
          </button>
        </div>
      </template>
    </div>

    <!-- 课时消耗台账 -->
    <MSheet
      v-model="ledgerOpen"
      :title="ledgerTitle"
      sub="日期 · 上课时间 · 内容 · 消耗 · 剩余——充值(重置)与冲正同列展示；消耗按实扣课时（默认 1 场=1 课时）"
    >
      <div v-if="ledgerLoading" class="m-empty">加载中…</div>
      <div v-else-if="!ledgerRows.length" class="m-empty">暂无记录</div>
      <template v-else>
        <div v-for="(f, i) in ledgerRows" :key="i" class="m-lrow" :class="rowClass(f.flowType)">
          <div class="ld">
            <div class="dd">{{ (f.date || '').slice(5) || '—' }}</div>
            <div v-if="f.timeRange" class="tt">{{ f.timeRange }}</div>
          </div>
          <div class="lc">{{ f.content || '—' }}</div>
          <div class="ln">
            <div class="delta">
              {{ (f.hoursDelta ?? 0) > 0 ? '+' : '' }}{{ fmtHours(f.hoursDelta) }} 课时
            </div>
            <div v-if="f.hoursAfter !== null && f.hoursAfter !== undefined" class="after">
              剩 {{ fmtHours(f.hoursAfter) }}
            </div>
          </div>
        </div>
      </template>

      <template #acts>
        <button class="m-btn ghost" @click="ledgerOpen = false">关闭</button>
        <button class="m-btn pri" :disabled="!ledgerRows.length" @click="openExport">
          导出流水（Excel 版式）
        </button>
      </template>
    </MSheet>

    <!-- 开户 / 改单价 / 充值 / 调整（四态共壳，语义同桌面 AccountEntryDialog）-->
    <MSheet v-model="entryOpen" :title="entryTitle" :sub="entrySub">
      <template v-if="entryMode === 'open'">
        <div class="m-field">
          <label for="m-stu">学生</label>
          <select id="m-stu" v-model="entryForm.studentId">
            <option v-for="s in students" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </div>
        <div class="m-field">
          <label for="m-subj">学科</label>
          <select id="m-subj" v-model="entryForm.subject">
            <option value="">请选择</option>
            <option v-for="d in subjectOptions" :key="d.dictValue" :value="d.dictValue">
              {{ d.dictLabel }}
            </option>
          </select>
        </div>
      </template>

      <div v-if="entryMode === 'open' || entryMode === 'price'" class="m-field">
        <label for="m-price">课时单价（元/课时）</label>
        <input id="m-price" v-model="entryForm.price" type="number" step="10" inputmode="decimal" />
      </div>

      <template v-if="entryMode !== 'price'">
        <div class="m-field">
          <label for="m-hrs">{{ entryMode === 'open' ? '初始课时（可留空）' : '课时数' }}</label>
          <input id="m-hrs" v-model="entryForm.hours" type="number" step="0.5" inputmode="decimal" />
        </div>
        <div class="m-field">
          <label for="m-amt">{{ entryMode === 'open' ? '初始金额（可留空）' : '金额（元）' }}</label>
          <input id="m-amt" v-model="entryForm.amount" type="number" step="0.01" inputmode="decimal" />
        </div>
        <p v-if="suggestAmount" class="m-note">{{ suggestAmount }}</p>
        <div class="m-field">
          <label for="m-note">备注</label>
          <input id="m-note" v-model="entryForm.note" placeholder="如：暑期第二期 / 补记 7-28 少上的一节" />
        </div>
      </template>

      <template #acts>
        <button class="m-btn ghost" @click="entryOpen = false">取消</button>
        <button class="m-btn pri" :disabled="entrySaving" @click="submitEntry">
          {{ entrySaving ? '保存中…' : '保存' }}
        </button>
      </template>
    </MSheet>

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
        <button class="m-btn ghost" @click="expOpen = false">关闭</button>
        <button class="m-btn ghost" :disabled="!expUrl" @click="downloadLedgerPng">下载图片</button>
        <button class="m-btn pri" :disabled="expLoading" @click="sendLedgerToBot">
          机器人发到我的飞书
        </button>
      </template>
    </MSheet>
  </section>
</template>
