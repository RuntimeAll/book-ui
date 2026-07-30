<script setup lang="ts">
/**
 * PRD-015 批5 · /m/feedback 课后反馈（V23）。
 *
 * 顶部学生 chips：「今天上课」的学生（当日 getCalendar 有场次）前置高亮，其余排后；切学生 = 切该生
 * 计划的反馈列表（pageSheets(planId)，D6 反馈绑计划/场次）。结算自动生成的壳（title 为空 = 未填内容，
 * D7「反馈壳标题存 NULL」）标「待补内容」，点开逐条填五列内容保存（updateSheet）。
 * 导出：exportPlanPng 单图 / 长图双模式，默认单图=最新一单，模式记 localStorage（D13）。
 *
 * 🔴 家长可见物红线：卷面文案零内部词——序号只出「{seq} · 日期」，不写"第几次/第 N 节课"（D7）。
 * 🔴 seq 由服务端按计划自动递增，前端只读展示不回写。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  downloadArtifact,
  exportPlanPng,
  getSheet,
  pageSheets,
  updateSheet,
  type FeedbackRow,
  type FeedbackSheetBrief,
  type FeedbackSheetDetail,
} from '@/api/teacher/feedback'
import { getCalendar, pageTargets, type TargetCardVO } from '@/api/teacher/schedule'
import MSheet from './components/MSheet.vue'
import { todayStr } from './shared'

const EXPORT_MODE_KEY = 'fb_export_mode'

const students = ref<TargetCardVO[]>([])
const todayIds = ref<Set<string>>(new Set())
const selId = ref('')
const loading = ref(false)

const sheets = ref<FeedbackSheetBrief[]>([])
const sheetsLoading = ref(false)

const selStudent = computed(() => students.value.find((s) => s.id === selId.value) || null)
const todayChips = computed(() => students.value.filter((s) => todayIds.value.has(s.id)))
const restChips = computed(() => students.value.filter((s) => !todayIds.value.has(s.id)))

const planTitle = computed(() => {
  const s = selStudent.value
  if (!s) return ''
  return s.planId ? `计划：${s.name} · ${s.planName || '未命名计划'}（序号自动递增）` : `${s.name}：暂无计划`
})

async function loadStudents() {
  loading.value = true
  try {
    const [res, cal] = await Promise.all([
      pageTargets({ targetType: '0', pageSize: 500 }),
      getCalendar({ start: todayStr(), end: todayStr() }).catch(() => []),
    ])
    students.value = res?.rows ?? []
    todayIds.value = new Set((Array.isArray(cal) ? cal : []).map((e) => e.targetId))
    // 默认选中：今天上课的第一个学生，没有则第一个学生
    const first = todayChips.value[0] || students.value[0]
    selId.value = first ? first.id : ''
  } catch (e) {
    console.warn('[m/feedback] 学生列表拉取失败', e)
    students.value = []
  } finally {
    loading.value = false
  }
}

async function loadSheets() {
  const s = selStudent.value
  if (!s) {
    sheets.value = []
    return
  }
  sheetsLoading.value = true
  try {
    // 有计划按计划查（D6 计划内序号语义），没计划回落按学生查
    const res = await pageSheets(s.planId ? { planId: s.planId } : { targetId: s.id })
    const rows = res?.rows ?? []
    sheets.value = rows
      .slice()
      .sort(
        (a, b) =>
          (b.lessonSeq ?? 0) - (a.lessonSeq ?? 0) ||
          (b.lessonDate || '').localeCompare(a.lessonDate || ''),
      )
  } catch (e) {
    console.warn('[m/feedback] 反馈列表拉取失败', e)
    sheets.value = []
  } finally {
    sheetsLoading.value = false
  }
}

function selectStudent(id: string) {
  if (selId.value === id) return
  selId.value = id
  void loadSheets()
}

/** 结算自动建的壳：标题空 = 还没填内容（D7 壳标题存 NULL，导出时动态拼） */
function isShell(row: FeedbackSheetBrief): boolean {
  return !row.title
}

function rowTitle(row: FeedbackSheetBrief): string {
  const seq = row.lessonSeq ? `${row.lessonSeq} · ` : ''
  return `${seq}${row.lessonDate || '未填日期'}`
}

// ── 逐条填写 ───────────────────────────────────────────────────
const editOpen = ref(false)
const editLoading = ref(false)
const saving = ref(false)
const editDetail = ref<FeedbackSheetDetail | null>(null)
const editRows = ref<FeedbackRow[]>([])

const editTitle = computed(() => (editDetail.value ? rowTitle(editDetail.value) : '填写反馈'))

function emptyRow(): FeedbackRow {
  return { module: '', content: '', mastery: '', weakness: '' }
}

async function openEdit(row: FeedbackSheetBrief) {
  editOpen.value = true
  editLoading.value = true
  editDetail.value = null
  editRows.value = []
  try {
    const d = await getSheet(row.id)
    editDetail.value = d
    editRows.value = (d.rows && d.rows.length ? d.rows : [emptyRow()]).map((r) => ({
      module: r.module || '',
      content: r.content || '',
      mastery: r.mastery || '',
      weakness: r.weakness || '',
      kp_id: r.kp_id ?? null,
    }))
  } catch {
    ElMessage.error('加载失败')
    editOpen.value = false
  } finally {
    editLoading.value = false
  }
}

function addRow() {
  editRows.value.push(emptyRow())
}

function delRow(i: number) {
  editRows.value.splice(i, 1)
}

async function saveEdit() {
  const d = editDetail.value
  if (!d) return
  const rows = editRows.value.filter((r) => r.module || r.content || r.mastery || r.weakness)
  if (!rows.length) {
    ElMessage.warning('至少填一条内容')
    return
  }
  saving.value = true
  try {
    await updateSheet(d.id, {
      targetId: d.targetId,
      // 壳标题留空由导出动态拼（D7）；已有标题原样保留
      title: d.title || '',
      lessonDate: d.lessonDate,
      rows: rows.map((r, idx) => ({
        seq: idx + 1,
        module: r.module || '',
        content: r.content || '',
        mastery: r.mastery || '',
        weakness: r.weakness || '',
        kp_id: r.kp_id ?? null,
      })),
      // 绑定原样回传，防 upsert 覆盖掉结算链写入的场次/计划绑定
      ...(d.sessionId ? { sessionId: d.sessionId } : {}),
      ...(d.planId ? { planId: d.planId } : {}),
    })
    editOpen.value = false
    ElMessage.success('已保存')
    await loadSheets()
  } catch {
    // 拦截器已提示
  } finally {
    saving.value = false
  }
}

// ── 导出（单图 / 长图，记住上次选择）──────────────────────────
const expOpen = ref(false)
const expLoading = ref(false)
const expUrl = ref('')
const expMode = ref<'single' | 'long'>(
  localStorage.getItem(EXPORT_MODE_KEY) === 'long' ? 'long' : 'single',
)

function revokeExp() {
  if (expUrl.value) {
    URL.revokeObjectURL(expUrl.value)
    expUrl.value = ''
  }
}

async function buildExport(): Promise<boolean> {
  const s = selStudent.value
  if (!s?.planId) {
    ElMessage.warning('该学生还没有课程计划，无法按计划导出')
    return false
  }
  expLoading.value = true
  try {
    const res = await exportPlanPng(s.planId, expMode.value)
    const blob = await downloadArtifact(res.file)
    revokeExp()
    expUrl.value = URL.createObjectURL(blob)
    return true
  } catch {
    ElMessage.error('导出失败')
    return false
  } finally {
    expLoading.value = false
  }
}

async function openExport() {
  if (!sheets.value.length) {
    ElMessage.warning('该学生还没有反馈可导出')
    return
  }
  expOpen.value = true
  revokeExp()
  await buildExport()
}

async function setMode(m: 'single' | 'long') {
  if (expMode.value === m) return
  expMode.value = m
  try {
    localStorage.setItem(EXPORT_MODE_KEY, m)
  } catch {
    // 隐私模式 quota 异常忽略，只是记不住模式
  }
  revokeExp()
  await buildExport()
}

function downloadExport() {
  if (!expUrl.value) return
  const a = document.createElement('a')
  a.href = expUrl.value
  a.download = `课后反馈-${selStudent.value?.name || ''}.png`
  a.click()
}

/** 机器人发到老师本人飞书（D8）：dev 段验出图端点，bot 推送接线归上线段 */
async function sendToBot() {
  const ok = expUrl.value ? true : await buildExport()
  if (!ok) return
  ElMessage.success('已生成，bot 推送上线段接线')
}

onMounted(async () => {
  await loadStudents()
  await loadSheets()
})
</script>

<template>
  <section>
    <div v-if="loading" class="m-empty">加载中…</div>
    <div v-else-if="!students.length" class="m-empty">还没有学生</div>

    <template v-else>
      <div class="m-chips">
        <span v-if="todayChips.length" class="lab">今天上课</span>
        <button
          v-for="s in todayChips"
          :key="s.id"
          class="m-stuchip today"
          :class="{ on: selId === s.id }"
          @click="selectStudent(s.id)"
        >
          {{ s.name }}
        </button>
        <span v-if="restChips.length" class="lab">其他</span>
        <button
          v-for="s in restChips"
          :key="s.id"
          class="m-stuchip"
          :class="{ on: selId === s.id }"
          @click="selectStudent(s.id)"
        >
          {{ s.name }}
        </button>
      </div>

      <div class="m-sec">{{ planTitle }}</div>

      <div v-if="sheetsLoading" class="m-empty">加载中…</div>
      <div v-else-if="!sheets.length" class="m-empty">该学生还没有反馈</div>
      <template v-else>
        <div
          v-for="f in sheets"
          :key="f.id"
          class="m-card m-fb"
          :class="{ shellcard: isShell(f) }"
          role="button"
          tabindex="0"
          @click="openEdit(f)"
          @keyup.enter="openEdit(f)"
        >
          <div class="ttl">
            <span class="m-seqbadge">{{ f.lessonSeq ?? '·' }}</span>
            <span class="t">{{ rowTitle(f) }}</span>
            <span v-if="isShell(f)" class="m-chip shell">待补内容</span>
            <span class="d">{{ f.targetName || '' }}</span>
          </div>
          <div class="pre">
            {{ isShell(f) ? '结算自动生成的占位壳——点开补内容' : f.title }}
          </div>
        </div>
      </template>

      <button class="m-btn pri" style="width: 100%; margin-top: 6px" @click="openExport">
        导出反馈
      </button>
    </template>

    <!-- 逐条填写 -->
    <MSheet v-model="editOpen" :title="editTitle" sub="五列简化为逐条卡片，手机上顺手填">
      <div v-if="editLoading" class="m-empty">加载中…</div>
      <template v-else>
        <div v-for="(r, i) in editRows" :key="i" class="m-fbrow">
          <div class="no">
            第 {{ i + 1 }} 条
            <button v-if="editRows.length > 1" @click="delRow(i)">删除</button>
          </div>
          <input v-model="r.module" placeholder="所属模块" />
          <input v-model="r.content" placeholder="学习内容" />
          <input v-model="r.mastery" placeholder="掌握情况" />
          <input v-model="r.weakness" placeholder="不足点" />
        </div>
        <button class="m-btn ghost" style="width: 100%" @click="addRow">＋ 加一条</button>
      </template>
      <template #acts>
        <button class="m-btn ghost" @click="editOpen = false">取消</button>
        <button class="m-btn pri" :disabled="saving || editLoading" @click="saveEdit">
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </template>
    </MSheet>

    <!-- 导出预览 -->
    <MSheet
      v-model="expOpen"
      title="导出反馈"
      sub="版式=系统现有导出模板；默认单图=最新一单，长图=整计划拼接，记住上次选择"
    >
      <div class="m-seg">
        <button :class="{ on: expMode === 'single' }" @click="setMode('single')">单图</button>
        <button :class="{ on: expMode === 'long' }" @click="setMode('long')">长图</button>
      </div>
      <div class="m-png">
        <div v-if="expLoading" class="loading">出图中…</div>
        <img v-else-if="expUrl" :src="expUrl" alt="课后反馈" />
        <div v-else class="loading">未能生成图片</div>
      </div>
      <template #acts>
        <button class="m-btn ghost" @click="expOpen = false">关闭</button>
        <button class="m-btn ghost" :disabled="!expUrl" @click="downloadExport">下载图片</button>
        <button class="m-btn pri" :disabled="expLoading" @click="sendToBot">机器人发到我的飞书</button>
      </template>
    </MSheet>
  </section>
</template>
