<script setup lang="ts">
/**
 * PRD-004 课后反馈单编辑页（/desk/feedback/edit/:id?）。
 * 新建态（无 id）：空白起。编辑态（带 id）：加载 getSheet 还原。
 * 五列表格行编辑（所属模块/学习内容/掌握情况/不足点），行增删 + 上下移排序；
 * 顶部学生/日期/标题；「保存」入库；「导出 PNG」先保存再出家长版长图预览。
 *
 * PRD-015 D6/D7（批4）：
 * - 元信息行加「计划 → 场次」联动下拉（选学生拉计划，选计划拉场次；场次可空 = D11 弹性骨架）；
 * - 🔴 AC8 时区修：默认上课日期改本地取法，东八区早 8 点前 toISOString() 会退到昨天。
 *
 * 🔴 PRD-018 D10 域间解耦（2026-08-05 批3）——用户拍板「排课/课程计划/课时收费/课程反馈
 *    本质上都是不互通的数据，可以前端拉过来，但是不能定死」：
 * - 结算链已撤 `createFeedbackShell` → **本页就是反馈单的独立建单入口**（不再靠结算副作用生单）；
 * - 支持 URL query 预填 `targetId / planId / sessionId / lessonId`（计划页「新建反馈单」按钮发出，
 *   key 名即契约不可改）；
 * - 新增「课次」下拉：选中课次即把课程计划里的**课次主题代码填充**进标题 / 首行学习内容
 *   （用户原话「内容可以代码填充」）。🔴 只填空白项，绝不覆盖老师已手写的内容；
 * - 🔴 **弱依赖**：计划详情拉不到 / 计划无课次 / query 的 lessonId 找不到 —— 一律 console.warn
 *   静默降级，页面照常能建单能保存。跨域数据缺失绝不阻断本域写入（D10 铁则①②）；
 * - 序号语义换轨（G9③）：`lessonSeq` = BE **读取时**按 `(lesson_date, id)` 实时排出的展示序号，
 *   不再是写入时 `max+1` 定格 —— 补录一单，其后各单序号自动顺移。FE 依旧**不回传**。
 */
import { ref, onMounted, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  getSheet,
  createSheet,
  updateSheet,
  exportPng,
  downloadArtifact,
  type FeedbackRow,
} from '@/api/teacher/feedback'
import {
  pageTargets,
  pagePlans,
  pageSessions,
  getPlan,
  SESSION_STATUS_LABEL,
  type TargetCardVO,
  type PlanVO,
  type PlanLessonVO,
  type SessionVO,
} from '@/api/teacher/schedule'

const route = useRoute()
const router = useRouter()

const id = ref<string>((route.params.id as string) || '')
const isEdit = computed(() => !!id.value)

const targetId = ref<string>('')
const planId = ref<string>('')
const sessionId = ref<string>('')
/** D10：课次只是「把计划主题拉过来」的取值口，**不入库**（PRD §8：反馈单表结构不动）。 */
const lessonId = ref<string>('')
const lessonSeq = ref<number | null>(null)
const title = ref<string>('')
const lessonDate = ref<string>('')
const rows = ref<FeedbackRow[]>([])

/**
 * 上课日期是否被老师亲手改过。
 * 🔴 新建态日期一进页就被塞了「今天」（AC8），所以「为空才填」这条判据对日期天然失效 ——
 *    用「还是系统默认值」代替「为空」，老师一改就锁死，代码填充再不动它。
 */
const lessonDateTouched = ref(false)

const students = ref<TargetCardVO[]>([])
const plans = ref<PlanVO[]>([])
const sessions = ref<SessionVO[]>([])
const lessons = ref<PlanLessonVO[]>([])
const plansLoading = ref(false)
const sessionsLoading = ref(false)
const lessonsLoading = ref(false)
const saving = ref(false)
const exporting = ref(false)

/**
 * 🔴 AC8：本地日期 yyyy-MM-dd。new Date().toISOString() 走 UTC，东八区 08:00 前会退到昨天
 * （用户凌晨/清早建单默认日期差一天）。一律用本地 getFullYear/Month/Date 拼。
 */
function todayLocal(): string {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
}

/** 该计划下的场次（升序；BE session/page 只吃 targetId，planId 前端筛） */
const planSessions = computed(() =>
  sessions.value
    .filter((s) => planId.value && String(s.planId || '') === String(planId.value))
    .sort((a, b) => `${a.sessionDate}${a.startTime}`.localeCompare(`${b.sessionDate}${b.startTime}`)),
)

function sessionLabel(s: SessionVO): string {
  const t = (s.startTime || '').slice(0, 5)
  const st = SESSION_STATUS_LABEL[s.sessionStatus] || ''
  return `${s.sessionDate}${t ? ' ' + t : ''}${st ? ' · ' + st : ''}`
}

function lessonLabel(l: PlanLessonVO): string {
  return `第${l.lessonSeq ?? '?'}次 · ${l.title || '未命名课次'}`
}

async function loadPlans(tid: string) {
  if (!tid) {
    plans.value = []
    return
  }
  plansLoading.value = true
  try {
    const res = await pagePlans({ targetId: tid, targetType: '0', pageSize: 200 })
    plans.value = res?.rows ?? []
  } catch {
    plans.value = []
  } finally {
    plansLoading.value = false
  }
}

async function loadSessions(tid: string) {
  if (!tid) {
    sessions.value = []
    return
  }
  sessionsLoading.value = true
  try {
    const res = await pageSessions({ targetId: tid, pageSize: 500 })
    sessions.value = res?.rows ?? []
  } catch {
    sessions.value = []
  } finally {
    sessionsLoading.value = false
  }
}

/**
 * 拉该计划的课次清单（D10：反馈域**从计划域把内容拉过来**用，只读、不建立强绑定）。
 * 🔴 弱依赖：接口失败 / 计划没课次 → 课次下拉留空 + console.warn，绝不 ElMessage.error 打断建单。
 * @returns 计划详情（失败返 null），供调用方从计划回推归属学生
 */
async function loadLessons(pid: string): Promise<PlanVO | null> {
  if (!pid) {
    lessons.value = []
    return null
  }
  lessonsLoading.value = true
  try {
    const p = await getPlan(pid)
    // 按 lessonSeq 升序展示（BE 一般已有序，这里只做防御性排序）
    lessons.value = (p?.lessons ?? []).slice().sort((a, b) => (a.lessonSeq ?? 0) - (b.lessonSeq ?? 0))
    return p ?? null
  } catch (e) {
    console.warn('[feedback] 课程计划课次拉取失败，跳过课次填充（不影响建单）：', pid, e)
    lessons.value = []
    return null
  } finally {
    lessonsLoading.value = false
  }
}

/** 一行是否已被写过东西（判「rows 还空着」用，避免把老师写的内容顶掉） */
function isRowFilled(r: FeedbackRow): boolean {
  return !!(
    (r.module || '').trim() ||
    (r.content || '').trim() ||
    (r.mastery || '').trim() ||
    (r.weakness || '').trim()
  )
}

/**
 * 🔴 D10 核心：把课程计划里的**课次主题代码填充**成默认值（用户原话「内容可以代码填充」）。
 *
 * 填三处，**每处都只在空白时填**，绝不覆盖老师已经手写的内容：
 * ① 标题为空 → 填课次 title；
 * ② rows 还全是空行 → 首行 content = 课次 title，module = 课次 tag（tag 是课次上唯一的自由分类
 *    标签，语义最接近反馈单的「所属模块」；tag 为空就留空让老师自己写，不硬凑）；
 * ③ 还没选场次、且该课次已排过场次 → 顺手带出场次 +（日期未被老师改过时）上课日期。
 *
 * 🔴 弱依赖：lessonId 在当前计划的课次里找不到（计划改过 / query 传了脏 id）→ console.warn 后
 *    直接返回，页面照常可建单可保存。
 */
function applyLessonDefaults(lid: string) {
  const lesson = lessons.value.find((l) => String(l.id) === String(lid))
  if (!lesson) {
    console.warn('[feedback] 该课次不在当前计划里，跳过默认填充（不影响建单）：', lid)
    return
  }
  const topic = (lesson.title || '').trim()
  if (topic) {
    if (!title.value.trim()) title.value = topic
    if (rows.value.every((r) => !isRowFilled(r))) {
      if (!rows.value.length) rows.value.push(emptyRow())
      const first = rows.value[0]
      first.content = topic
      if (lesson.tag) first.module = lesson.tag
    }
  }
  // ③ 已选场次时一律以老师选的为准（别用课次反推去顶掉）
  if (!sessionId.value) {
    const s = planSessions.value.find((x) => String(x.planLessonId || '') === String(lid))
    if (s) {
      sessionId.value = s.id
      if (!lessonDateTouched.value && s.sessionDate) lessonDate.value = s.sessionDate
    }
  }
}

/** 换学生 = 清计划/课次/场次（旧绑定不可能跨学生成立） */
async function onStudentChange(v: string) {
  planId.value = ''
  sessionId.value = ''
  lessonId.value = ''
  lessons.value = []
  await Promise.all([loadPlans(v), loadSessions(v)])
}

/** 换计划 = 清课次/场次 + 重拉该计划的课次（场次候选按新计划重筛） */
async function onPlanChange(v: string) {
  sessionId.value = ''
  lessonId.value = ''
  await loadLessons(v)
}

/** 选了课次 → 代码填充默认内容（只填空白项） */
function onLessonChange(v: string) {
  if (v) applyLessonDefaults(v)
}

/** 选了场次 → 上课日期跟场次走（D6：计划/课次/日期由场次自然带出） */
function onSessionChange(v: string) {
  const s = planSessions.value.find((x) => x.id === v)
  if (!s) return
  if (s.sessionDate) lessonDate.value = s.sessionDate
  // 场次已绑课次 → 回填课次选择器并按同一口径补默认内容（依旧只填空白项）
  if (!lessonId.value && s.planLessonId) {
    lessonId.value = String(s.planLessonId)
    applyLessonDefaults(lessonId.value)
  }
}

// 计划被清空时同步清场次/课次，避免留下跨计划的脏绑定
watch(planId, (v) => {
  if (!v) {
    sessionId.value = ''
    lessonId.value = ''
    lessons.value = []
  }
})

// —— PNG 预览 ——
const pngVisible = ref(false)
const pngUrl = ref('')

function emptyRow(): FeedbackRow {
  return { module: '', content: '', mastery: '', weakness: '' }
}

function addRow() {
  rows.value.push(emptyRow())
}

function delRow(i: number) {
  rows.value.splice(i, 1)
}

function moveUp(i: number) {
  if (i <= 0) return
  const arr = rows.value
  ;[arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]
}

function moveDown(i: number) {
  const arr = rows.value
  if (i >= arr.length - 1) return
  ;[arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]
}

function buildBo() {
  return {
    targetId: targetId.value || null,
    // PRD-015 D6：绑场次（可空）+ 冗余计划。
    // 🔴 PRD-018 G9③：lessonSeq **一律不传** —— 序号由 BE 读取时按 (lesson_date, id) 实时排出，
    //    不存在「写入时定格」这回事。课次 lessonId 同样不传（PRD §8：反馈单表结构不动，
    //    课次只是本页拉默认内容的取值口）。
    sessionId: sessionId.value || null,
    planId: planId.value || null,
    title: title.value,
    lessonDate: lessonDate.value || null,
    rows: rows.value.map((r, idx) => ({
      seq: idx + 1,
      module: r.module || '',
      content: r.content || '',
      mastery: r.mastery || '',
      weakness: r.weakness || '',
      kp_id: r.kp_id ?? null,
    })),
  }
}

async function save(): Promise<boolean> {
  saving.value = true
  try {
    if (isEdit.value) {
      await updateSheet(id.value, buildBo())
    } else {
      const res = await createSheet(buildBo())
      id.value = res.id
      // 建单后地址换到编辑态，避免重复建
      router.replace(`/desk/feedback/edit/${res.id}`)
    }
    // 序号由服务端读取时实时排（G9③），保存后回读一次让页面显示当前名次
    await refreshSeq()
    ElMessage.success('已保存')
    return true
  } catch {
    ElMessage.error('保存失败')
    return false
  } finally {
    saving.value = false
  }
}

async function onExport() {
  exporting.value = true
  try {
    const ok = await save()
    if (!ok) return
    const res = await exportPng(id.value)
    const blob = await downloadArtifact(res.file)
    if (pngUrl.value) URL.revokeObjectURL(pngUrl.value)
    pngUrl.value = URL.createObjectURL(blob)
    pngVisible.value = true
  } catch {
    ElMessage.error('导出失败')
  } finally {
    exporting.value = false
  }
}

function downloadPng() {
  const a = document.createElement('a')
  a.href = pngUrl.value
  a.download = (title.value || 'feedback') + '.png'
  a.click()
}

function goBack() {
  router.push('/desk/feedback')
}

async function loadStudents() {
  try {
    const res = await pageTargets({ targetType: '0', pageSize: 500 })
    students.value = res?.rows ?? []
  } catch {
    students.value = []
  }
}

/**
 * 保存后回读服务端排出的计划内序号。
 * 🔄 G9③：序号是**读取时**按 (lesson_date, id) 现排的名次，不是写入时定格的列值 ——
 *    补录一单会让其后各单序号顺移，所以每次保存后都得回读一次才是当前真相。
 */
async function refreshSeq() {
  if (!id.value) return
  try {
    const d = await getSheet(id.value)
    lessonSeq.value = d.lessonSeq ?? null
    planId.value = d.planId || planId.value
  } catch {
    /* 只是回显，失败不打断保存流程 */
  }
}

async function loadSheet() {
  if (!id.value) {
    rows.value = [emptyRow()]
    // 🔴 AC8：本地今天（旧 toISOString() 在东八区 08:00 前会退到昨天）
    lessonDate.value = todayLocal()
    return
  }
  try {
    const d = await getSheet(id.value)
    targetId.value = d.targetId || ''
    planId.value = d.planId || ''
    sessionId.value = d.sessionId || ''
    lessonSeq.value = d.lessonSeq ?? null
    title.value = d.title || ''
    lessonDate.value = d.lessonDate || ''
    // 已存盘的日期就是老师认过的，代码填充不得再动它
    lessonDateTouched.value = !!d.lessonDate
    if (targetId.value) {
      await Promise.all([loadPlans(targetId.value), loadSessions(targetId.value)])
    }
    if (planId.value) {
      // 编辑态也把课次拉出来（下拉可用 + 从已绑场次回显课次），但**不做任何填充** ——
      // 老师没点课次就别替他改内容。
      await loadLessons(planId.value)
      const bound = sessions.value.find((s) => String(s.id) === String(sessionId.value))
      if (bound?.planLessonId) lessonId.value = String(bound.planLessonId)
    }
    rows.value = (d.rows && d.rows.length ? d.rows : [emptyRow()]).map((r) => ({
      module: r.module || '',
      content: r.content || '',
      mastery: r.mastery || '',
      weakness: r.weakness || '',
      kp_id: r.kp_id ?? null,
    }))
  } catch {
    ElMessage.error('加载失败')
  }
}

/** query 取值助手（vue-router 的 query 值可能是数组 / null，统一压成字符串） */
function queryStr(name: string): string {
  const v = route.query[name]
  if (Array.isArray(v)) return String(v[0] ?? '')
  return v == null ? '' : String(v)
}

/**
 * 🔴 D10 独立建单：吃 URL query 预填 `targetId / planId / sessionId / lessonId`
 * （计划页「新建反馈单」按钮发出，key 名即契约不可改；四个都可选）。
 *
 * 只在**新建态**生效：编辑态以库里的绑定为准，不让 query 顶掉已存盘的数据。
 * 🔴 弱依赖：每一段都独立 try —— 学生/计划/课次任一拉不到都只是少填几个默认值，
 *    页面照常能建单能保存（D10 铁则②：跨域聚合只在读取层做，不进写入路径）。
 */
async function applyQueryPrefill() {
  if (isEdit.value) return
  const qTarget = queryStr('targetId')
  const qPlan = queryStr('planId')
  const qSession = queryStr('sessionId')
  const qLesson = queryStr('lessonId')
  if (!qTarget && !qPlan && !qSession && !qLesson) return

  if (qTarget) {
    targetId.value = qTarget
    await Promise.all([loadPlans(qTarget), loadSessions(qTarget)])
  }
  if (qPlan) {
    planId.value = qPlan
    const plan = await loadLessons(qPlan)
    // 只给了计划没给学生 → 从计划自身回推归属学生（拉不到就算了，下拉留空不报错）
    if (!targetId.value && plan?.targetId) {
      targetId.value = String(plan.targetId)
      await Promise.all([loadPlans(targetId.value), loadSessions(targetId.value)])
    }
  }
  if (qSession) {
    sessionId.value = qSession
    // 场次查得到就顺带补齐计划与上课日期（调用方只给场次时也能用）；查不到就原样预置不拦人
    const s = sessions.value.find((x) => String(x.id) === qSession)
    if (!s) {
      console.warn('[feedback] query 的场次不在该学生的场次里，只做原样预置：', qSession)
    } else {
      if (!planId.value && s.planId) {
        planId.value = String(s.planId)
        await loadLessons(planId.value)
      }
      if (!lessonDateTouched.value && s.sessionDate) lessonDate.value = s.sessionDate
    }
  }
  if (qLesson) {
    lessonId.value = qLesson
    applyLessonDefaults(qLesson)
  }
}

onMounted(async () => {
  await Promise.all([loadStudents(), loadSheet()])
  await applyQueryPrefill()
})
</script>

<template>
  <div class="fb-edit">
    <div class="fb-head">
      <el-button link @click="goBack">← 返回列表</el-button>
      <h2 class="fb-title">{{ isEdit ? '编辑反馈单' : '新建反馈单' }}</h2>
      <div class="fb-sp" />
      <el-button :loading="saving" @click="save">保存</el-button>
      <el-button type="primary" :loading="exporting" @click="onExport">导出 PNG</el-button>
    </div>

    <div class="fb-meta">
      <el-select
        v-model="targetId"
        placeholder="选择学生"
        clearable
        filterable
        class="fb-student"
        @change="onStudentChange"
      >
        <el-option v-for="s in students" :key="s.id" :label="s.name" :value="s.id" />
      </el-select>
      <el-select
        v-model="planId"
        :loading="plansLoading"
        :disabled="!targetId"
        placeholder="课程计划（可空）"
        clearable
        filterable
        class="fb-plan"
        @change="onPlanChange"
      >
        <el-option v-for="p in plans" :key="p.id" :label="p.name" :value="p.id" />
      </el-select>
      <!-- 🔴 D10：课次 = 从课程计划把主题「拉过来」的取值口，选中即代码填充默认内容；不入库 -->
      <el-select
        v-model="lessonId"
        :loading="lessonsLoading"
        :disabled="!planId"
        placeholder="课次（可空，带出主题）"
        clearable
        filterable
        class="fb-lesson"
        @change="onLessonChange"
      >
        <el-option v-for="l in lessons" :key="l.id" :label="lessonLabel(l)" :value="l.id" />
      </el-select>
      <el-select
        v-model="sessionId"
        :loading="sessionsLoading"
        :disabled="!planId"
        placeholder="上课场次（可空）"
        clearable
        filterable
        class="fb-session"
        @change="onSessionChange"
      >
        <el-option v-for="s in planSessions" :key="s.id" :label="sessionLabel(s)" :value="s.id" />
      </el-select>
      <span
        class="fb-seq"
        :title="'计划内序号：由系统按「上课日期」实时排出（补录一单，其后各单会自动顺移），不在保存时定格'"
      >
        序号 <b>{{ lessonSeq ?? '自动' }}</b>
      </span>
      <el-date-picker
        v-model="lessonDate"
        type="date"
        placeholder="上课日期"
        value-format="YYYY-MM-DD"
        class="fb-date"
        @change="lessonDateTouched = true"
      />
      <el-input v-model="title" placeholder="备注（可空，导出时跟在日期后）" class="fb-title-inp" />
    </div>

    <p class="fb-tip">
      选「课次」只是把课程计划里的主题带进来做默认值（<b>只填空白项</b>，不会覆盖你写的内容），
      课次本身不写进反馈单；计划拉不到也照样能建单保存。
      序号按<b>上课日期</b>实时排，补录早先的单子，后面的序号会自动顺移。
    </p>

    <table class="fb-table">
      <thead>
        <tr>
          <th style="width: 52px">序号</th>
          <th style="width: 130px">所属模块</th>
          <th>学习内容</th>
          <th style="width: 150px">掌握情况</th>
          <th style="width: 170px">不足点</th>
          <th style="width: 108px">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(r, i) in rows" :key="i">
          <td class="c">{{ i + 1 }}</td>
          <td><input v-model="r.module" class="cell" /></td>
          <td><input v-model="r.content" class="cell" /></td>
          <td><input v-model="r.mastery" class="cell" /></td>
          <td><input v-model="r.weakness" class="cell" /></td>
          <td class="ops">
            <span class="op" title="上移" @click="moveUp(i)">↑</span>
            <span class="op" title="下移" @click="moveDown(i)">↓</span>
            <span class="op del" title="删除" @click="delRow(i)">✕</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="6" class="empty">暂无行，点下方「加一行」</td>
        </tr>
      </tbody>
    </table>

    <div class="fb-add">
      <el-button size="small" @click="addRow">＋ 加一行</el-button>
    </div>

    <el-dialog v-model="pngVisible" title="家长版预览（可直接发微信）" width="680px">
      <div class="fb-png-preview">
        <img v-if="pngUrl" :src="pngUrl" alt="反馈单 PNG" />
      </div>
      <template #footer>
        <el-button @click="pngVisible = false">关闭</el-button>
        <el-button type="primary" @click="downloadPng">下载 PNG</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.fb-edit { padding: 4px 2px; }
.fb-head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.fb-title { font-size: 18px; font-weight: 800; color: #1c3330; margin: 0; }
.fb-sp { flex: 1; }
.fb-meta { display: flex; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; align-items: center; }
.fb-student { width: 150px; }
.fb-plan { width: 190px; }
.fb-lesson { width: 210px; }
.fb-session { width: 210px; }
.fb-seq { font-size: 12.5px; color: #6b8580; white-space: nowrap; cursor: help; }
.fb-seq b { color: #0e9285; font-size: 14px; }
.fb-tip { font-size: 12px; color: #8aa09b; line-height: 1.7; margin: -6px 0 12px; }
.fb-tip b { color: #6b8580; font-weight: 700; }
.fb-date { width: 160px; }
.fb-title-inp { flex: 1; }
.fb-table { border-collapse: collapse; width: 100%; font-size: 13px; background: #fff; }
.fb-table th, .fb-table td { border: 1px solid #e2eae8; padding: 6px 8px; text-align: left; }
.fb-table th { background: #f6faf9; font-size: 12.5px; color: #4d6863; font-weight: 700; }
.fb-table td.c { text-align: center; color: #8aa09b; }
.cell { border: none; outline: none; font-size: 13px; color: #1c3330; width: 100%; background: transparent; }
.cell:focus { background: #f0f7f6; }
.ops { white-space: nowrap; text-align: center; }
.op { display: inline-block; cursor: pointer; color: #8aa09b; padding: 0 4px; font-size: 13px; }
.op:hover { color: #0e9285; }
.op.del:hover { color: #e05c4b; }
.empty { text-align: center; color: #8aa09b; padding: 16px; }
.fb-add { margin-top: 10px; }
.fb-png-preview { text-align: center; max-height: 60vh; overflow: auto; background: #f4f7f7; padding: 12px; border-radius: 8px; }
.fb-png-preview img { max-width: 100%; box-shadow: 0 2px 12px rgba(0, 0, 0, .12); border-radius: 4px; }
</style>
