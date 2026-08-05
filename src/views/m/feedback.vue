<script setup lang="ts">
/**
 * PRD-015 · /m/feedback 课后反馈（V23）—— **Vant 4 版**（PRD-018 批3：D10 独立建单）。
 *
 * 顶部学生 chips：「今天上课」的学生（当日 getCalendar 有场次）前置高亮，其余排后；切学生 = 切该生
 * 计划的反馈列表（pageSheets(planId)，D6 反馈绑计划/场次）。没填内容的单（rows 为空）标「待补内容」，
 * 点开逐条填五列内容保存（updateSheet）。
 * 导出：exportPlanPng 单图 / 长图双模式，默认单图=最新一单，模式记 localStorage（D13）。
 *
 * 🔴 **PRD-018 D10 域间解耦**：结算**不再副作用式建反馈壳**了 —— 反馈单从此**独立建**。
 *    所以本页必须自带「建单」入口（否则手机上一张反馈单都新建不出来，结算页那句
 *    「去反馈页单独建」就成了死路）。建单时**代码从课程计划拉课次主题做默认填充**
 *    （拉不到照样能建，绝不因为没计划/没排课就挡住建单——这正是 D10 的点）。
 *
 * 🔴 家长可见物红线：卷面文案零内部词——序号只出「{seq} · 日期」，不写"第几次/第 N 节课"（D7）。
 * 🔴 seq 由服务端按计划自动递增，前端只读展示不回写。
 *
 * 🔴 2026-07-31 Vant 化（**只换皮不换骨**）：ElMessage → showToast/showFailToast；手搓 chips →
 *    van-button 圆角组；手搓 seg → van-tabs；裸 input → van-field。
 *    probeShells 懒探针、isShell 定性口径、saveEdit 回传 sessionId/planId 防覆盖绑定 —— 逻辑一行未动。
 */
import { computed, onMounted, ref } from 'vue'
import { showFailToast, showSuccessToast, showToast } from 'vant'
import 'vant/es/toast/style'
import {
  createSheet,
  downloadArtifact,
  exportPlanPng,
  getSheet,
  pageSheets,
  updateSheet,
  type FeedbackRow,
  type FeedbackSheetBrief,
  type FeedbackSheetDetail,
} from '@/api/teacher/feedback'
import {
  getCalendar,
  getPlan,
  pageTargets,
  type PlanLessonVO,
  type TargetCardVO,
} from '@/api/teacher/schedule'
import MSheet from './components/MSheet.vue'
import { todayStr } from './shared'

const EXPORT_MODE_KEY = 'fb_export_mode'

const students = ref<TargetCardVO[]>([])
const todayIds = ref<Set<string>>(new Set())
const selId = ref('')
const loading = ref(false)

const sheets = ref<FeedbackSheetBrief[]>([])
const sheetsLoading = ref(false)
/** sheetId → 已填内容条数（懒探针缓存，见 probeShells 注释） */
const rowCounts = ref<Record<string, number>>({})

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
    void probeShells(sheets.value)
  } catch (e) {
    console.warn('[m/feedback] 反馈列表拉取失败', e)
    sheets.value = []
  } finally {
    sheetsLoading.value = false
  }
}

/**
 * 「待补内容」探针（sheetId → 内容条数）。
 * 🔴 为什么要探：D7 规定壳的 title 存 NULL、导出时动态拼，所以**填完内容 title 依然是空**——
 *    只看 title 会把已填的单一直标成壳。列表契约 FeedbackSheetBrief 不带条数字段（批0 已冻结，
 *    加 rowCount 属 BE 契约变更，不在本批范围），故对「title 为空」的少数行懒查一次详情定性，
 *    结果按 sheet id 缓存不重复查；探针没回来/失败时回落 title 启发式，不阻塞列表渲染。
 */
async function probeShells(list: FeedbackSheetBrief[]) {
  const todo = list.filter((f) => !f.title && rowCounts.value[f.id] === undefined).slice(0, 20)
  if (!todo.length) return
  const got = await Promise.all(
    todo.map(async (f) => {
      try {
        const d = await getSheet(f.id)
        return [f.id, (d.rows || []).length] as const
      } catch {
        return [f.id, -1] as const // 探针失败 = 未知，保持 title 兜底
      }
    }),
  )
  const next = { ...rowCounts.value }
  for (const [id, n] of got) if (n >= 0) next[id] = n
  rowCounts.value = next
}

function selectStudent(id: string) {
  if (selId.value === id) return
  selId.value = id
  void loadSheets()
}

/**
 * 空单 = 一条内容都没填（探针已定性用条数，未定性时回落 title 启发式）。
 * 🔄 D10 之后不再有「结算自动生成的壳」这回事，但**建了还没填**的单仍是这个态。
 */
function isShell(row: FeedbackSheetBrief): boolean {
  const n = rowCounts.value[row.id]
  return n === undefined ? !row.title : n === 0
}

/** 列表副标题：有标题出标题，没标题但已填内容出条数，空单出引导语 */
function previewOf(row: FeedbackSheetBrief): string {
  if (isShell(row)) return '还没填内容——点开补'
  if (row.title) return row.title
  const n = rowCounts.value[row.id]
  return n ? `已填 ${n} 条内容` : '已填内容'
}

function rowTitle(row: FeedbackSheetBrief): string {
  const seq = row.lessonSeq ? `${row.lessonSeq} · ` : ''
  return `${seq}${row.lessonDate || '未填日期'}`
}

// ── 新建反馈单（PRD-018 D10：结算不再建壳，这里是唯一入口）──────────────
const newOpen = ref(false)
const newDate = ref(todayStr())
const newLessonId = ref('')
const creating = ref(false)
/** 该生计划的课次（只为「代码填充默认内容」，拉不到不挡建单） */
const planLessons = ref<PlanLessonVO[]>([])
const lessonsLoading = ref(false)
const datePickerOpen = ref(false)
const datePicked = ref<string[]>([])
const lessonPickerOpen = ref(false)
const dateMin = new Date(new Date().getFullYear() - 3, 0, 1)
const dateMax = new Date()

const lessonColumns = computed(() => [
  { text: '不选（自己写）', value: '' },
  ...planLessons.value.map((l) => ({ text: `${l.lessonSeq}. ${l.title}`, value: l.id })),
])

const newLessonTitle = computed(
  () => planLessons.value.find((l) => l.id === newLessonId.value)?.title || '',
)

/** 拉计划课次做默认填充；🔴 失败/没计划都只是「没得填」，绝不阻断建单（D10 弱引用） */
async function loadPlanLessons() {
  const s = selStudent.value
  planLessons.value = []
  if (!s?.planId) return
  lessonsLoading.value = true
  try {
    const p = await getPlan(s.planId)
    planLessons.value = p?.lessons ?? []
  } catch (e) {
    console.warn('[m/feedback] 计划课次拉取失败（不影响建单）', e)
  } finally {
    lessonsLoading.value = false
  }
}

function openNew() {
  if (!selStudent.value) {
    showToast('先选一个学生')
    return
  }
  newDate.value = todayStr()
  newLessonId.value = ''
  newOpen.value = true
  void loadPlanLessons()
}

function openDatePicker() {
  const [y, m, dd] = (newDate.value || todayStr()).split('-')
  datePicked.value = [y, m, dd]
  datePickerOpen.value = true
}

function onPickDate() {
  const [y, m, dd] = datePicked.value
  if (y && m && dd) newDate.value = `${y}-${m}-${dd}`
  datePickerOpen.value = false
}

function onPickLesson({ selectedOptions }: { selectedOptions: { value?: string | number }[] }) {
  const v = selectedOptions[0]?.value
  newLessonId.value = v == null ? '' : String(v)
  lessonPickerOpen.value = false
}

async function submitNew() {
  const s = selStudent.value
  if (!s || creating.value) return
  if (!newDate.value) {
    showToast('请选择上课日期')
    return
  }
  creating.value = true
  try {
    // 代码填充：选了课次就把课次主题带进「学习内容」，没选就建个空单自己写
    const title = newLessonTitle.value
    const rows: FeedbackRow[] = title
      ? [{ seq: 1, module: '', content: title, mastery: '', weakness: '' }]
      : []
    const res = await createSheet({
      targetId: s.id,
      title: '',
      lessonDate: newDate.value,
      rows,
      // 🔴 弱引用：有计划就挂上（序号按 lesson_date 读取时实时排），没有照样建得出来
      ...(s.planId ? { planId: s.planId } : {}),
    })
    newOpen.value = false
    showSuccessToast('反馈单已建，接着填内容')
    await loadSheets()
    if (res?.id) await openEdit(res.id)
  } catch {
    // 拦截器已提示
  } finally {
    creating.value = false
  }
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

async function openEdit(sheetId: string) {
  editOpen.value = true
  editLoading.value = true
  editDetail.value = null
  editRows.value = []
  try {
    const d = await getSheet(sheetId)
    editDetail.value = d
    rowCounts.value = { ...rowCounts.value, [d.id]: (d.rows || []).length }
    editRows.value = (d.rows && d.rows.length ? d.rows : [emptyRow()]).map((r) => ({
      module: r.module || '',
      content: r.content || '',
      mastery: r.mastery || '',
      weakness: r.weakness || '',
      kp_id: r.kp_id ?? null,
    }))
  } catch {
    showFailToast('加载失败')
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
    showToast('至少填一条内容')
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
    // 本地即刻定性（保存后徽标从「待补内容」翻篇，不等下一次探针）
    rowCounts.value = { ...rowCounts.value, [d.id]: rows.length }
    editOpen.value = false
    showSuccessToast('已保存')
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
const expTab = computed(() => (expMode.value === 'long' ? 1 : 0))

function revokeExp() {
  if (expUrl.value) {
    URL.revokeObjectURL(expUrl.value)
    expUrl.value = ''
  }
}

async function buildExport(): Promise<boolean> {
  const s = selStudent.value
  if (!s?.planId) {
    showToast('该学生还没有课程计划，无法按计划导出')
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
    showFailToast('导出失败')
    return false
  } finally {
    expLoading.value = false
  }
}

async function openExport() {
  if (!sheets.value.length) {
    showToast('该学生还没有反馈可导出')
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

function onExportTab({ name }: { name: number | string }) {
  void setMode(Number(name) === 1 ? 'long' : 'single')
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
  showSuccessToast('已生成，bot 推送上线段接线')
}

onMounted(async () => {
  await loadStudents()
  await loadSheets()
})
</script>

<template>
  <section>
    <van-loading v-if="loading" class="m-note" size="18">加载中…</van-loading>
    <van-empty v-else-if="!students.length" image="search" image-size="70" description="还没有学生" />

    <template v-else>
      <div class="m-chiprow">
        <span v-if="todayChips.length" class="m-note" style="margin: 0">今天上课</span>
        <van-button
          v-for="s in todayChips"
          :key="s.id"
          round
          size="small"
          :type="selId === s.id ? 'primary' : 'default'"
          :plain="selId !== s.id"
          @click="selectStudent(s.id)"
        >
          {{ s.name }}
        </van-button>
        <span v-if="restChips.length" class="m-note" style="margin: 0">其他</span>
        <van-button
          v-for="s in restChips"
          :key="s.id"
          round
          size="small"
          :type="selId === s.id ? 'primary' : 'default'"
          @click="selectStudent(s.id)"
        >
          {{ s.name }}
        </van-button>
      </div>

      <van-cell-group inset :title="planTitle">
        <!-- D10：结算不再建壳 → 建单入口挂在这（点得到才算数） -->
        <van-cell title="课后反馈单" label="结算不再自动建单，这里手动建">
          <template #value>
            <van-button size="small" type="primary" plain icon="plus" @click="openNew">
              新建反馈单
            </van-button>
          </template>
        </van-cell>
        <van-loading v-if="sheetsLoading" class="m-note" size="18">加载中…</van-loading>
        <van-empty v-else-if="!sheets.length" image="search" image-size="70" description="该学生还没有反馈">
          <van-button round type="primary" icon="plus" @click="openNew">建第一张</van-button>
        </van-empty>
        <template v-else>
          <van-cell v-for="f in sheets" :key="f.id" clickable is-link @click="openEdit(f.id)">
            <template #title>
              <span class="m-rowtitle">
                <van-tag :type="isShell(f) ? 'warning' : 'primary'" round size="medium">
                  {{ f.lessonSeq ?? '·' }}
                </van-tag>
                <b>{{ rowTitle(f) }}</b>
                <van-tag v-if="isShell(f)" type="warning" plain>待补内容</van-tag>
              </span>
            </template>
            <template #label>{{ previewOf(f) }}</template>
          </van-cell>
        </template>
      </van-cell-group>

      <div style="padding: 12px">
        <van-button type="primary" block icon="photo-o" @click="openExport">导出反馈</van-button>
      </div>
    </template>

    <!-- 新建反馈单（D10 独立建单：日期必填，课次只用来带出默认内容） -->
    <MSheet
      v-model="newOpen"
      title="新建反馈单"
      sub="选上课日期即可建单；挑一个课次会把课次主题带进「学习内容」，没有计划也照样能建"
    >
      <van-cell-group inset>
        <van-field
          :model-value="selStudent?.name || ''"
          label="学生"
          readonly
          placeholder="先在上面选学生"
        />
        <van-field
          :model-value="newDate"
          label="上课日期"
          placeholder="选择日期"
          readonly
          is-link
          @click="openDatePicker"
        >
          <template v-if="newDate === todayStr()" #button>
            <van-tag type="primary" plain>今天</van-tag>
          </template>
        </van-field>
        <van-field
          :model-value="newLessonTitle"
          label="课次主题"
          :placeholder="
            lessonsLoading ? '正在读计划…' : planLessons.length ? '可选，用来带出默认内容' : '该生没有计划课次，直接建'
          "
          readonly
          :is-link="!!planLessons.length"
          @click="planLessons.length && (lessonPickerOpen = true)"
        />
      </van-cell-group>
      <template #acts>
        <van-button block @click="newOpen = false">取消</van-button>
        <van-button block type="primary" :loading="creating" loading-text="创建中…" @click="submitNew">
          建单并填内容
        </van-button>
      </template>
    </MSheet>

    <!-- 上课日期 -->
    <van-popup v-model:show="datePickerOpen" position="bottom" round>
      <van-date-picker
        v-model="datePicked"
        title="上课日期"
        :min-date="dateMin"
        :max-date="dateMax"
        @confirm="onPickDate"
        @cancel="datePickerOpen = false"
      />
    </van-popup>

    <!-- 课次（只为默认填充，可不选） -->
    <van-popup v-model:show="lessonPickerOpen" position="bottom" round>
      <van-picker
        title="选择课次"
        :columns="lessonColumns"
        @confirm="onPickLesson"
        @cancel="lessonPickerOpen = false"
      />
    </van-popup>

    <!-- 逐条填写 -->
    <MSheet v-model="editOpen" :title="editTitle" sub="五列简化为逐条卡片，手机上顺手填">
      <van-loading v-if="editLoading" class="m-note" size="18">加载中…</van-loading>
      <template v-else>
        <van-cell-group v-for="(r, i) in editRows" :key="i" inset :title="`第 ${i + 1} 条`">
          <van-field v-model="r.module" label="所属模块" placeholder="如：分数应用题" />
          <van-field v-model="r.content" label="学习内容" placeholder="这节讲了什么" type="textarea" rows="1" autosize />
          <van-field v-model="r.mastery" label="掌握情况" placeholder="学生表现" type="textarea" rows="1" autosize />
          <van-field v-model="r.weakness" label="不足点" placeholder="待加强的地方" type="textarea" rows="1" autosize />
          <van-cell v-if="editRows.length > 1">
            <template #value>
              <van-button size="mini" type="danger" plain @click="delRow(i)">删除这条</van-button>
            </template>
          </van-cell>
        </van-cell-group>
        <div style="padding: 4px 16px">
          <van-button block icon="plus" @click="addRow">加一条</van-button>
        </div>
      </template>
      <template #acts>
        <van-button block @click="editOpen = false">取消</van-button>
        <van-button
          block
          type="primary"
          :loading="saving"
          loading-text="保存中…"
          :disabled="editLoading"
          @click="saveEdit"
        >
          保存
        </van-button>
      </template>
    </MSheet>

    <!-- 导出预览 -->
    <MSheet
      v-model="expOpen"
      title="导出反馈"
      sub="版式=系统现有导出模板；默认单图=最新一单，长图=整计划拼接，记住上次选择"
    >
      <van-tabs :active="expTab" @click-tab="onExportTab">
        <van-tab title="单图" />
        <van-tab title="长图" />
      </van-tabs>
      <div class="m-png">
        <div v-if="expLoading" class="loading">出图中…</div>
        <img v-else-if="expUrl" :src="expUrl" alt="课后反馈" />
        <div v-else class="loading">未能生成图片</div>
      </div>
      <template #acts>
        <van-button block @click="expOpen = false">关闭</van-button>
        <van-button block :disabled="!expUrl" @click="downloadExport">下载图片</van-button>
        <van-button block type="primary" :loading="expLoading" @click="sendToBot">发到飞书</van-button>
      </template>
    </MSheet>
  </section>
</template>
