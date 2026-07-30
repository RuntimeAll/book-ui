<script setup lang="ts">
/**
 * PRD-015 批5 · /m/account 课时账户（V22 / V26）。
 *
 * D2/D3：学生 × 学科各一账户 —— 学生分卡、学科分行（单价 / 剩余课时 / 剩余金额），
 *        余额可为负（欠费）→ 红显不拦截。
 * 「记录」= 课时消耗台账（手抄本数字版）：日期+上课时间 / 上课内容 / ±课时 / 本行后剩余，
 *          充值（重置）绿、冲正红，与扣课同列按时间倒序（getAccountLedger 已排好序，前端不重排）。
 * 「充值」= addAccountFlow(flowType='1')，金额与课时两笔增量独立传，服务端不代算。
 * 台账内「导出流水」= exportLedgerPng（D16 Excel 风格 PNG）→ 预览 + 「下载图片」真下载 +
 *          「机器人发到我的飞书」调同端点出图（bot 推送归上线段，D8/H5）。
 *
 * 🔴 账户/台账/导出端点由本卡批2 落地；未就绪时全部空态兜底，不白屏、不塞假数据。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  addAccountFlow,
  exportLedgerPng,
  getAccountLedger,
  listAccounts,
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
    const students: TargetCardVO[] = res?.rows ?? []
    let failed = 0
    const packs = await Promise.all(
      students.map(async (s) => {
        try {
          const list = await listAccounts(s.id)
          return { id: s.id, name: s.name, accounts: Array.isArray(list) ? list : [] }
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

// ── 充值 ───────────────────────────────────────────────────────
const chargeOpen = ref(false)
const charging = ref(false)
const chargeForm = reactive({ amount: '', hours: '', note: '' })

const chargeTitle = computed(() =>
  curAccount.value ? `充值 · ${curStudentName.value}（${subjectLabel(curAccount.value.subject)}）` : '充值',
)
const chargeSub = computed(() => {
  const a = curAccount.value
  if (!a) return ''
  return `当前 ${fmtHours(a.hoursRemain)} 课时 / ${money(a.amountRemain)}；负数=欠费，充值后自动补平`
})

function openCharge(stu: StudentAccounts, a: TuitionAccountVO) {
  curAccount.value = a
  curStudentName.value = stu.name
  chargeForm.amount = ''
  chargeForm.hours = ''
  chargeForm.note = ''
  chargeOpen.value = true
}

async function submitCharge() {
  const a = curAccount.value
  if (!a) return
  const amountDelta = Math.round((parseFloat(chargeForm.amount) || 0) * 100) / 100
  const hoursDelta = Math.round((parseFloat(chargeForm.hours) || 0) * 100) / 100
  if (!amountDelta && !hoursDelta) {
    ElMessage.warning('金额与课时至少填一项')
    return
  }
  charging.value = true
  try {
    await addAccountFlow(a.id, {
      flowType: '1',
      hoursDelta,
      amountDelta,
      ...(chargeForm.note.trim() ? { note: chargeForm.note.trim() } : {}),
    })
    chargeOpen.value = false
    ElMessage.success(`充值成功：+${fmtHours(hoursDelta)} 课时 / +${money(amountDelta)}`)
    await load()
    // 台账正开着 → 同步刷新（余额与台账即时更新，V22）
    if (ledgerOpen.value) await loadLedgerRows(a.id)
  } catch {
    // 拦截器已提示
  } finally {
    charging.value = false
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
    <div class="m-sec">学生 × 学科 账户 · 点「记录」看消耗台账</div>

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
      <div v-if="trulyEmpty" class="m-empty">还没有开户的学生（开户在电脑端学生详情里做）</div>
    </template>

    <div v-for="g in groups" :key="g.id" class="m-card m-stu">
      <div class="name">{{ g.name }}</div>
      <div v-for="a in g.accounts" :key="a.id" class="m-acct" :class="{ owe: isOwe(a) }">
        <span class="m-chip subj">{{ subjectLabel(a.subject) }}</span>
        <span class="price">单价 {{ money(a.lessonPrice) }}/课时</span>
        <div class="nums" role="button" tabindex="0" @click="openLedger(g, a)" @keyup.enter="openLedger(g, a)">
          <div class="h">{{ fmtHours(a.hoursRemain) }}<em>课时</em></div>
          <div class="mm">{{ money(a.amountRemain) }}<template v-if="isOwe(a)"> · 欠费</template></div>
        </div>
        <button class="mini" @click="openLedger(g, a)">记录</button>
        <button class="mini" @click="openCharge(g, a)">充值</button>
      </div>
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

    <!-- 充值 -->
    <MSheet v-model="chargeOpen" :title="chargeTitle" :sub="chargeSub">
      <div class="m-field">
        <label for="m-amt">金额（元）</label>
        <input id="m-amt" v-model="chargeForm.amount" type="number" step="0.01" inputmode="decimal" />
      </div>
      <div class="m-field">
        <label for="m-hrs">课时数</label>
        <input id="m-hrs" v-model="chargeForm.hours" type="number" step="0.5" inputmode="decimal" />
      </div>
      <div class="m-field">
        <label for="m-note">备注</label>
        <input id="m-note" v-model="chargeForm.note" placeholder="如：暑期第二期" />
      </div>
      <template #acts>
        <button class="m-btn ghost" @click="chargeOpen = false">取消</button>
        <button class="m-btn pri" :disabled="charging" @click="submitCharge">
          {{ charging ? '保存中…' : '保存' }}
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
