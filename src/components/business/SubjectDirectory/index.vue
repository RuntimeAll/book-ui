<script setup lang="ts">
/**
 * 题库目录 · 分层收放筛选（学科 → 学段 → 版本 → 年级 → 册 → 章节）。
 *
 * 替代原「教材 dropdown + 一长条扁平树」。数据驱动：读 lazyTree 根节点的结构化字段码
 * （subject/stage/grade/volume/edition，2026-07-01 字典化）+ useDictStore 翻标签，按真实库存
 * 建筛选 + 精确置灰；选中一本教材后用它的 children 当章节树。不再解析节点名。
 *
 * - 题库页：autoSelect=true，默认落到一本教材（缓存上次 > 首本）并 emit 过滤。
 * - 我的题库页：autoSelect=false，默认「全部」不过滤（老师的题跨章节，默认选首节点会几乎空）。
 */
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { Search, ArrowDown } from '@element-plus/icons-vue'
import { lazyTree, type SubjectNode } from '@/api/question'
import {
  useDictStore,
  DICT_EDU_SUBJECT, DICT_EDU_STAGE, DICT_EDU_VOLUME, DICT_EDU_EDITION,
} from '@/store/dict'

const dict = useDictStore()

const props = withDefaults(defineProps<{
  /** 个人题库目录：lazyTree 带 mine=true（过滤 mine_visible） */
  mine?: boolean
  /** 默认是否落到一本教材并过滤（题库=true / 我的题库=false 默认全部） */
  autoSelect?: boolean
  /** 讲义模式装饰（PRD-C-207）：课时 subjectId → {badge?}；命中则树上显徽标（如"1版"）。题库页不传=不装饰。 */
  lessonMeta?: Record<string, { badge?: string }>
  /** 讲义模式：未挂讲义的课时(L4=12位id)置灰，看得到全书结构+哪些还没做（D4） */
  dimUncovered?: boolean
}>(), { mine: false, autoSelect: true, dimUncovered: false })

/** 选中节点 id（教材根 or 章节）；null = 全部（不按章节过滤） */
const emit = defineEmits<{ (e: 'select', subjectId: string | null): void }>()

// ── 教材维度（2026-07-01：读 BE 结构化字段码 + useDictStore 翻标签，不再解析节点名）──
// 内部 key 仍用中文标签串（学段/版本/册），来源=字典 SSOT；下游派生/模板不变。
interface Textbook { subject: string; stage: string; edition: string; editionYear: number; grade: number; volume: string; node: SubjectNode }
const GRADE_LABEL: Record<number, string> = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八', 9: '九', 10: '高一', 11: '高二', 12: '高三' }
const STAGE_GRADES: Record<string, number[]> = { 小学: [1, 2, 3, 4, 5, 6], 初中: [7, 8, 9], 高中: [10, 11, 12] }
const ALL_STAGES = ['小学', '初中', '高中']

/** biz_subject level=1 教材根 → Textbook（字段码经字典翻标签）。非教材根（subject 空）返 null。 */
function readTextbook(node: SubjectNode): Textbook | null {
  if (node.subject == null || node.grade == null) return null
  return {
    subject: dict.label(DICT_EDU_SUBJECT, node.subject),         // 数学/科学
    stage: dict.label(DICT_EDU_STAGE, node.stage),               // 小学/初中/高中
    edition: dict.label(DICT_EDU_EDITION, node.edition),         // 浙教/人教（不含年份）
    editionYear: node.editionYear ?? 0,
    grade: node.grade,
    volume: node.volume === 2 ? '下' : '上',                     // 册码 1上/2下 → 兼容下游 ['上','下']
    node,
  }
}

// ── 数据 ─────────────────────────────────────────────────────
const loading = ref(false)
const textbooks = ref<Textbook[]>([])
const unparsed = ref<SubjectNode[]>([]) // 解析不了的根（兜底，列在底部）

// ── 选择状态 ─────────────────────────────────────────────────
type Sel = { subject: string; stage: string; edition: string; grade: number; volume: string }
const sel = ref<Sel | null>(null)
/** 我的题库默认态：面板有选择但不过滤（显示全部我的题） */
const atAll = ref(false)
const pickerOpen = ref(true)

// ── 维度派生（按真实库存）──────────────────────────────────
const uniq = <T,>(arr: T[]) => [...new Set(arr)]
const subjects = computed(() => uniq(textbooks.value.map((t) => t.subject)))
function stagesOf(subject: string) { return uniq(textbooks.value.filter((t) => t.subject === subject).map((t) => t.stage)) }
function editionsOf(subject: string, stage: string) { return uniq(textbooks.value.filter((t) => t.subject === subject && t.stage === stage).map((t) => t.edition)) }
function gradesAvail(subject: string, stage: string, edition: string) { return uniq(textbooks.value.filter((t) => t.subject === subject && t.stage === stage && t.edition === edition).map((t) => t.grade)) }
function volsOf(s: Sel) { return uniq(textbooks.value.filter((t) => t.subject === s.subject && t.stage === s.stage && t.edition === s.edition && t.grade === s.grade).map((t) => t.volume)) }
function resolve(s: Sel | null): Textbook | null {
  if (!s) return null
  const matches = textbooks.value.filter((t) => t.subject === s.subject && t.stage === s.stage && t.edition === s.edition && t.grade === s.grade && t.volume === s.volume)
  if (!matches.length) return null
  // 同版本同年级同册可能有多个年份（浙教2024/2012）→ 默认取最新年份
  return matches.reduce((a, b) => (b.editionYear > a.editionYear ? b : a))
}

const curStages = computed(() => (sel.value ? stagesOf(sel.value.subject) : []))
const curEditions = computed(() => (sel.value ? editionsOf(sel.value.subject, sel.value.stage) : []))
const curGrades = computed(() => (sel.value ? gradesAvail(sel.value.subject, sel.value.stage, sel.value.edition) : []))
const curVols = computed(() => (sel.value ? volsOf(sel.value) : []))
const currentRoot = computed(() => resolve(sel.value))
const chapters = computed<SubjectNode[]>(() => currentRoot.value?.node.children ?? [])

// ── 缓存（localStorage 记住上次选择）──────────────────────
// 题库 / 我的题库 各自独立缓存（不互相污染）；记住 atAll + 具体选择，刷新后原样恢复。
interface CacheState { atAll: boolean; sel: Sel | null }
const CACHE_KEY = 'book-ui:subject-dir-sel' + (props.mine ? ':mine' : '')
function readCache(): CacheState | null { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null') } catch { return null } }
function persist() { try { localStorage.setItem(CACHE_KEY, JSON.stringify({ atAll: atAll.value, sel: sel.value })) } catch { /* 隐私模式忽略 */ } }
function firstAvailable(): Sel | null {
  const t = textbooks.value[0]
  return t ? { subject: t.subject, stage: t.stage, edition: t.edition, grade: t.grade, volume: t.volume } : null
}

// ── 归一化：把 sel 落到当前可用值（换学科/学段/版本后兜底）──
function normalize() {
  if (!sel.value) return
  const s = sel.value
  if (!stagesOf(s.subject).includes(s.stage)) s.stage = stagesOf(s.subject)[0]
  const eds = editionsOf(s.subject, s.stage)
  if (!eds.includes(s.edition)) s.edition = eds[0]
  const gs = gradesAvail(s.subject, s.stage, s.edition)
  if (!gs.includes(s.grade)) s.grade = gs[0]
  const vs = volsOf(s)
  if (!vs.includes(s.volume)) s.volume = vs[0]
}

/** 应用当前选择：emit 教材根 id + 缓存（atAll 时 emit null） */
function applySelection() {
  persist()
  if (atAll.value) { emit('select', null); return }
  const root = currentRoot.value
  if (root) emit('select', root.node.id)
}

// ── 交互 ─────────────────────────────────────────────────────
function pickSubject(subject: string) {
  if (!sel.value) sel.value = firstAvailable()
  if (!sel.value) return
  sel.value.subject = subject
  normalize(); atAll.value = false; applySelection()
}
function pickStage(stage: string) {
  if (!sel.value || !stagesOf(sel.value.subject).includes(stage)) return
  sel.value.stage = stage
  normalize(); atAll.value = false; applySelection()
}
function pickEdition(edition: string) {
  if (!sel.value) return
  sel.value.edition = edition
  normalize(); atAll.value = false; applySelection()
}
function pickGrade(grade: number) {
  if (!sel.value || !curGrades.value.includes(grade)) return
  sel.value.grade = grade
  const vs = volsOf(sel.value)
  if (!vs.includes(sel.value.volume)) sel.value.volume = vs[0]
  atAll.value = false
  applySelection()
  pickerOpen.value = false // 选完年级自动收起，章节树占满
}
function pickVolume(volume: string) {
  if (!sel.value || !curVols.value.includes(volume)) return
  sel.value.volume = volume
  atAll.value = false; applySelection()
}
function clearToAll() { atAll.value = true; pickerOpen.value = false; persist(); emit('select', null) }
function togglePicker() { pickerOpen.value = !pickerOpen.value }

// ── 章节树（关键字筛选 + 点击）──────────────────────────────
const treeRef = ref()
const keyword = ref('')
function filterNode(value: string, data: SubjectNode) { return !value || (data.title ?? '').includes(value) }
watch(keyword, (v) => treeRef.value?.filter(v))
function onChapterClick(data: SubjectNode) { atAll.value = false; persist(); emit('select', data.id) }

// ── 展示文案 ─────────────────────────────────────────────────
const crumbMain = computed(() => {
  if (atAll.value || !sel.value) return '全部教材'
  const s = sel.value
  return `${s.subject}·${s.stage}·${GRADE_LABEL[s.grade]}${s.grade <= 9 ? '年级' : ''}${s.volume}册`
})
const crumbEd = computed(() => (atAll.value || !sel.value ? '' : sel.value.edition))
const isSci = computed(() => sel.value?.subject === '科学')

// ── 初始化 ───────────────────────────────────────────────────
onMounted(async () => {
  loading.value = true
  try {
    // 先备好字典（学科/学段/版本/册 label），readTextbook 才能把码翻成标签作内部 key
    await Promise.all([
      dict.load(DICT_EDU_SUBJECT), dict.load(DICT_EDU_STAGE),
      dict.load(DICT_EDU_VOLUME), dict.load(DICT_EDU_EDITION),
    ])
    const result = await lazyTree(0, props.mine)
    const roots: SubjectNode[] = Array.isArray(result) ? result : result ? [result as unknown as SubjectNode] : []
    const tb: Textbook[] = []; const up: SubjectNode[] = []
    // 保持 lazyTree 的 biz_subject.sort 原序（数学在前），不二次排序——默认教材与原页面一致
    roots.forEach((r) => { const p = readTextbook(r); if (p) tb.push(p); else up.push(r) })
    textbooks.value = tb; unparsed.value = up

    // 恢复缓存：sel 落到可用教材（取最新年份），atAll 沿用上次；无缓存则按页面默认
    const cached = readCache()
    sel.value = cached?.sel && resolve(cached.sel) ? cached.sel : firstAvailable()
    atAll.value = cached ? !!cached.atAll : !props.autoSelect // 无缓存：题库默认落教材 / 我的题库默认全部
    pickerOpen.value = false                                   // 进入始终收起（选好年级再展开）

    // SubjectDirectory 统一驱动首屏 fetch（父组件不再自管 onMounted fetch）
    if (atAll.value || !sel.value) emit('select', null)
    else applySelection()
  } catch (e) {
    console.warn('[SubjectDirectory] lazyTree failed', e)
    emit('select', null) // 兜底：树挂了也让父组件拉全量
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="dir-cw">
    <!-- 卡头 -->
    <div class="cw-head">
      <div class="t"><span class="bar" /><b>题库目录</b></div>
      <span class="n">{{ textbooks.length }} 本</span>
    </div>

    <div v-loading="loading" class="cw-body">
      <!-- 当前选择 / 收放开关 -->
      <div class="crumb" :class="{ open: pickerOpen }" @click="togglePicker">
        <div class="ico" :class="isSci ? 'sci' : 'math'">{{ atAll || !sel ? '全' : GRADE_LABEL[sel.grade] }}</div>
        <div class="txt">
          <div class="l1">
            <span class="main">{{ crumbMain }}</span>
            <span v-if="crumbEd" class="ed">{{ crumbEd }}</span>
          </div>
          <div class="l2">{{ pickerOpen ? '选好年级自动收起 ▴' : '点此展开教材选择 ▾' }}</div>
        </div>
        <el-icon class="chev"><ArrowDown /></el-icon>
      </div>

      <!-- 收放筛选 -->
      <div class="picker" :class="{ collapsed: !pickerOpen }">
        <div class="picker-in">
          <div class="grp">
            <div class="grp-lab">学科</div>
            <div class="seg" :class="{ sci: isSci }">
              <button v-for="s in subjects" :key="s" :class="{ on: !atAll && sel?.subject === s }" @click="pickSubject(s)">{{ s }}</button>
            </div>
          </div>
          <div class="grp">
            <div class="grp-lab">学段</div>
            <div class="seg" :class="{ sci: isSci }">
              <button v-for="st in ALL_STAGES" :key="st" :disabled="!curStages.includes(st)" :class="{ on: !atAll && sel?.stage === st }" @click="pickStage(st)">{{ st }}</button>
            </div>
          </div>
          <div class="grp">
            <div class="grp-lab">版本</div>
            <div class="chips">
              <div v-for="ed in curEditions" :key="ed" class="chip" :class="{ on: !atAll && sel?.edition === ed }" @click="pickEdition(ed)">{{ ed }}</div>
              <span v-if="!curEditions.length" class="muted">无版本</span>
            </div>
          </div>
          <div class="grp">
            <div class="grp-lab">年级（点选即定位）</div>
            <div class="grades">
              <div
                v-for="g in (sel ? STAGE_GRADES[sel.stage] : [])"
                :key="g"
                class="grade"
                :class="{ on: !atAll && sel?.grade === g, dim: !curGrades.includes(g) }"
                @click="pickGrade(g)"
              >
                <div class="num">{{ GRADE_LABEL[g] }}</div>
                <div class="cn">{{ GRADE_LABEL[g] }}{{ g <= 9 ? '年级' : '' }}</div>
              </div>
            </div>
          </div>
          <div class="grp" style="margin-bottom: 8px">
            <div class="grp-lab">册</div>
            <div class="seg">
              <button v-for="v in ['上', '下']" :key="v" :disabled="!curVols.includes(v)" :class="{ on: !atAll && sel?.volume === v }" @click="pickVolume(v)">{{ v }}册</button>
            </div>
          </div>
          <!-- 我的题库：可回到「全部」 -->
          <div v-if="!autoSelect" class="all-row">
            <button class="all-btn" :class="{ on: atAll }" @click="clearToAll">全部我的题（不按教材筛选）</button>
          </div>
        </div>
      </div>

      <div class="divln" />

      <!-- 章节 -->
      <div class="chap-head">
        <div class="t">章节目录</div>
        <span class="cnt">{{ chapters.length }} 章</span>
      </div>
      <div class="search">
        <el-input v-model="keyword" placeholder="筛选章节…" clearable size="small">
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
      </div>
      <div class="chap-list">
        <el-tree
          v-if="chapters.length"
          ref="treeRef"
          :data="chapters"
          :props="{ label: 'title', children: 'children' }"
          node-key="id"
          highlight-current
          :expand-on-click-node="false"
          :filter-node-method="filterNode"
          @node-click="onChapterClick"
        >
          <template #default="{ data }">
            <span class="stree-label" :class="{ dim: dimUncovered && data.id && String(data.id).length === 12 && !lessonMeta?.[data.id] }">
              <span class="stree-text">{{ data.title }}</span>
              <span v-if="lessonMeta?.[data.id]?.badge" class="stree-badge">{{ lessonMeta[data.id].badge }}</span>
            </span>
          </template>
        </el-tree>
        <div v-else class="chap-empty">
          {{ atAll ? '展开上方选择教材，可按章节筛选' : '该教材暂无章节' }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dir-cw { background: #fff; border: 1px solid #eef1f1; border-radius: 10px; box-shadow: 0 1px 3px rgba(22, 36, 42, .05); height: 100%; display: flex; flex-direction: column; overflow: hidden; }
.cw-head { padding: 13px 14px; border-bottom: 1px solid #eef2f2; display: flex; align-items: center; justify-content: space-between; gap: 6px; flex-shrink: 0; }
.cw-head .t { display: flex; align-items: center; gap: 8px; }
.cw-head .bar { width: 3px; height: 15px; border-radius: 2px; background: #7b6cf0; }
.cw-head b { font-size: 14px; font-weight: 700; color: #16242a; }
.cw-head .n { font-size: 10.5px; color: #a8b2b6; }
.cw-body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }

.crumb { margin: 10px 10px 0; padding: 8px 9px; border: 1px solid #e3e9e9; border-radius: 9px; background: #fafdfd; cursor: pointer; display: flex; align-items: center; gap: 7px; transition: .15s; flex-shrink: 0; }
.crumb:hover { border-color: #cfe0e0; background: #f3faf9; }
.crumb .ico { width: 26px; height: 26px; border-radius: 7px; flex-shrink: 0; display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 12.5px; }
.crumb .ico.math { background: linear-gradient(135deg, #2ba3a3, #176e6e); }
.crumb .ico.sci { background: linear-gradient(135deg, #8f86f4, #6357d6); }
.crumb .txt { flex: 1; min-width: 0; }
.crumb .l1 { font-size: 12px; font-weight: 700; color: #16242a; line-height: 1.25; display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.crumb .l1 .main { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.crumb .l2 { font-size: 10px; color: #7c8a90; margin-top: 1px; }
.crumb .ed { font-size: 9.5px; font-weight: 600; padding: 1px 5px; border-radius: 4px; background: #efeefe; color: #7b6cf0; flex-shrink: 0; }
.crumb .chev { color: #a8b2b6; transition: .25s; flex-shrink: 0; font-size: 13px; }
.crumb.open .chev { transform: rotate(180deg); }

.picker { max-height: 460px; overflow: hidden; transition: max-height .3s cubic-bezier(.4, 0, .2, 1); flex-shrink: 0; }
.picker.collapsed { max-height: 0; }
.picker-in { padding: 10px 10px 2px; }
.grp { margin-bottom: 11px; }
.grp-lab { font-size: 10px; font-weight: 700; letter-spacing: 1px; color: #7c8a90; text-transform: uppercase; margin-bottom: 6px; }
.seg { display: flex; background: #eef2f2; border-radius: 8px; padding: 2px; gap: 2px; width: 100%; }
.seg button { flex: 1; border: 0; background: transparent; font-size: 12px; font-weight: 600; color: #536268; padding: 6px 4px; border-radius: 6px; cursor: pointer; transition: .15s; }
.seg button.on { background: #fff; color: #176e6e; box-shadow: 0 1px 3px rgba(22, 36, 42, .05); }
.seg.sci button.on { color: #7b6cf0; }
.seg button:disabled { color: #a8b2b6; cursor: not-allowed; opacity: .45; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font-size: 11.5px; font-weight: 600; color: #536268; background: #fff; border: 1px solid #e3e9e9; padding: 5px 11px; border-radius: 999px; cursor: pointer; transition: .15s; }
.chip:hover { border-color: #2ba3a3; color: #176e6e; }
.chip.on { background: #1e8a8a; border-color: #1e8a8a; color: #fff; }
.muted { font-size: 11px; color: #a8b2b6; }
.grades { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.grade { border: 1px solid #e3e9e9; border-radius: 9px; background: #fff; cursor: pointer; padding: 8px 4px 6px; text-align: center; transition: .15s; position: relative; overflow: hidden; }
.grade .num { font-size: 17px; font-weight: 700; color: #16242a; line-height: 1; }
.grade .cn { font-size: 10px; color: #7c8a90; margin-top: 2px; font-weight: 600; }
.grade:hover { border-color: #2ba3a3; }
.grade.on { border-color: #1e8a8a; background: linear-gradient(180deg, #f0faf9, #fff); }
.grade.on .num { color: #176e6e; }
.grade.on::before { content: ''; position: absolute; inset: 0 0 auto 0; height: 3px; background: #1e8a8a; }
.grade.dim { opacity: .3; pointer-events: none; filter: grayscale(.4); }
.all-row { margin-bottom: 8px; }
.all-btn { width: 100%; border: 1px dashed #d6dede; background: #fafdfd; color: #536268; font-size: 11.5px; font-weight: 600; padding: 7px; border-radius: 8px; cursor: pointer; transition: .15s; }
.all-btn:hover { border-color: #2ba3a3; color: #176e6e; }
.all-btn.on { border-style: solid; border-color: #1e8a8a; color: #176e6e; background: #e6f2f2; }

.divln { height: 1px; background: #eef2f2; margin: 4px 10px 0; flex-shrink: 0; }
.chap-head { padding: 11px 12px 7px; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
.chap-head .t { font-size: 11.5px; font-weight: 700; color: #2c3b42; }
.chap-head .cnt { font-size: 10px; font-weight: 700; color: #176e6e; background: #e6f2f2; padding: 2px 7px; border-radius: 999px; }
.search { margin: 0 10px 6px; flex-shrink: 0; }
.chap-list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 8px 10px; }
.chap-empty { padding: 22px 12px; text-align: center; color: #a8b2b6; font-size: 12px; line-height: 1.6; }

/* 讲义模式：课时徽标 + 未覆盖置灰（题库页不传 lessonMeta/dimUncovered 时无影响） */
.stree-label { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.stree-label.dim { opacity: .42; }
.stree-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stree-badge { flex-shrink: 0; font-size: 9.5px; font-weight: 700; color: #176e6e; background: #e6f2f2; padding: 0 6px; border-radius: 999px; line-height: 15px; }
</style>
