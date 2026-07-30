<script setup lang="ts">
/**
 * PRD-015 批5 · /m/settle 待结算（V21）。
 *
 * D4 只提醒不自动扣：过点场次进清单，老师勾选 →「一键结算」弹层逐场可改**实扣课时**
 * （默认 1，两位小数，D5）+ 实际上课时间备注，金额 = 实扣课时 × 单价实时重算，
 * 可勾「同时生成本课反馈壳」（D12 默认勾选）→ settleSessions。
 * 已结场次展示 + 「改请假」= 走既有 leave 链，BE 在同事务内冲正返还（D5/AC6），前端只做二次确认提示。
 *
 * 🔴 已处理清单没有独立端点：按 D1「场次=一条线的交点」，直接从 getCalendar 近 14 天里
 *    挑 settleStatus 已结/已冲正的场次渲染，与桌面端同一数据源。
 * 🔴 BE 未就绪 → 空态兜底不白屏；结算/请假失败由 http 拦截器提示，页面不吞错。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  getCalendar,
  sessionLeave,
  settleSessions,
  type CalendarSessionVO,
  type SettleItemBo,
} from '@/api/teacher/schedule'
import { DICT_EDU_SUBJECT, useDictStore } from '@/store/dict'
import MSheet from './components/MSheet.vue'
import { dayLabel, fmtDate, hhmm, money, todayStr, usePending } from './shared'

const dict = useDictStore()
const { pendingList, pendingLoading, refreshPending } = usePending()

// ── 勾选态（默认全不选：钱线动作必须显式点选，防误触批量结算——补回归挂账②）──
const checked = ref<Set<string>>(new Set())

function syncChecked() {
  checked.value = new Set()
}

function toggle(id: string) {
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
  timeNote: string
}

const sheetOpen = ref(false)
const genFeedback = ref(true)
const submitting = ref(false)
const rows = reactive<SettleRow[]>([])

function rowFee(r: SettleRow): number {
  const h = Math.max(0, parseFloat(r.hours) || 0)
  return h * (r.price || 0)
}

function openSettleSheet() {
  const picked = pendingList.value.filter((p) => checked.value.has(p.sessionId))
  if (!picked.length) {
    ElMessage.warning('先勾选要结算的场次')
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
      timeNote: '',
    })),
  )
  genFeedback.value = true
  sheetOpen.value = true
}

async function confirmSettle() {
  submitting.value = true
  try {
    const items: SettleItemBo[] = rows.map((r) => {
      const h = Math.max(0, parseFloat(r.hours) || 0)
      return {
        sessionId: r.sessionId,
        hours: Math.round(h * 100) / 100,
        ...(r.timeNote.trim() ? { timeNote: r.timeNote.trim() } : {}),
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
      ElMessage.success(msg)
    }
    // 全部被跳过（未开户/已结算幂等/班课…）时不能报"成功"，把 BE 的 reason 原样给老师
    if (skipped.length) {
      ElMessage({
        type: 'warning',
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
    await ElMessageBox.confirm(
      `将「${s.targetName} ${s.sessionDate} ${hhmm(s.startTime)}」改为请假：已扣的课时与课费会自动冲正返还，未填内容的反馈壳会被删除。确认？`,
      '改请假',
      { type: 'warning', confirmButtonText: '确认改请假', cancelButtonText: '再想想' },
    )
  } catch {
    return
  }
  try {
    await sessionLeave(s.id)
    ElMessage.success('已改请假：课时课费已冲正返还')
    await reloadAll()
  } catch {
    // 拦截器已提示
  }
}

onMounted(reloadAll)
</script>

<template>
  <section>
    <div class="m-hint">
      <template v-if="pendingList.length">
        有 <b>{{ pendingList.length }} 场</b>已过点未结算——勾选后一键结算：扣课时课费 + 标已上 + 生成反馈壳。
      </template>
      <template v-else-if="pendingLoading">正在查过点未结算的场次…</template>
      <template v-else>当前没有待结算场次 ✓</template>
    </div>

    <div class="m-sec">过点未结算</div>
    <div v-if="pendingLoading" class="m-empty">加载中…</div>
    <div v-else-if="!pendingList.length" class="m-empty">干净！</div>
    <template v-else>
      <div v-for="p in pendingList" :key="p.sessionId" class="m-card m-sess">
        <input
          type="checkbox"
          :checked="checked.has(p.sessionId)"
          :aria-label="`选中 ${p.targetName}`"
          @change="toggle(p.sessionId)"
        />
        <div class="body">
          <div class="who">
            {{ p.targetName }}
            <span v-if="p.subject" class="m-chip subj">{{ dict.label(DICT_EDU_SUBJECT, p.subject) }}</span>
          </div>
          <div class="meta">
            {{ dayLabel(p.date) }} {{ hhmm(p.start) }}–{{ hhmm(p.end) }}
            <template v-if="p.planLessonTitle"> · {{ p.planLessonTitle }}</template>
          </div>
        </div>
        <div class="fee">
          <div class="n">{{ money(p.price) }}</div>
          <div class="u">默认 1 课时</div>
        </div>
      </div>
    </template>

    <div class="m-sec">近几日已处理</div>
    <div v-if="doneLoading" class="m-empty">加载中…</div>
    <div v-else-if="!doneList.length" class="m-empty">近 14 天没有已结算场次</div>
    <template v-else>
      <div v-for="s in doneList" :key="s.id" class="m-card">
        <div class="m-sess">
          <div class="body">
            <div class="who">
              {{ s.targetName }}
              <span v-if="s.subjectLabel" class="m-chip subj">{{ s.subjectLabel }}</span>
              <span v-if="s.settleStatus === '2'" class="m-chip rev">已冲正</span>
              <span v-else class="m-chip ok">已上·已结</span>
            </div>
            <div class="meta">
              {{ dayLabel(s.sessionDate) }} {{ hhmm(s.startTime) }}–{{ hhmm(s.endTime) }}
              <template v-if="s.lessonTitle"> · {{ s.lessonTitle }}</template>
            </div>
          </div>
        </div>
        <div v-if="s.settleStatus === '1'" class="m-rowact">
          <button class="neg" @click="onLeave(s)">改请假（冲正返还）</button>
        </div>
      </div>
    </template>

    <div v-if="pendingList.length" class="m-settlebar">
      <button class="m-btn pri" :disabled="!selectedCount" @click="openSettleSheet">
        一键结算{{ selectedCount ? `（${selectedCount}）` : '' }}
      </button>
    </div>

    <MSheet
      v-model="sheetOpen"
      title="确认结算"
      sub="默认 1 课时/场；实扣课时可改（0.5、0.67、1.5…），金额=实扣课时×单价；全部可冲正"
    >
      <div v-for="r in rows" :key="r.sessionId" class="m-strow">
        <div class="top">
          <span class="who" style="font-weight: 600">{{ r.name }}</span>
          <span v-if="r.subjectLabel" class="m-chip subj">{{ r.subjectLabel }}</span>
          <span style="font-size: 12px; color: var(--m-ink3)">{{ money(r.price) }}/课时</span>
          <span class="fee">-{{ money(rowFee(r)) }}</span>
        </div>
        <div class="ctl">
          <label :for="`hrs-${r.sessionId}`">实扣课时</label>
          <input
            :id="`hrs-${r.sessionId}`"
            v-model="r.hours"
            class="hrs"
            type="number"
            min="0"
            step="0.01"
            inputmode="decimal"
          />
          <input
            v-model="r.timeNote"
            class="tmn"
            placeholder="实际上课时间备注，如 16:00–17:10（可空）"
          />
        </div>
      </div>

      <label style="display: flex; gap: 8px; align-items: center; font-size: 13px; margin-top: 6px">
        <input v-model="genFeedback" type="checkbox" style="accent-color: var(--m-brand)" />
        同时生成本课反馈壳
      </label>

      <template #acts>
        <button class="m-btn ghost" @click="sheetOpen = false">取消</button>
        <button class="m-btn pri" :disabled="submitting" @click="confirmSettle">
          {{ submitting ? '结算中…' : '确认扣费' }}
        </button>
      </template>
    </MSheet>
  </section>
</template>
