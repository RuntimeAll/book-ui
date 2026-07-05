<script setup lang="ts">
/**
 * PRD-C-213 备课包页（/desk/prep）—— FP23 三段构建器 + FP20' 肖像速览 + FP24 上次课回收。
 *
 * 入口态：无 query → getPrepTodo(14) 待备课次列表，点选进构建器；?lessonId= / ?sessionId= 直开。
 * 构建器：getPrepPack 载入已有包 / 无包则从骨架生成；段可编辑（名/style/rules/note）+ 装题 + 排序；
 *         整包 render 出卷（段无题 BE 400 原样弹）；三段都有题才允许「标记已备好」（markReady 双态联动 BE 做）。
 * 🔴 id 全 string；v1 无解析卷（界面不出现任何解析/答案产物入口）；BE 未起优雅空态。
 */
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  getPrepPack,
  createPrepPack,
  updatePrepPackSegs,
  renderPrepPack,
  getPrepTodo,
  getTarget,
  pageSessions,
  getReview,
  artifactUrl,
  SESSION_TYPE_LABEL,
  PREP_STATUS_LABEL,
  PACK_STATUS_LABEL,
  TARGET_TYPE_LABEL,
  type PrepTodoVO,
  type PackSeg,
  type PackArtifact,
  type PackStatus,
  type ProfileJson,
  type ReviewVO,
  type SessionVO,
} from '@/api/teacher/schedule'
import { questionListByIds } from '@/api/question/index'
import {
  segsFromTemplate,
  metaFromDetail,
  type SegQMeta,
} from './helpers'
import { shortDate, weekdayCn, timeRange, relativeDay, prepStatusPill } from '../targets/helpers'
import PrepSegCard from './components/PrepSegCard.vue'
import QuestionPickerDialog from './components/QuestionPickerDialog.vue'
import PortraitGlanceCard from './components/PortraitGlanceCard.vue'
import LastReviewCard from './components/LastReviewCard.vue'

const route = useRoute()
const router = useRouter()

// ── 上下文（来自 query）───────────────────────────────────────────────────────
const packLessonId = ref('')   // 包 key（lesson 级）
const packSessionId = ref('')  // 包 key（session 级，散课）
const ctxSessionId = ref('')   // 实际场次 id（肖像 / 回收 上下文）
const ctxTargetId = ref('')

const mode = computed<'select' | 'builder'>(() =>
  packLessonId.value || packSessionId.value ? 'builder' : 'select',
)

function readQuery() {
  packLessonId.value = (route.query.lessonId as string) || ''
  packSessionId.value = (route.query.sessionId as string) || ''
  ctxSessionId.value = (route.query.sessionId as string) || ''
  ctxTargetId.value = (route.query.targetId as string) || ''
}

// ── 入口态：待备课次列表 ──────────────────────────────────────────────────────
const todoLoading = ref(false)
const todoList = ref<PrepTodoVO[]>([])

async function loadTodo() {
  todoLoading.value = true
  try {
    const res = await getPrepTodo(14)
    todoList.value = res ?? []
  } catch {
    todoList.value = []
  } finally {
    todoLoading.value = false
  }
}

function enterTodo(t: PrepTodoVO) {
  const query: Record<string, string> = { sessionId: String(t.id) }
  if (t.planLessonId) query.lessonId = String(t.planLessonId)
  if (t.targetId) query.targetId = String(t.targetId)
  router.replace({ name: 'PrepPack', query })
}

function backToList() {
  router.replace({ name: 'PrepPack', query: {} })
}

// ── 构建器状态 ────────────────────────────────────────────────────────────────
const builderLoading = ref(false)
const packId = ref<string | null>(null)
const packStatus = ref<PackStatus>('0')
const segs = ref<PackSeg[]>([])
const artifacts = ref<PackArtifact[]>([])
const qMeta = ref<Map<string, SegQMeta>>(new Map())
const dirty = ref(false)
const saving = ref(false)
const rendering = ref(false)
let initToken = 0

const ctxTitle = ref('')
const ctxSub = ref('')

const allSegsHaveQuestions = computed(
  () => segs.value.length > 0 && segs.value.every((s) => (s.question_ids?.length ?? 0) > 0),
)

const packKey = computed(() =>
  packLessonId.value ? { lessonId: packLessonId.value } : { sessionId: packSessionId.value },
)

async function initBuilder() {
  const token = ++initToken
  builderLoading.value = true
  packId.value = null
  packStatus.value = '0'
  segs.value = []
  artifacts.value = []
  qMeta.value = new Map()
  dirty.value = false
  ctxTitle.value = ''
  ctxSub.value = ''

  // 1) 载入 / 生成包骨架
  let loaded: Awaited<ReturnType<typeof getPrepPack>> | null = null
  try {
    loaded = await getPrepPack(packKey.value)
  } catch {
    loaded = null
  }
  if (token !== initToken) return

  if (loaded && loaded.id) {
    packId.value = loaded.id
    packStatus.value = loaded.status ?? '0'
    segs.value = (loaded.segs ?? []).map(cloneSeg)
    artifacts.value = loaded.artifacts ?? []
    await hydrateMeta(token)
  } else {
    // 无包：从骨架生成（🔴 仅 lessonId 时拿不到课次 seg_template（无 planId 无法 getPlan）→ 用默认三段骨架，可编辑）
    segs.value = segsFromTemplate(undefined)
  }
  if (token !== initToken) return
  builderLoading.value = false

  // 2) 上下文（肖像 / 回收）—— 非阻塞
  resolveContext(token)
}

function cloneSeg(s: PackSeg): PackSeg {
  return {
    name: s.name ?? '',
    style: s.style ?? '',
    question_ids: [...(s.question_ids ?? [])].map(String),
    rules: s.rules ?? '',
    note: s.note ?? '',
  }
}

// 批量补齐段内题目摘要
async function hydrateMeta(token: number) {
  const ids = Array.from(new Set(segs.value.flatMap((s) => s.question_ids ?? []).map(String)))
  if (!ids.length) return
  try {
    const details = await questionListByIds(ids)
    if (token !== initToken) return
    const map = new Map(qMeta.value)
    ;(details ?? []).forEach((d) => map.set(String(d.id), metaFromDetail(d)))
    qMeta.value = map
  } catch {
    /* 拿不到摘要不致命：段卡回落显 #id */
  }
}

// ── 上下文解析（targetId / 肖像 / 回收）────────────────────────────────────────
const portrait = ref<ProfileJson | null>(null)
const portraitKind = ref('学生')
const portraitLoading = ref(false)
const lastReview = ref<ReviewVO | null>(null)
const lastReviewDate = ref('')
const reviewLoading = ref(false)
const noSession = ref(false)

async function resolveContext(token: number) {
  portrait.value = null
  lastReview.value = null
  lastReviewDate.value = ''
  noSession.value = false

  // targetId：优先 query；否则由场次反查（best-effort）
  let targetId = ctxTargetId.value
  if (!targetId && ctxSessionId.value) {
    try {
      const res = await pageSessions({ pageNum: 1, pageSize: 200 })
      const hit = (res?.rows ?? []).find((s) => String(s.id) === String(ctxSessionId.value))
      if (hit) {
        targetId = String(hit.targetId)
        ctxTargetId.value = targetId
        fillCtxFromSession(hit)
      }
    } catch {
      /* 反查失败 → 侧卡空态 */
    }
  }
  if (token !== initToken) return
  if (!targetId) return // 仅 lessonId 深链无对象上下文 → 侧卡优雅空

  // 肖像
  portraitLoading.value = true
  try {
    const t = await getTarget(targetId)
    if (token === initToken) {
      portrait.value = t?.profileJson ?? null
      portraitKind.value = t ? TARGET_TYPE_LABEL[t.targetType] || '学生' : '学生'
      if (!ctxTitle.value && t?.name) ctxSub.value = t.name
    }
  } catch {
    /* 空态 */
  } finally {
    if (token === initToken) portraitLoading.value = false
  }

  // 上次课回收：该对象最近一个「已上」场次
  reviewLoading.value = true
  try {
    const res = await pageSessions({ targetId, status: '1', pageNum: 1, pageSize: 50 })
    const done = (res?.rows ?? [])
      .slice()
      .sort((a, b) => (b.sessionDate || '').localeCompare(a.sessionDate || ''))
    const last = done.find((s) => String(s.id) !== String(ctxSessionId.value)) || done[0]
    if (token !== initToken) return
    if (!last) {
      noSession.value = true
    } else {
      lastReviewDate.value = last.sessionDate || ''
      try {
        const rv = await getReview(String(last.id))
        if (token === initToken) lastReview.value = rv ?? null
      } catch {
        if (token === initToken) lastReview.value = null
      }
    }
  } catch {
    /* 空态 */
  } finally {
    if (token === initToken) reviewLoading.value = false
  }
}

function fillCtxFromSession(s: SessionVO) {
  ctxTitle.value = s.externalTitle || ctxTitle.value
  const parts: string[] = []
  if (s.sessionDate) parts.push(`${shortDate(s.sessionDate)} ${weekdayCn(s.sessionDate)}`)
  const tr = timeRange(s.startTime, s.endTime)
  if (tr && tr !== '—') parts.push(tr)
  if (s.sessionType) parts.push(SESSION_TYPE_LABEL[s.sessionType])
  ctxSub.value = parts.join(' · ')
}

// ── 保存 / 渲染 ───────────────────────────────────────────────────────────────
function markDirty() {
  dirty.value = true
}

async function ensureSaved(): Promise<boolean> {
  if (packId.value && !dirty.value) return true
  saving.value = true
  try {
    if (!packId.value) {
      const res = await createPrepPack({ ...packKey.value, segs: segs.value })
      packId.value = res?.id ?? null
    } else {
      await updatePrepPackSegs(packId.value, segs.value)
    }
    dirty.value = false
    return !!packId.value
  } catch {
    return false // 拦截器已弹错
  } finally {
    saving.value = false
  }
}

async function saveDraft() {
  const ok = await ensureSaved()
  if (ok) ElMessage.success('已保存草稿')
}

async function doRender(markReady: boolean) {
  if (markReady && !allSegsHaveQuestions.value) {
    ElMessage.warning('三段均需装题后才能标记已备好')
    return
  }
  const ok = await ensureSaved()
  if (!ok || !packId.value) return
  rendering.value = true
  try {
    const res = await renderPrepPack(packId.value, { markReady })
    artifacts.value = res?.artifacts ?? []
    ElMessage.success(markReady ? '已生成并标记已备好' : '上课卷已生成')
    // 刷新包状态（双态联动由 BE 落库，前端重拉显示）
    await refreshPack()
  } catch (e) {
    // 段无题等业务错误：HTTP-4xx 路径拦截器只弹泛化文案 → 这里把 BE 原始 message 兜出来
    const be = (e as { response?: { data?: { message?: string; msg?: string } } })?.response?.data
    const msg = be?.message || be?.msg
    if (msg) ElMessage.error(msg)
  } finally {
    rendering.value = false
  }
}

async function refreshPack() {
  if (!packId.value && !packLessonId.value && !packSessionId.value) return
  try {
    const res = await getPrepPack(packKey.value)
    if (res && res.id) {
      packId.value = res.id
      packStatus.value = res.status ?? packStatus.value
      artifacts.value = res.artifacts ?? artifacts.value
    }
  } catch {
    /* 保留现状 */
  }
}

// ── 段内题目操作 ──────────────────────────────────────────────────────────────
const pickerVisible = ref(false)
const pickerSegIndex = ref(0)

function openPicker(index: number) {
  pickerSegIndex.value = index
  pickerVisible.value = true
}

function onPick(items: SegQMeta[]) {
  const seg = segs.value[pickerSegIndex.value]
  if (!seg) return
  const map = new Map(qMeta.value)
  const exist = new Set(seg.question_ids.map(String))
  items.forEach((it) => {
    map.set(it.id, it)
    if (!exist.has(it.id)) {
      seg.question_ids.push(it.id)
      exist.add(it.id)
    }
  })
  qMeta.value = map
  markDirty()
}

function removeQuestion(index: number, id: string) {
  const seg = segs.value[index]
  if (!seg) return
  seg.question_ids = seg.question_ids.filter((x) => String(x) !== String(id))
  markDirty()
}

function moveQuestion(index: number, id: string, dir: -1 | 1) {
  const seg = segs.value[index]
  if (!seg) return
  const arr = seg.question_ids
  const i = arr.findIndex((x) => String(x) === String(id))
  const j = i + dir
  if (i < 0 || j < 0 || j >= arr.length) return
  ;[arr[i], arr[j]] = [arr[j], arr[i]]
  markDirty()
}

function aiVariant() {
  ElMessage.info('AI 变式：交由 LLM 会话代办（H6 占位，本页暂不实现）')
}

const excludeForPicker = computed<string[]>(() =>
  (segs.value[pickerSegIndex.value]?.question_ids ?? []).map(String),
)

const statusTone = computed(() =>
  packStatus.value === '2' ? 'ok' : packStatus.value === '1' ? 'mid' : 'mute',
)

// ── 生命周期 ──────────────────────────────────────────────────────────────────
watch(
  () => [route.query.lessonId, route.query.sessionId, route.query.targetId],
  () => {
    readQuery()
    if (mode.value === 'builder') initBuilder()
    else if (todoList.value.length === 0) loadTodo()
  },
)

onMounted(() => {
  readQuery()
  if (mode.value === 'builder') initBuilder()
  else loadTodo()
})

// 入口列表辅助
function todoWhen(t: PrepTodoVO): string {
  const rel = relativeDay(t.sessionDate)
  const d = shortDate(t.sessionDate)
  return `${d} ${rel} ${timeRange(t.startTime, t.endTime)}`.trim()
}
</script>

<template>
  <div class="c213-prep">
    <!-- ══════════ 入口态：待备课次列表 ══════════ -->
    <template v-if="mode === 'select'">
      <div class="vhead">
        <div>
          <h1 class="ph-h1">备课包</h1>
          <p class="ph-sub">选择细备窗口（未来 14 天）内的待备课次，进入三段构建器装题出卷</p>
        </div>
      </div>

      <div v-loading="todoLoading" class="todo-wrap">
        <el-empty
          v-if="!todoLoading && todoList.length === 0"
          description="窗口内暂无待备课次 · 可从「课程计划」课次或「排课总览」进入备课"
          :image-size="90"
        />
        <div v-else class="todo-list">
          <div v-for="t in todoList" :key="t.id" class="todo-row" @click="enterTodo(t)">
            <div class="tr-when">
              <b>{{ shortDate(t.sessionDate) }}</b>
              <span>{{ relativeDay(t.sessionDate) }} · {{ timeRange(t.startTime, t.endTime) }}</span>
            </div>
            <div class="tr-main">
              <div class="tr-title">
                {{ t.targetName || '（对象）' }}
                <span class="tr-lesson">{{ t.lessonTitle || SESSION_TYPE_LABEL[t.sessionType] }}</span>
              </div>
              <div class="tr-meta">{{ todoWhen(t) }}</div>
            </div>
            <div class="tr-right">
              <span class="pill flat" :class="prepStatusPill(t.prepStatus).tone">
                {{ PREP_STATUS_LABEL[t.prepStatus] }}
              </span>
              <span class="tr-go">进入备课 ›</span>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- ══════════ 构建器 ══════════ -->
    <template v-else>
      <div class="vhead builder-head">
        <div>
          <div class="eyebrow">
            <el-button link size="small" class="back-btn" @click="backToList">‹ 选课次</el-button>
            <span v-if="ctxSub">备课包 · {{ ctxSub }}</span>
            <span v-else>备课包</span>
          </div>
          <h1 class="ph-h1">{{ ctxTitle || '本次课备课包' }}</h1>
          <p class="ph-sub">
            <span class="pill flat" :class="statusTone">{{ PACK_STATUS_LABEL[packStatus] }}</span>
            三段装题并生成上课卷后可标「已备好」 ·
            <span class="v1-note">v1 仅出题目卷（无解析卷）</span>
          </p>
        </div>
        <span class="spacer"></span>
        <el-button :loading="saving" @click="saveDraft">保存草稿</el-button>
        <el-button
          :loading="rendering"
          :disabled="!allSegsHaveQuestions"
          @click="doRender(false)"
        >
          生成上课卷
        </el-button>
        <el-button
          type="primary"
          :loading="rendering"
          :disabled="!allSegsHaveQuestions"
          @click="doRender(true)"
        >
          标记已备好
        </el-button>
      </div>

      <div v-if="!allSegsHaveQuestions" class="hint-bar">
        每段至少装 1 题才能生成整卷（BE 整单校验，段无题不出半卷）；当前可先「保存草稿」。
      </div>

      <div v-loading="builderLoading" class="prep-grid">
        <!-- 左：三段构建器 -->
        <div class="seg-col">
          <el-empty v-if="!builderLoading && segs.length === 0" description="无段骨架" :image-size="70" />
          <PrepSegCard
            v-for="(seg, i) in segs"
            :key="i"
            :seg="seg"
            :index="i"
            :q-meta="qMeta"
            @dirty="markDirty"
            @add-question="openPicker"
            @remove-question="removeQuestion"
            @move-question="moveQuestion"
            @ai-variant="aiVariant"
          />

          <!-- 产物列表（render 后）-->
          <div v-if="artifacts.length" class="artifacts card">
            <h2 class="gh"><span class="tick"></span>本次课产物</h2>
            <ul class="art-list">
              <li v-for="(a, i) in artifacts" :key="i">
                <span class="art-seg">{{ a.seg }}</span>
                <span class="art-pages">{{ a.pages }} 页</span>
                <span class="spacer"></span>
                <a :href="a.url || artifactUrl(a.file)" target="_blank" rel="noopener" class="art-link">预览</a>
                <a :href="a.url || artifactUrl(a.file)" :download="a.seg" class="art-link">下载</a>
              </li>
            </ul>
          </div>
        </div>

        <!-- 右：侧卡 -->
        <aside class="rail">
          <PortraitGlanceCard
            :profile="portrait"
            :kind-label="portraitKind"
            :loading="portraitLoading"
            :segs="segs"
          />
          <LastReviewCard
            :review="lastReview"
            :session-date="lastReviewDate"
            :loading="reviewLoading"
            :no-session="noSession"
          />
        </aside>
      </div>
    </template>

    <!-- 装题弹窗 -->
    <QuestionPickerDialog
      v-model:visible="pickerVisible"
      :seg-name="segs[pickerSegIndex]?.name"
      :exclude-ids="excludeForPicker"
      @pick="onPick"
    />
  </div>
</template>

<style scoped>
.c213-prep { color: var(--bk-ink); }

.vhead { display: flex; align-items: flex-end; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.vhead .spacer { flex: 1; }
.ph-h1 { font-size: 19px; font-weight: 800; margin: 0; }
.ph-sub { color: #5f716d; font-size: 13px; margin: 6px 0 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.eyebrow { font-size: 12px; letter-spacing: .04em; color: #8ba09a; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.back-btn { padding: 0; height: auto; }
.v1-note { color: #8ba09a; }

/* 入口列表 */
.todo-wrap { min-height: 120px; }
.todo-list { display: flex; flex-direction: column; gap: 10px; }
.todo-row {
  display: flex; align-items: center; gap: 14px; padding: 13px 16px;
  background: #fff; border: 1px solid var(--bk-line); border-radius: 12px; cursor: pointer;
  transition: border-color .15s, box-shadow .15s;
}
.todo-row:hover { border-color: var(--bk-teal); box-shadow: 0 3px 12px rgba(15,118,110,.09); }
.tr-when { width: 130px; flex: none; }
.tr-when b { font-size: 14px; font-variant-numeric: tabular-nums; }
.tr-when span { display: block; font-size: 11.5px; color: #8ba09a; margin-top: 2px; }
.tr-main { flex: 1; min-width: 0; }
.tr-title { font-size: 14px; font-weight: 700; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tr-lesson { font-size: 12.5px; color: var(--bk-teal-deep); font-weight: 600; }
.tr-meta { font-size: 11.5px; color: #8ba09a; margin-top: 3px; }
.tr-right { flex: none; display: flex; align-items: center; gap: 12px; }
.tr-go { font-size: 12.5px; color: var(--bk-teal); font-weight: 600; }

/* pill */
.pill { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600; border-radius: 99px; padding: 1px 9px; line-height: 18px; white-space: nowrap; }
.pill::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.pill.flat::before { display: none; }
.pill.ok { color: var(--bk-teal-deep); background: var(--bk-teal-soft); }
.pill.mid { color: #b45309; background: #fdf3e7; }
.pill.todo { color: #ba3a2a; background: #fbeeec; }
.pill.mute { color: #7d8f8b; background: #eef1f0; }

/* 构建器 */
.builder-head { align-items: flex-start; }
.hint-bar {
  margin-bottom: 14px; padding: 9px 14px; border-radius: 10px; background: #fdf3e7;
  border: 1px solid #f0dcc0; font-size: 12.5px; color: #b45309; line-height: 1.6;
}
.prep-grid { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 16px; align-items: start; }
@media (max-width: 1100px) { .prep-grid { grid-template-columns: 1fr; } }
.seg-col { min-width: 0; }
.rail { display: flex; flex-direction: column; gap: 14px; }

.artifacts { background: #fff; border: 1px solid var(--bk-line); border-radius: 12px; padding: 15px 16px; margin-top: 4px; }
.gh { font-size: 13.5px; font-weight: 800; display: flex; align-items: center; gap: 8px; margin: 0 0 10px; }
.tick { width: 4px; height: 14px; border-radius: 2px; background: var(--bk-teal); flex: none; }
.art-list { list-style: none; margin: 0; padding: 0; }
.art-list li { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-top: 1px solid #eef3f1; font-size: 12.5px; }
.art-list li:first-child { border-top: none; }
.art-seg { font-weight: 600; }
.art-pages { font-size: 11.5px; color: #8ba09a; }
.art-list .spacer { flex: 1; }
.art-link { font-size: 12.5px; color: var(--bk-teal-deep); text-decoration: none; font-weight: 600; }
.art-link:hover { text-decoration: underline; }
</style>
