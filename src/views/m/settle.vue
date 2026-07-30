<script setup lang="ts">
/**
 * PRD-015 · /m/settle 待结算（V21）—— **Vant 4 版**。
 *
 * D4 只提醒不自动扣：过点场次进清单，老师勾选 →「一键结算」弹层逐场可改**实扣课时**
 * （默认 1，两位小数，D5）+ **直接改上课起止时间**（BUG-5/D：默认=排课时间，改了即在结算前
 * 走既有 updateSession 改期链更新场次，未改则一个字节都不动，也不写冗余备注），
 * 金额 = 实扣课时 × 单价实时重算，可勾「同时生成本课反馈壳」（D12 默认勾选）→ settleSessions。
 *
 * 🔴 未开户（price=null）口径照搬桌面 SettleDialog（BUG-2）：标「未开户」、金额列「—」、
 *    默认不可勾选——单价未知绝不画成 ¥0，那等于告诉老师这节课免费。
 * 已结场次展示 + 「改请假」= 走既有 leave 链，BE 在同事务内冲正返还（D5/AC6），前端只做二次确认提示。
 *
 * 🔴 已处理清单没有独立端点：按 D1「场次=一条线的交点」，直接从 getCalendar 近 14 天里
 *    挑 settleStatus 已结/已冲正的场次渲染，与桌面端同一数据源。
 * 🔴 BE 未就绪 → 空态兜底不白屏；结算/请假失败由 http 拦截器提示，页面不吞错。
 *
 * 🔴 2026-07-31 Vant 化（**只换皮不换骨**）：ElMessage/ElMessageBox → showToast/showConfirmDialog；
 *    裸 checkbox → van-checkbox；手搓底部条 → van-submit-bar；el-time-picker → van-picker-group
 *    包两个 van-time-picker（起/止两步，手机上滚轮选时比 EP 的桌面下拉靠谱得多）。
 *    settleable / 默认全不选 / 先改期后结算的顺序 / skipped 提示 —— 逻辑一行未动。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { showConfirmDialog, showSuccessToast, showToast } from 'vant'
import 'vant/es/toast/style'
import 'vant/es/dialog/style'
import {
  getCalendar,
  sessionLeave,
  settleSessions,
  updateSession,
  type CalendarSessionVO,
  type PendingSettlementVO,
  type SettleItemBo,
} from '@/api/teacher/schedule'
import { DICT_EDU_SUBJECT, useDictStore } from '@/store/dict'
import MSheet from './components/MSheet.vue'
import { dayLabel, fmtDate, hhmm, money, todayStr, usePending } from './shared'

const dict = useDictStore()
const { pendingList, pendingLoading, refreshPending } = usePending()

// ── 未开户口径（BUG-2，照搬桌面 SettleDialog.settleable）────────────────
// 🔴 price === null = 该生该科**未开户**（BE pendingRow 明写「无账户 = null 不是 0」）。
//    单价未知 ≠ 免费：不能算成 ¥0，否则整屏「课费全是零」；行内标「未开户」、金额列「—」、
//    默认不可勾选（BE settleOne 也会 skipped 兜底，前端先拦住少走一趟）。
function settleable(p: PendingSettlementVO): boolean {
  return p.price !== null && p.price !== undefined
}

const blockedCount = computed(() => pendingList.value.filter((p) => !settleable(p)).length)

/** 不可结算的原因（BUG-3/A）：账户停用与从没开户是两回事，别一律劝人去开户 */
function blockReason(p: PendingSettlementVO): string {
  return p.accountStatus === '1' ? '该科账户已停用，先在账户页启用' : '未开通该科账户，先去账户页开户'
}

// ── 勾选态（默认全不选：钱线动作必须显式点选，防误触批量结算——补回归挂账②）──
const checked = ref<Set<string>>(new Set())

function syncChecked() {
  checked.value = new Set()
}

function toggle(id: string) {
  const hit = pendingList.value.find((p) => p.sessionId === id)
  if (hit && !settleable(hit)) return // 未开户不可勾
  const s = new Set(checked.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  checked.value = s
}

const selectedCount = computed(() => checked.value.size)

// ── 近几日已处理（getCalendar 近 14 天 → 已结 / 已冲正）────────
const doneList = ref<CalendarSessionVO[]>([])
const doneLoading = ref(false)

async function loadDone() {
  doneLoading.value = true
  const from = new Date()
  from.setDate(from.getDate() - 13)
  try {
    const data = await getCalendar({ start: fmtDate(from), end: todayStr() })
    doneList.value = (Array.isArray(data) ? data : [])
      .filter((s) => s.settleStatus === '1' || s.settleStatus === '2')
      .sort((a, b) => (b.sessionDate + b.startTime).localeCompare(a.sessionDate + a.startTime))
  } catch (e) {
    console.warn('[m/settle] 已处理清单拉取失败', e)
    doneList.value = []
  } finally {
    doneLoading.value = false
  }
}

async function reloadAll() {
  await Promise.all([refreshPending(), loadDone()])
  syncChecked()
}

// ── 结算确认弹层 ──────────────────────────────────────────────
interface SettleRow {
  sessionId: string
  name: string
  subjectLabel: string
  price: number
  /** 实扣课时（input 绑字符串，提交时转 number；默认 1） */
  hours: string
  /** 该场排课日期（改期需整条 date+start+end 一起传） */
  date: string
  /** 排课起止（BUG-5/D：默认值，用户直接在这改；改了 = 改场次时间） */
  start: string
  end: string
  /** 打开弹层那一刻的排课起止快照，用来判「改没改」 */
  start0: string
  end0: string
}

const sheetOpen = ref(false)
const genFeedback = ref(true)
const submitting = ref(false)
const rows = reactive<SettleRow[]>([])

function rowFee(r: SettleRow): number {
  const h = Math.max(0, parseFloat(r.hours) || 0)
  return h * (r.price || 0)
}

/** 该行的上课时间被改过？（BUG-5/D：改了才走改期，没改一个字节都不动） */
function timeChanged(r: SettleRow): boolean {
  return !!r.start && !!r.end && (r.start !== r.start0 || r.end !== r.end0)
}

function openSettleSheet() {
  // 🔴 未开户的即使被旧勾选态带进来也剔掉（BUG-2：单价未知不可结算）
  const picked = pendingList.value.filter((p) => checked.value.has(p.sessionId) && settleable(p))
  if (!picked.length) {
    showToast('先勾选要结算的场次')
    return
  }
  rows.splice(
    0,
    rows.length,
    ...picked.map((p) => ({
      sessionId: p.sessionId,
      name: p.targetName,
      subjectLabel: dict.label(DICT_EDU_SUBJECT, p.subject) || '',
      price: p.price || 0,
      hours: '1',
      date: p.date,
      start: hhmm(p.start),
      end: hhmm(p.end),
      start0: hhmm(p.start),
      end0: hhmm(p.end),
    })),
  )
  genFeedback.value = true
  sheetOpen.value = true
}

// ── 上课时间选择器（van-picker-group：起 / 止 两步滚轮）────────────────
// 🔴 复用「排课/改期同款语义」= 同日改起止的 HH:mm 两个值，不引入日期维度（改日期仍在电脑端）。
const tpOpen = ref(false)
const tpIdx = ref(-1)
const tpStart = ref<string[]>(['09', '00'])
const tpEnd = ref<string[]>(['10', '30'])

function splitHm(v: string, fallback: string[]): string[] {
  const m = /^(\d{2}):(\d{2})$/.exec(v || '')
  return m ? [m[1], m[2]] : fallback
}

function openTimePicker(i: number) {
  const r = rows[i]
  if (!r) return
  tpIdx.value = i
  tpStart.value = splitHm(r.start, ['09', '00'])
  tpEnd.value = splitHm(r.end, ['10', '30'])
  tpOpen.value = true
}

function tpConfirm() {
  const r = rows[tpIdx.value]
  if (r) {
    r.start = tpStart.value.join(':')
    r.end = tpEnd.value.join(':')
  }
  tpOpen.value = false
}

async function confirmSettle() {
  // BUG-5/D：先把改过时间的场次走既有改期链（PUT session/{id}，同日改起止，不触发顺延），
  // 再结算——顺序不能反：先扣费后改期会让流水与场次时间对不上。
  const retimed = rows.filter(timeChanged)
  const bad = retimed.find((r) => r.start >= r.end)
  if (bad) {
    showToast(`「${bad.name}」的结束时间要晚于开始时间`)
    return
  }
  submitting.value = true
  try {
    for (const r of retimed) {
      await updateSession(r.sessionId, { date: r.date, start: r.start, end: r.end })
    }
    if (retimed.length) {
      for (const r of retimed) {
        r.start0 = r.start
        r.end0 = r.end
      }
      showSuccessToast(`已更新 ${retimed.length} 场的上课时间`)
    }
    const items: SettleItemBo[] = rows.map((r) => {
      const h = Math.max(0, parseFloat(r.hours) || 0)
      return {
        sessionId: r.sessionId,
        hours: Math.round(h * 100) / 100,
      }
    })
    const res = await settleSessions({ items, genFeedback: genFeedback.value })
    sheetOpen.value = false
    const n = res?.settled ?? items.length
    const shells = res?.feedbackSheetIds?.length || 0
    const skipped = res?.skipped || []
    // 🔴 修复批：原来无条件说「反馈壳已生成」——散课/未绑计划的场次 BE 不建壳（SettlementService
    //    createFeedbackShell 只在 plan_id 非空时建），老师会去反馈页白等。按实际返回条数说话，
    //    与桌面端 SettleDialog 同口径。
    if (n > 0) {
      let msg = `已结算 ${n} 场：扣费完成`
      if (genFeedback.value) {
        msg += shells > 0 ? `，生成 ${shells} 张反馈壳` : '；散课/未绑计划的场次不生成反馈壳'
      }
      showSuccessToast(msg)
    }
    // 全部被跳过（未开户/已结算幂等/班课…）时不能报"成功"，把 BE 的 reason 原样给老师
    if (skipped.length) {
      showToast({
        message: `${skipped.length} 场跳过：${skipped.map((s) => s.reason).join('；')}`,
        duration: 6000,
      })
    }
    await reloadAll()
  } catch {
    // 拦截器已提示（含重复结算的幂等业务码文案）
  } finally {
    submitting.value = false
  }
}

// ── 改请假（冲正返还）───────────────────────────────────────
async function onLeave(s: CalendarSessionVO) {
  try {
    await showConfirmDialog({
      title: '改请假',
      message: `将「${s.targetName} ${s.sessionDate} ${hhmm(s.startTime)}」改为请假：已扣的课时与课费会自动冲正返还，未填内容的反馈壳会被删除。确认？`,
      confirmButtonText: '确认改请假',
      cancelButtonText: '再想想',
    })
  } catch {
    return
  }
  try {
    await sessionLeave(s.id)
    showSuccessToast('已改请假：课时课费已冲正返还')
    await reloadAll()
  } catch {
    // 拦截器已提示
  }
}

onMounted(reloadAll)
</script>

<template>
  <section>
    <van-notice-bar wrapable :scrollable="false" :left-icon="pendingList.length ? 'warning-o' : 'passed'">
      <template v-if="pendingList.length">
        有 <b>{{ pendingList.length }} 场</b>已过点未结算——勾选后一键结算：扣课时课费 + 标已上 + 生成反馈壳。
        <template v-if="blockedCount">
          其中 <b>{{ blockedCount }} 场</b>取不到单价（没开户或账户停用），去「账户」页处理后才能结算。
        </template>
      </template>
      <template v-else-if="pendingLoading">正在查过点未结算的场次…</template>
      <template v-else>当前没有待结算场次</template>
    </van-notice-bar>

    <van-cell-group inset title="过点未结算">
      <van-loading v-if="pendingLoading" class="m-note" size="18">加载中…</van-loading>
      <van-empty v-else-if="!pendingList.length" image="search" description="干净！没有待结算场次" />
      <template v-else>
      <van-cell
        v-for="p in pendingList"
        :key="p.sessionId"
        :clickable="settleable(p)"
        @click="toggle(p.sessionId)"
      >
        <template #icon>
          <van-checkbox
            :model-value="checked.has(p.sessionId)"
            :disabled="!settleable(p)"
            style="margin-right: 10px"
            @click.stop="toggle(p.sessionId)"
          />
        </template>
        <template #title>
          <span class="m-rowtitle">
            <b :class="{ 'm-muted': !settleable(p) }">{{ p.targetName }}</b>
            <van-tag v-if="p.subject" type="primary" plain>
              {{ dict.label(DICT_EDU_SUBJECT, p.subject) }}
            </van-tag>
            <van-tag v-if="!settleable(p)" type="warning">
              {{ p.accountStatus === '1' ? '已停用' : '未开户' }}
            </van-tag>
          </span>
        </template>
        <template #label>
          {{ dayLabel(p.date) }} {{ hhmm(p.start) }}–{{ hhmm(p.end) }}
          <template v-if="p.planLessonTitle"> · {{ p.planLessonTitle }}</template>
          <span v-if="!settleable(p)" style="display: block; color: var(--m-warn)">
            {{ blockReason(p) }}
          </span>
        </template>
        <template #value>
          <!-- 🔴 BUG-2：单价未知画成「—」，绝不打成 ¥0（那等于告诉老师这节课免费） -->
          <template v-if="settleable(p)">
            <div class="m-num"><b>{{ money(p.price) }}</b></div>
            <div class="m-note" style="margin: 0">默认 1 课时</div>
          </template>
          <template v-else>
            <div class="m-muted"><b>—</b></div>
            <div class="m-note" style="margin: 0">单价未知</div>
          </template>
        </template>
      </van-cell>
      </template>
    </van-cell-group>

    <van-cell-group inset title="近几日已处理">
      <van-loading v-if="doneLoading" class="m-note" size="18">加载中…</van-loading>
      <van-empty v-else-if="!doneList.length" image="search" description="近 14 天没有已结算场次" />
      <template v-else>
      <van-cell v-for="s in doneList" :key="s.id">
        <template #title>
          <span class="m-rowtitle">
            <b>{{ s.targetName }}</b>
            <van-tag v-if="s.subjectLabel" type="primary" plain>{{ s.subjectLabel }}</van-tag>
            <van-tag v-if="s.settleStatus === '2'" type="danger">已冲正</van-tag>
            <van-tag v-else type="success">已上·已结</van-tag>
          </span>
        </template>
        <template #label>
          {{ dayLabel(s.sessionDate) }} {{ hhmm(s.startTime) }}–{{ hhmm(s.endTime) }}
          <template v-if="s.lessonTitle"> · {{ s.lessonTitle }}</template>
        </template>
        <template #value>
          <van-button v-if="s.settleStatus === '1'" size="mini" type="danger" plain @click="onLeave(s)">
            改请假（冲正返还）
          </van-button>
        </template>
      </van-cell>
      </template>
    </van-cell-group>

    <van-submit-bar
      v-if="pendingList.length"
      button-text="一键结算"
      button-type="primary"
      :disabled="!selectedCount"
      @submit="openSettleSheet"
    >
      <span class="m-note" style="margin: 0">
        已选 <b>{{ selectedCount }}</b> 场
      </span>
    </van-submit-bar>

    <MSheet
      v-model="sheetOpen"
      title="确认结算"
      sub="默认 1 课时/场；实扣课时可改（0.5、0.67、1.5…），金额=实扣课时×单价。上课时间默认=排课时间，改了即更新场次时间"
    >
      <van-cell-group v-for="(r, i) in rows" :key="r.sessionId" inset>
        <van-cell>
          <template #title>
            <span class="m-rowtitle">
              <b>{{ r.name }}</b>
              <van-tag v-if="r.subjectLabel" type="primary" plain>{{ r.subjectLabel }}</van-tag>
              <span class="m-note" style="margin: 0">{{ money(r.price) }}/课时</span>
            </span>
          </template>
          <template #value>
            <b class="m-num">-{{ money(rowFee(r)) }}</b>
          </template>
        </van-cell>
        <van-field
          v-model="r.hours"
          label="实扣课时"
          type="number"
          inputmode="decimal"
          placeholder="1"
        />
        <!-- BUG-5/D：上课时间直接改；改了即在结算前走既有改期链更新场次，不再手填备注 -->
        <van-field
          :model-value="`${r.start} – ${r.end}`"
          label="上课时间"
          readonly
          is-link
          @click="openTimePicker(i)"
        >
          <template v-if="timeChanged(r)" #button>
            <van-tag type="warning">将改期</van-tag>
          </template>
        </van-field>
      </van-cell-group>

      <van-cell-group inset>
        <van-cell title="同时生成本课反馈壳" center>
          <template #right-icon>
            <van-switch v-model="genFeedback" size="20" />
          </template>
        </van-cell>
      </van-cell-group>

      <template #acts>
        <van-button block @click="sheetOpen = false">取消</van-button>
        <van-button block type="primary" :loading="submitting" loading-text="结算中…" @click="confirmSettle">
          确认扣费
        </van-button>
      </template>
    </MSheet>

    <!-- 起 / 止 两步时间选择（Vant 官方的时间区间范式，比两个并排下拉在 390px 上好点得多） -->
    <van-popup v-model:show="tpOpen" position="bottom" round>
      <van-picker-group
        title="上课时间"
        :tabs="['开始时间', '结束时间']"
        next-step-text="下一步"
        @confirm="tpConfirm"
        @cancel="tpOpen = false"
      >
        <van-time-picker v-model="tpStart" :columns-type="['hour', 'minute']" />
        <van-time-picker v-model="tpEnd" :columns-type="['hour', 'minute']" />
      </van-picker-group>
    </van-popup>
  </section>
</template>
