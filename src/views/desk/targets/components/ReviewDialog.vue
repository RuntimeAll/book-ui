<script setup lang="ts">
/**
 * PRD-C-213 B4 · 课后回收弹窗（设计稿 §6 B10）。
 *
 * 打开时机：SessionTable「已上」场次行点「回收」。
 * 逐题录入：优先从该场次备课包（getPrepPack sessionId）取题清单 → segs 展开成行
 *   （seg 名 + 段内序号 + 题干摘要，摘要走 questionListByIds 批查后剥文本）；无包则手动加行。
 * 每行 = result 三选（对/错/卡）+ 错/卡时选 cause（计算/概念辨析/策略/其他）。
 * 提交 submitReview → 结果面板展示 parentMsg（一键复制）+ portraitDelta 摘要（pending 信号，
 *   提示去肖像面板转正）。
 * 已有 review：顶部「已回收」态（对错统计 + 家长反馈可复制），rows 预填上一版，可覆盖重录。
 *
 * 🔴 家长反馈区只显示 parentMsg，旁边不出现任何内部字段（层数/素材源/星级）。
 * 🔴 BE 可能未起：getReview / getPrepPack / questionListByIds 全 try/catch，优雅降级不白屏。
 */
import { ref, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  getReview,
  getPrepPack,
  submitReview,
  type SessionVO,
  type ReviewVO,
  type ReviewSubmitResult,
  type ReviewItemResult,
  type ReviewResult,
  type ReviewCause,
  type PrepPackVO,
} from '@/api/teacher/schedule'
import { questionListByIds, type QuestionItem } from '@/api/question'

const props = defineProps<{
  visible: boolean
  session: SessionVO | null
}>()

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  /** 提交成功（场次已上，父层刷新 + 标记已回收） */
  (e: 'saved', sessionId: string): void
  /** 打开时探测到已有回收记录（父层标记已回收态，不刷新） */
  (e: 'reviewed-detected', sessionId: string): void
}>()

const innerVisible = computed({
  get: () => props.visible,
  set: (v) => emit('update:visible', v),
})

const RESULT_OPTS: ReviewResult[] = ['对', '错', '卡']
const CAUSE_OPTS: ReviewCause[] = ['计算', '概念辨析', '策略', '其他']

interface Row {
  question_id?: string
  seg: string
  seq: number
  result: ReviewResult | ''
  cause: ReviewCause | ''
  stem?: string
  manual?: boolean
}

const loading = ref(false)
const saving = ref(false)
const rows = ref<Row[]>([])
const teacherNote = ref('')
const existing = ref<ReviewVO | null>(null)
const submittedResult = ref<ReviewSubmitResult | null>(null)

const sessionTitle = computed(() => {
  const s = props.session
  if (!s) return ''
  const d = s.sessionDate || ''
  const t = (s.startTime || '').slice(0, 5)
  return `${d}${t ? ' ' + t : ''}`
})

// 已回收对错统计（上一版 itemResults）
const existingStat = computed(() => {
  const stat = { 对: 0, 错: 0, 卡: 0 }
  for (const it of existing.value?.itemResults || []) {
    if (it.result in stat) stat[it.result as keyof typeof stat]++
  }
  return stat
})

/** 题干纯文本摘要（剥 HTML / $..$ / markdown 记号，截断；只做 {{ }} 文本渲染不 v-html） */
function digest(q: QuestionItem): string {
  const raw = q.stemText || q.stemTextContent || ''
  const txt = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/\$([^$]*)\$/g, '$1')
    .replace(/[#*_>`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!txt) return q.stemImg ? '（图片题）' : '（题干无文本）'
  return txt.length > 28 ? txt.slice(0, 28) + '…' : txt
}

function reset() {
  loading.value = false
  saving.value = false
  rows.value = []
  teacherNote.value = ''
  existing.value = null
  submittedResult.value = null
}

async function load() {
  const s = props.session
  if (!s) return
  reset()
  loading.value = true

  // 1. 已有回收记录（BE 无记录应返 code:1+null；返错误码会弹一次 toast，见汇报待验证点）
  try {
    const r = await getReview(s.id)
    if (r && (r.version || (r.itemResults && r.itemResults.length))) {
      existing.value = r
      teacherNote.value = r.teacherNote || ''
      emit('reviewed-detected', s.id)
    }
  } catch {
    existing.value = null
  }

  // 2. 备课包（取题清单 + 段结构）
  let pack: PrepPackVO | null = null
  try {
    pack = await getPrepPack({ sessionId: s.id })
  } catch {
    pack = null
  }

  // 3. 建行：优先上一版 itemResults（覆盖语义，从上版起改），其次备课包 segs 展开
  if (existing.value?.itemResults?.length) {
    rows.value = existing.value.itemResults.map((it) => ({
      question_id: it.question_id,
      seg: it.seg,
      seq: it.seq,
      result: it.result,
      cause: it.cause,
    }))
  } else if (pack?.segs?.length) {
    rows.value = pack.segs.flatMap((seg) =>
      (seg.question_ids || []).map((qid, i) => ({
        question_id: qid,
        seg: seg.name,
        seq: i + 1,
        result: '' as const,
        cause: '' as const,
      })),
    )
  } else {
    rows.value = []
  }

  // 4. 题干摘要补全（批查，最多 100，失败静默留空）
  const ids = rows.value.map((r) => r.question_id).filter((x): x is string => !!x)
  if (ids.length) {
    try {
      const list = await questionListByIds(ids.slice(0, 100))
      const map = new Map((list || []).map((q) => [q.id, digest(q)]))
      rows.value.forEach((r) => {
        if (r.question_id) r.stem = map.get(r.question_id) || r.stem
      })
    } catch {
      /* 摘要失败不影响录入 */
    }
  }

  loading.value = false
}

watch(
  () => props.visible,
  (v) => {
    if (v) load()
  },
)

// —— 手动加/删行 ——
function addRow() {
  rows.value.push({ seg: '', seq: rows.value.length + 1, result: '', cause: '', manual: true })
}
function removeRow(idx: number) {
  rows.value.splice(idx, 1)
}

// 选到「对」时清掉 cause（对不需要错因）
function onResultChange(row: Row) {
  if (row.result === '对') row.cause = ''
}

// —— 提交 ——
async function onSubmit() {
  if (!props.session) return
  if (!rows.value.length) {
    ElMessage.warning('至少录入一行题目结果（可点「手动加行」）')
    return
  }
  for (const [i, r] of rows.value.entries()) {
    if (!r.result) {
      ElMessage.warning(`第 ${i + 1} 行还没选对 / 错 / 卡`)
      return
    }
    if ((r.result === '错' || r.result === '卡') && !r.cause) {
      ElMessage.warning(`第 ${i + 1} 行「${r.result}」需选错因`)
      return
    }
    if (r.manual && !r.seg.trim()) {
      ElMessage.warning(`第 ${i + 1} 行请填写所属段名`)
      return
    }
  }

  const itemResults: ReviewItemResult[] = rows.value.map((r) => ({
    question_id: r.question_id,
    seg: r.seg.trim(),
    seq: r.seq,
    result: r.result as ReviewResult,
    // 对：错因无意义，占位「其他」（BE 仅聚合错/卡）
    cause: (r.result === '错' || r.result === '卡' ? r.cause : r.cause || '其他') as ReviewCause,
  }))

  saving.value = true
  try {
    const res = await submitReview(props.session.id, {
      itemResults,
      teacherNote: teacherNote.value.trim() || undefined,
    })
    submittedResult.value = res
    emit('saved', props.session.id)
    ElMessage.success('已回收，家长反馈已生成')
  } finally {
    saving.value = false
  }
}

// —— 复制 ——
async function copyText(text?: string) {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('已复制到剪贴板')
  } catch {
    // 剪贴板 API 不可用时降级
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
      ElMessage.success('已复制到剪贴板')
    } catch {
      ElMessage.warning('复制失败，请手动选择文本复制')
    }
    document.body.removeChild(ta)
  }
}

function close() {
  innerVisible.value = false
}
</script>

<template>
  <el-dialog
    v-model="innerVisible"
    :title="`课后回收${sessionTitle ? ' · ' + sessionTitle : ''}`"
    width="720px"
    top="6vh"
    append-to-body
    class="rv-dialog"
  >
    <div v-loading="loading" class="rv-body">
      <!-- 结果面板（提交成功后）——————————————————————————————————— -->
      <template v-if="submittedResult">
        <div class="rv-done">
          <div class="rv-done-head">
            <el-icon class="ok-ic"><CircleCheck /></el-icon>
            <b>回收完成，家长反馈已生成</b>
          </div>

          <div class="rv-parent">
            <div class="rv-parent-top">
              <span class="rv-parent-t">家长反馈</span>
              <el-button size="small" text bg @click="copyText(submittedResult.parentMsg)">
                复制
              </el-button>
            </div>
            <pre class="rv-parent-msg">{{ submittedResult.parentMsg }}</pre>
          </div>

          <div v-if="submittedResult.portraitDelta?.length" class="rv-delta">
            <div class="rv-delta-t">
              本次生成 {{ submittedResult.portraitDelta.length }} 条待确认信号
              <span class="rv-delta-hint">— 去下方「肖像」面板转正后纳入长期画像</span>
            </div>
            <ul class="rv-delta-list">
              <li v-for="(sig, i) in submittedResult.portraitDelta" :key="i">
                <span class="rv-tag">{{ sig.tag }}</span>
                <span class="rv-evi">{{ sig.evidence }}</span>
                <span class="rv-pend">待确认</span>
              </li>
            </ul>
          </div>
          <div v-else class="rv-delta-empty">本次无错/卡题，未生成待确认信号 👍</div>
        </div>
      </template>

      <!-- 录入表单 ——————————————————————————————————————————————— -->
      <template v-else>
        <!-- 已回收提示条 -->
        <div v-if="existing" class="rv-exist">
          <div class="rv-exist-l">
            <b>已回收（第 {{ existing.version }} 版）</b>
            <span class="rv-exist-stat">
              对 {{ existingStat['对'] }} · 错 {{ existingStat['错'] }} · 卡 {{ existingStat['卡'] }}
            </span>
            <span class="rv-exist-warn">重新提交将覆盖上一版</span>
          </div>
          <div v-if="existing.parentMsg" class="rv-exist-r">
            <el-button size="small" text bg @click="copyText(existing.parentMsg)">
              复制上版家长反馈
            </el-button>
          </div>
        </div>

        <!-- 逐题录入表 -->
        <div class="rv-rows">
          <div class="rv-row rv-row-head">
            <span class="c-seg">段 / 序</span>
            <span class="c-stem">题干摘要</span>
            <span class="c-res">判定</span>
            <span class="c-cause">错因</span>
            <span class="c-del" />
          </div>

          <div v-for="(row, idx) in rows" :key="idx" class="rv-row">
            <span class="c-seg">
              <template v-if="row.manual">
                <el-input v-model="row.seg" size="small" placeholder="段名" class="seg-inp" />
                <el-input-number
                  v-model="row.seq"
                  size="small"
                  :min="1"
                  controls-position="right"
                  class="seq-inp"
                />
              </template>
              <template v-else>
                <b class="seg-name">{{ row.seg || '—' }}</b>
                <i class="seg-seq">#{{ row.seq }}</i>
              </template>
            </span>

            <span class="c-stem" :title="row.stem">{{ row.stem || '—' }}</span>

            <span class="c-res">
              <el-radio-group
                v-model="row.result"
                size="small"
                @change="onResultChange(row)"
              >
                <el-radio-button v-for="r in RESULT_OPTS" :key="r" :value="r">{{
                  r
                }}</el-radio-button>
              </el-radio-group>
            </span>

            <span class="c-cause">
              <el-select
                v-if="row.result === '错' || row.result === '卡'"
                v-model="row.cause"
                size="small"
                placeholder="错因"
                class="cause-sel"
              >
                <el-option v-for="c in CAUSE_OPTS" :key="c" :value="c" :label="c" />
              </el-select>
              <span v-else class="cause-na">—</span>
            </span>

            <span class="c-del">
              <el-button size="small" text type="danger" @click="removeRow(idx)">
                <el-icon><Delete /></el-icon>
              </el-button>
            </span>
          </div>

          <div v-if="!rows.length" class="rv-empty">
            该场次暂无备课材料题目 · 点「手动加行」逐题录入
          </div>
        </div>

        <div class="rv-add">
          <el-button size="small" text bg @click="addRow">＋ 手动加行</el-button>
        </div>

        <!-- 教师备注 -->
        <div class="rv-note">
          <label>课堂备注（内部，可空）</label>
          <el-input
            v-model="teacherNote"
            type="textarea"
            :rows="2"
            maxlength="1000"
            show-word-limit
            placeholder="今天的整体表现 / 需要跟进的点（不进家长反馈）"
          />
        </div>
      </template>
    </div>

    <template #footer>
      <template v-if="submittedResult">
        <el-button type="primary" @click="close">完成</el-button>
      </template>
      <template v-else>
        <el-button @click="close">取消</el-button>
        <el-button type="primary" :loading="saving" @click="onSubmit">
          {{ existing ? '重新回收（覆盖上一版）' : '提交回收' }}
        </el-button>
      </template>
    </template>
  </el-dialog>
</template>

<style scoped>
.rv-body {
  min-height: 120px;
}

/* 已回收提示条 */
.rv-exist {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  background: #fdf3e7;
  border: 1px solid #f4dcbd;
  border-radius: 9px;
  padding: 8px 12px;
  margin-bottom: 12px;
}
.rv-exist-l {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12.5px;
}
.rv-exist-l b {
  color: #b45309;
}
.rv-exist-stat {
  color: #5f716d;
  font-variant-numeric: tabular-nums;
}
.rv-exist-warn {
  color: #ba3a2a;
  font-size: 12px;
}
.rv-exist-r {
  margin-left: auto;
}

/* 逐题录入表 */
.rv-rows {
  border: 1px solid var(--bk-line);
  border-radius: 9px;
  overflow: hidden;
}
.rv-row {
  display: grid;
  grid-template-columns: 118px minmax(0, 1fr) 150px 118px 34px;
  gap: 8px;
  align-items: center;
  padding: 7px 10px;
  border-top: 1px solid #eef3f1;
  font-size: 12.5px;
}
.rv-row:first-child {
  border-top: none;
}
.rv-row-head {
  background: #f6faf9;
  color: #8ba09a;
  font-weight: 700;
  font-size: 11.5px;
  letter-spacing: 0.04em;
}
.c-seg {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.seg-name {
  color: var(--bk-teal-deep);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.seg-seq {
  color: #8ba09a;
  font-style: normal;
  flex: none;
}
.seg-inp {
  width: 64px;
}
.seq-inp {
  width: 78px;
}
.c-stem {
  color: #5f716d;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cause-sel {
  width: 108px;
}
.cause-na {
  color: #c3cecb;
}
.c-del {
  text-align: center;
}
.rv-empty {
  padding: 22px 10px;
  text-align: center;
  color: #8ba09a;
  font-size: 12.5px;
}
.rv-add {
  margin: 8px 0 4px;
}
.rv-note {
  margin-top: 6px;
}
.rv-note label {
  display: block;
  font-size: 12.5px;
  color: #5f716d;
  margin-bottom: 5px;
}

/* 结果面板 */
.rv-done {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.rv-done-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--bk-teal-deep);
}
.rv-done-head .ok-ic {
  font-size: 18px;
  color: var(--bk-teal);
}
.rv-parent {
  border: 1px solid var(--bk-line);
  border-radius: 10px;
  overflow: hidden;
}
.rv-parent-top {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #f6faf9;
  border-bottom: 1px solid #eef3f1;
}
.rv-parent-t {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--bk-ink);
}
.rv-parent-top .el-button {
  margin-left: auto;
}
.rv-parent-msg {
  margin: 0;
  padding: 12px 14px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.75;
  color: var(--bk-ink);
  white-space: pre-wrap;
  word-break: break-word;
}
.rv-delta {
  background: #f6faf9;
  border: 1px solid var(--bk-line);
  border-radius: 10px;
  padding: 10px 14px;
}
.rv-delta-t {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--bk-ink);
  margin-bottom: 8px;
}
.rv-delta-hint {
  font-weight: 400;
  color: #8ba09a;
}
.rv-delta-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rv-delta-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
}
.rv-tag {
  flex: none;
  font-weight: 700;
  color: #b45309;
  background: #fdf3e7;
  border-radius: 6px;
  padding: 1px 8px;
}
.rv-evi {
  color: #5f716d;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rv-pend {
  flex: none;
  font-size: 11px;
  color: #8ba09a;
}
.rv-delta-empty {
  font-size: 12.5px;
  color: #5f716d;
  padding: 4px 2px;
}
</style>
